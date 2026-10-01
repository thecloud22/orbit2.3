using System.Globalization;
using Claims.Clock;
using Claims.Common;
using Claims.Domain;
using Claims.Intake;
using Claims.Store;
using static Claims.Store.LetterRepository;

namespace Claims.Events;

/// <summary>
/// The database work of the short workflow that follows a decision (<c>event-&lt;decisionId&gt;</c>): the approval letters, the agent notice, and the
/// run record. Every method is safe to repeat: letters go through <see cref="LetterService.SendOnceAsync"/> with a dedupe key per letter, and the
/// run record's begin and finish are idempotent, so a retried activity or a workflow started twice sends nothing twice.
/// </summary>
public sealed class DecisionEventService(Db db, IClock clock, LetterService letters, WorkflowRunRepository runs, HistoryRepository history,
                                         WorkItemRepository workItems, BusinessCalendar calendar)
{
    public sealed record PayeeFact(Guid PartyId, string Name, string Packet, decimal Share, decimal Amount);

    public sealed record Facts(Guid ClaimId, string ClaimNumber, string Insured, string PayOn, IReadOnlyList<PayeeFact> Payees, bool RiderExplained,
                               bool AgentConsent, string? AgentName);

    public async Task<Facts> BeginAsync(Guid decisionId, Guid eventId, string workflowId, string runId)
    {
        var claimId = await db.SingleAsync<Guid>("SELECT claim_id FROM decisions WHERE id = @d", new { d = decisionId });
        await runs.BeginAsync(workflowId, runId, "event", "Decision recorded", claimId,
            "Outbox relay · event " + eventId + " (decision saved)", "outbox_event", eventId, clock.UtcNow);
        return await LoadAsync(decisionId);
    }

    private async Task<Facts> LoadAsync(Guid decisionId)
    {
        var head = await db.QuerySingleAsync("""
            SELECT d.claim_id, d.group_id, c.claim_number, ip.full_name AS insured, l.agent_consent
            FROM decisions d JOIN claims c ON c.id = d.claim_id JOIN parties ip ON ip.id = c.insured_party_id JOIN life_claim_details l ON l.claim_id = c.id
            WHERE d.id = @d
            """, new { d = decisionId }, r => (ClaimId: r.Guid("claim_id"), Group: r.Guid("group_id"), Number: r.Text("claim_number"),
                Insured: r.Text("insured"), Consent: r.Bool("agent_consent")));
        var payees = await db.QueryAsync("""
            SELECT p.id, p.full_name, COALESCE(cp.packet_channel, 'portal') AS packet, cp.share_percent, sum(pi.amount) AS amount, min(pi.pay_on) AS pay_on
            FROM payment_items pi
            JOIN decisions d ON d.id = pi.decision_id AND d.group_id = @g
            JOIN parties p ON p.id = pi.payee_party_id
            JOIN claim_parties cp ON cp.claim_id = pi.claim_id AND cp.party_id = p.id AND cp.role = 'beneficiary'
            GROUP BY p.id, p.full_name, cp.packet_channel, cp.share_percent ORDER BY p.full_name
            """, new { g = head.Group },
            r => (Fact: new PayeeFact(r.Guid("id"), r.Text("full_name"), r.Text("packet"), r.Decimal("share_percent"), r.Decimal("amount")), PayOn: r.Date("pay_on")));
        var riderExplained = await db.SingleAsync<bool>("SELECT EXISTS (SELECT 1 FROM decisions WHERE group_id = @g AND outcome = 'closed')", new { g = head.Group });
        var agent = await db.SingleOrDefaultAsync<string>(
            "SELECT p.full_name FROM claim_parties cp JOIN parties p ON p.id = cp.party_id WHERE cp.claim_id = @c AND cp.role = 'agent_of_record' LIMIT 1", new { c = head.ClaimId });
        var payOn = payees.Count > 0 ? payees[0].PayOn.ToString("ddd d MMM", CultureInfo.InvariantCulture) : "";
        return new Facts(head.ClaimId, head.Number, head.Insured, payOn, [.. payees.Select(p => p.Fact)], riderExplained, head.Consent, agent);
    }

    /// <summary>APR-LIFE-01 to each payee, once each. Returns the letters sent.</summary>
    public async Task<int> SendApprovalLettersAsync(Guid decisionId, string workflowId)
    {
        var f = await LoadAsync(decisionId);
        var sent = 0;
        foreach (var p in f.Payees)
        {
            var mail = p.Packet == "mail";
            var first = LifeIntakeRules.First(p.Name);
            await letters.SendOnceAsync(new NewLetter(f.ClaimId, "APR-LIFE-01", mail ? "letter" : "email", p.PartyId, p.Name, "Approval letter · " + first,
                string.Create(CultureInfo.InvariantCulture, $"Approved. {p.Share:0.##}% of the proceeds with interest, paid {f.PayOn}.") +
                (f.RiderExplained ? " Includes why the accidental death rider doesn't pay." : ""),
                "decision", decisionId, workflowId, "decision:" + decisionId + ":approval:" + p.PartyId), p.Name);
            sent++;
        }
        return sent;
    }

    /// <summary>Status-only notice to the agent of record, when the caller consented. False when skipped.</summary>
    public async Task<bool> TellAgentAsync(Guid decisionId, string workflowId)
    {
        var f = await LoadAsync(decisionId);
        if (!f.AgentConsent || f.AgentName is null) return false;
        await letters.SendOnceAsync(new NewLetter(f.ClaimId, "AGT-NOTE-02", "email", null, f.AgentName, "Agent notification · approved",
            "The claim is approved; payment follows. Status only.", "decision", decisionId, workflowId, "decision:" + decisionId + ":agent"), f.AgentName);
        return true;
    }

    /// <summary>One transaction: the letters are in the history and the run record is finished.</summary>
    public Task CompleteAsync(Guid decisionId, IReadOnlyList<RunStep> steps, string workflowId, string runId) => db.InTransactionAsync(async () =>
    {
        var now = clock.UtcNow;
        var f = await LoadAsync(decisionId);
        await history.AppendAsync(f.ClaimId, now, "communication", $"Approval letters sent: APR-LIFE-01 × {f.Payees.Count}", Actor.Workflow(workflowId),
            string.Join(" · ", f.Payees.Select(p => LifeIntakeRules.First(p.Name) + (p.Packet == "mail" ? " by mail" : " in the portal and by email"))), null, workflowId);
        await runs.FinishAsync(workflowId, runId, "completed", steps, ["Letters in Communications", "History"], null, now);
    });

    /// <summary>Retries are exhausted: the run is failed and a person gets a task. The workflow id can be started again once the cause is fixed.</summary>
    public Task RecordFailureAsync(Guid decisionId, string error, IReadOnlyList<RunStep> steps, string workflowId, string runId) => db.InTransactionAsync(async () =>
    {
        var now = clock.UtcNow;
        var f = await LoadAsync(decisionId);
        await workItems.InsertOnceAsync("workflow-failed:" + workflowId, null, f.ClaimId, 1, "Decision letters failed: " + f.ClaimNumber,
            "Workflow " + workflowId + " gave up: " + error, calendar.LocalDate(now), "You", "communications", "workflow", null);
        await history.AppendAsync(f.ClaimId, now, "task", "Decision letters failed after retries", Actor.Workflow(workflowId), error, null, workflowId);
        await runs.FinishAsync(workflowId, runId, "failed", steps, ["Ops task opened"], error, now);
    });
}
