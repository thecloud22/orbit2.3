using System.Globalization;
using Claims.Clock;
using Claims.Common;
using Claims.Domain;
using Claims.Intake;
using Claims.Payment;
using Claims.Store;
using static Claims.Store.LetterRepository;

namespace Claims.Events;

/// <summary>
/// The database work of the short workflow that follows a payment run (<c>event-&lt;outboxEventId&gt;</c>, started by the <c>items_paid</c> outbox
/// event): payment confirmations, the closing letter when the run closed the claim, and the agent notice. The run itself already closed the claim in its
/// own transaction; this only writes to people. Safe to repeat, like <see cref="DecisionEventService"/>.
/// </summary>
public sealed class PaymentEventService(Db db, IClock clock, LetterService letters, LetterRepository letterRows, WorkflowRunRepository runs, HistoryRepository history,
                                        WorkItemRepository workItems, BusinessCalendar calendar)
{
    public sealed record PaidFact(Guid PartyId, string Name, decimal Amount);

    public sealed record Facts(Guid ClaimId, string ClaimNumber, bool Closed, IReadOnlyList<PaidFact> Paid, bool AgentConsent, string? AgentName);

    public async Task<Facts> BeginAsync(Guid claimId, Guid runId, Guid eventId, string workflowId, string runRecordId)
    {
        await runs.BeginAsync(workflowId, runRecordId, "event", "Payment confirmed", claimId,
            "Outbox relay · event " + eventId + " (items paid)", "outbox_event", eventId, clock.UtcNow);
        return await LoadAsync(claimId, runId);
    }

    private async Task<Facts> LoadAsync(Guid claimId, Guid runId)
    {
        var head = await db.QuerySingleAsync("""
            SELECT c.claim_number, c.status, l.agent_consent FROM claims c JOIN life_claim_details l ON l.claim_id = c.id WHERE c.id = @c
            """, new { c = claimId }, r => (Number: r.Text("claim_number"), Status: r.Text("status"), Consent: r.Bool("agent_consent")));
        var paid = await db.QueryAsync("""
            SELECT p.id, p.full_name, sum(pi.amount) AS amount FROM payment_items pi JOIN parties p ON p.id = pi.payee_party_id
            WHERE pi.claim_id = @c AND pi.run_id = @r AND pi.status = 'paid' GROUP BY p.id, p.full_name ORDER BY p.full_name
            """, new { c = claimId, r = runId }, r => new PaidFact(r.Guid("id"), r.Text("full_name"), r.Decimal("amount")));
        var agent = await db.SingleOrDefaultAsync<string>(
            "SELECT p.full_name FROM claim_parties cp JOIN parties p ON p.id = cp.party_id WHERE cp.claim_id = @c AND cp.role = 'agent_of_record' LIMIT 1", new { c = claimId });
        return new Facts(claimId, head.Number, head.Status == "closed", paid, head.Consent, agent);
    }

    /// <summary>PAY-LIFE-01 to each payee paid in the run, once each.</summary>
    public async Task<int> SendConfirmationsAsync(Guid claimId, Guid runId, string workflowId)
    {
        var f = await LoadAsync(claimId, runId);
        foreach (var p in f.Paid)
        {
            await letters.SendOnceAsync(new NewLetter(claimId, "PAY-LIFE-01", "email", p.PartyId, p.Name, "Payment sent · " + LifeIntakeRules.First(p.Name),
                $"{PaymentRules.Usd(p.Amount)} sent today. A 1099-INT for the interest follows in January.", "outbox_event", null, workflowId,
                "run:" + runId + ":paid:" + p.PartyId), p.Name);
        }
        return f.Paid.Count;
    }

    /// <summary>CLS-LIFE-01 when the claim is closed, once per claim. False when the claim is not closed.</summary>
    public async Task<bool> SendClosingLetterAsync(Guid claimId, Guid runId, string workflowId)
    {
        var f = await LoadAsync(claimId, runId);
        if (!f.Closed) return false;
        var payees = await db.QueryAsync("""
            SELECT DISTINCT p.id, p.full_name FROM payment_items pi JOIN parties p ON p.id = pi.payee_party_id WHERE pi.claim_id = @c AND pi.status = 'paid' ORDER BY p.full_name
            """, new { c = claimId }, r => (Id: r.Guid("id"), Name: r.Text("full_name")));
        // One closing letter per CLOSE: the first close keeps the key it always had; a claim that reopened (a returned payment) and closed again gets its own, tied to the
        // run that closed it. A retried activity of the same workflow finds its own letter and sends nothing twice.
        var key = "claim:" + claimId + ":closing";
        if (await letterRows.WorkflowIdOfAsync(key) is { } writtenBy && writtenBy != workflowId) key += ":run:" + runId;
        await letters.SendOnceAsync(new NewLetter(claimId, "CLS-LIFE-01", "letter", null, string.Join(", ", payees.Select(p => p.Name)), "Claim closed",
            "Every benefit line is paid or closed.", "outbox_event", null, workflowId, key), string.Join(", ", payees.Select(p => p.Name)));
        return true;
    }

    public async Task<bool> TellAgentAsync(Guid claimId, Guid runId, string workflowId)
    {
        var f = await LoadAsync(claimId, runId);
        if (!f.AgentConsent || f.AgentName is null) return false;
        await letters.SendOnceAsync(new NewLetter(claimId, "AGT-NOTE-03", "email", null, f.AgentName, f.Closed ? "Agent notification · closed" : "Agent notification · paid",
            f.Closed ? "The claim is paid and closed. Status only." : "Payment was sent; the claim stays open. Status only.", "outbox_event", null, workflowId,
            "run:" + runId + ":agent"), f.AgentName);
        return true;
    }

    public Task CompleteAsync(Guid claimId, Guid runId, IReadOnlyList<RunStep> steps, string workflowId, string runRecordId) => db.InTransactionAsync(async () =>
    {
        var now = clock.UtcNow;
        var f = await LoadAsync(claimId, runId);
        await history.AppendAsync(claimId, now, "communication", $"Payment confirmations sent to {string.Join(" and ", f.Paid.Select(p => LifeIntakeRules.First(p.Name)))}" +
            (f.Closed ? "; closing letter CLS-LIFE-01" : ""), Actor.Workflow(workflowId), null, null, workflowId);
        await runs.FinishAsync(workflowId, runRecordId, "completed", steps,
            [f.Closed ? "Claim is closed (saved by the payment run)" : "Claim stays open", "Letters in Communications", "History"], null, now);
    });

    public Task RecordFailureAsync(Guid claimId, string error, IReadOnlyList<RunStep> steps, string workflowId, string runRecordId) => db.InTransactionAsync(async () =>
    {
        var now = clock.UtcNow;
        await workItems.InsertOnceAsync("workflow-failed:" + workflowId, null, claimId, 1, "Payment confirmation letters failed",
            "Workflow " + workflowId + " gave up: " + error, calendar.LocalDate(now), "You", "communications", "workflow", null);
        await history.AppendAsync(claimId, now, "task", "Payment confirmation letters failed after retries", Actor.Workflow(workflowId), error, null, workflowId);
        await runs.FinishAsync(workflowId, runRecordId, "failed", steps, ["Ops task opened"], error, now);
    });
}
