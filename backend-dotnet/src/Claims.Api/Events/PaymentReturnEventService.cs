using System.Globalization;
using Claims.Clock;
using Claims.Common;
using Claims.Domain;
using Claims.Gateway;
using Claims.Intake;
using Claims.Payment;
using Claims.Store;
using static Claims.Store.DeadlineRepository;
using static Claims.Store.LetterRepository;

namespace Claims.Events;

/// <summary>
/// The database work of the two short workflows after a payment came back: <c>PaymentReturnedWorkflow</c> (the `payment_returned` event the returns batch wrote) and
/// <c>PaymentMethodUpdatedWorkflow</c> (the `payment_method_updated` event of a payee's new account). Batch never changes a claim; this is the claim side. Every method
/// is safe to repeat: state changes are guarded (a claim reopens once, a row is written once per payee), letters carry dedupe keys, Begin and Finish are idempotent.
/// </summary>
public sealed class PaymentReturnEventService(Db db, IClock clock, BusinessCalendar calendar, PaymentRepository payments, DeadlineRepository deadlines, HistoryRepository history,
                                              WorkItemRepository workItems, WorkflowRunRepository runs, LetterService letters, IBankGateway bank, WorkflowFailureRecorder failures)
{
    /// <summary>
    /// How long the payee has to give new bank details: 10 days, as the mock's <c>onBankReturn</c> (<c>addDays(today, 10)</c>), its deadline table (D-715 due Sun 25 Oct) and the docs page's
    /// "bank_details_by ... (10 days)" have it. (The scenario page's prose says Mark "waited four days": that is how long he took, 15 to 19 Oct, not the limit: with a 4-day limit the row
    /// would already be 12 hours late when he answers on Mon 19 Oct at 20:15.)
    /// </summary>
    public const int PayeeDetailsDays = 10;

    public sealed record ReturnFacts(Guid ClaimId, string ClaimNumber, Guid ItemId, Guid PayeeId, string PayeeName, string Amount, string ReturnCode, string ReturnReason,
                                     string ClaimStatus, int RunNo);

    public sealed record ReopenResult(bool Reopened, string ClaimStatus, string DetailsDue, string Examiner);

    public sealed record MethodFacts(Guid ClaimId, Guid MethodId, Guid PayeeId, string PayeeName, string RoutingLast4, string AccountLast4, string Status, int Items, int RunNo);

    public sealed record Verified(bool Ok, string Reference, string Detail, int Attempts);

    // ------------------------------------------------------------------ payment returned

    public async Task<ReturnFacts> BeginReturnedAsync(Guid claimId, Guid itemId, Guid eventId, string workflowId, string runRecordId)
    {
        await runs.BeginAsync(workflowId, runRecordId, "event", "Payment returned", claimId, "Outbox relay · event " + eventId + " (the returns job marked the item returned)", "outbox_event", eventId, clock.UtcNow);
        var run = await runs.FindAsync(workflowId, runRecordId);
        if (run is { RunNo: > 1 }) await runs.AppendNoteAsync(workflowId, runRecordId, DocumentEventService.RerunNote(workflowId, run.RunNo));
        var f = await db.QuerySingleAsync("""
            SELECT c.claim_number, c.status, pi.payee_party_id, p.full_name, pi.amount, pi.currency, COALESCE(pi.return_code, '') AS code, COALESCE(pi.return_reason, '') AS reason
            FROM payment_items pi JOIN claims c ON c.id = pi.claim_id JOIN parties p ON p.id = pi.payee_party_id WHERE pi.id = @i
            """, new { i = itemId }, r => new ReturnFacts(claimId, r.Text("claim_number"), itemId, r.Guid("payee_party_id"), r.Text("full_name"),
                PaymentRules.Usd(r.Decimal("amount")), r.Text("code"), r.Text("reason"), r.Text("status"), 1));
        return f with { RunNo = run?.RunNo ?? 1 };
    }

    /// <summary>
    /// The claim side, in ONE transaction: the claim goes from `closed` to `reopened` (through the state machine: only a closed claim with a returned payment that has no paid
    /// replacement), its benefit line is `approved` again, the row waiting for the payee's new details is written (10 days), the examiner gets a work item and a history line.
    /// </summary>
    public Task<ReopenResult> ReopenAsync(Guid itemId, string workflowId) => db.InTransactionAsync(async () =>
    {
        var now = clock.UtcNow;
        var item = await db.QuerySingleAsync("""
            SELECT pi.claim_id, pi.payee_party_id, pi.amount, pi.return_code, p.full_name, c.owner_id, c.claim_number
            FROM payment_items pi JOIN parties p ON p.id = pi.payee_party_id JOIN claims c ON c.id = pi.claim_id WHERE pi.id = @i
            """, new { i = itemId }, r => (ClaimId: r.Guid("claim_id"), PayeeId: r.Guid("payee_party_id"), Amount: r.Decimal("amount"), Code: r.Str("return_code"), Name: r.Text("full_name"),
                Owner: r.GuidOrNull("owner_id"), Number: r.Text("claim_number")));
        await payments.LockClaimsAsync([item.ClaimId]);
        // Only while a returned payment still has no PAID replacement: if the payee's replacement was already paid (a race with a fast payee), there is nothing to wait for.
        var owing = """
            EXISTS (SELECT 1 FROM payment_items ri WHERE ri.claim_id = @c AND ri.status = 'returned'
                    AND NOT EXISTS (SELECT 1 FROM payment_items rp WHERE rp.replacement_of_id = ri.id AND rp.status = 'paid'))
            """;
        var moved = await db.ExecuteAsync($"UPDATE claims SET status = 'reopened', closed_at = NULL WHERE id = @c AND status = 'closed' AND {owing}", new { c = item.ClaimId });
        if (moved == 1)
            await db.ExecuteAsync("""
                UPDATE benefit_lines b SET status = 'approved', waiting_on = 'Payment'
                WHERE b.claim_id = @c AND b.status = 'paid'
                  AND EXISTS (SELECT 1 FROM payment_items ri WHERE ri.benefit_line_id = b.id AND ri.status = 'returned'
                              AND NOT EXISTS (SELECT 1 FROM payment_items rp WHERE rp.replacement_of_id = ri.id AND rp.status = 'paid'))
                """, new { c = item.ClaimId });
        var status = await db.SingleAsync<string>("SELECT status FROM claims WHERE id = @c", new { c = item.ClaimId });
        var first = LifeIntakeRules.First(item.Name);
        var dueAt = calendar.DaysAfter(now, PayeeDetailsDays);
        if (!await deadlines.HasLiveForPartyAsync(item.ClaimId, item.PayeeId, DeadlineKind.BankDetailsBy) && await db.SingleAsync<bool>("SELECT NOT EXISTS (SELECT 1 FROM payment_items WHERE replacement_of_id = @i)", new { i = itemId }))
            await deadlines.InsertAsync(new NewDeadline(item.ClaimId, DeadlineKind.BankDetailsBy, null, $"{first} gives new bank details (a reminder if not)", null, dueAt, null, item.PayeeId));
        await workItems.InsertOnceAsync("payment-returned:" + itemId, item.Owner, item.ClaimId, 1, "Payment returned: " + first,
            $"{PaymentRules.Usd(item.Amount)} came back from the bank ({item.Code}) · new details asked for by {Iso(calendar.LocalDate(dueAt))}", calendar.LocalDate(dueAt), item.Name, "payments", "workflow", null);
        if (moved == 1)
            await history.AppendAsync(item.ClaimId, now, "data", "Claim reopened: payment returned", Actor.Workflow(workflowId),
                $"{item.Name}'s payment of {PaymentRules.Usd(item.Amount)} came back ({item.Code}) · new details due {Iso(calendar.LocalDate(dueAt))}", itemId.ToString(), workflowId);
        else
            await history.AppendAsync(item.ClaimId, now, "data", "Payment returned: the claim was not closed, so it stays " + status, Actor.Workflow(workflowId),
                "The claim status did not change", itemId.ToString(), workflowId);
        var examiner = item.Owner is null ? "the team queue" : await db.SingleAsync<string>("SELECT display_name FROM staff_users WHERE id = @o", new { o = item.Owner });
        return new ReopenResult(moved == 1, status, Iso(calendar.LocalDate(dueAt)), examiner);
    });

    /// <summary>RTN-LIFE-01 to the payee: the account is closed, please add a new one. Once per returned item.</summary>
    public async Task<bool> AskForNewAccountAsync(Guid itemId, string workflowId)
    {
        var item = await db.QuerySingleAsync("""
            SELECT pi.claim_id, pi.payee_party_id, pi.amount, p.full_name FROM payment_items pi JOIN parties p ON p.id = pi.payee_party_id WHERE pi.id = @i
            """, new { i = itemId }, r => (ClaimId: r.Guid("claim_id"), PayeeId: r.Guid("payee_party_id"), Amount: r.Decimal("amount"), Name: r.Text("full_name")));
        await letters.SendOnceAsync(new NewLetter(item.ClaimId, "RTN-LIFE-01", "email", item.PayeeId, item.Name, "Your payment was returned · " + LifeIntakeRules.First(item.Name),
            $"Your bank returned the payment of {PaymentRules.Usd(item.Amount)} because the account is closed. Please add a new account in the portal; we pay it in the next daily run.",
            "outbox_event", null, workflowId, "payment-returned:" + itemId + ":ask"), item.Name);
        return true;
    }

    public Task CompleteReturnedAsync(Guid claimId, Guid itemId, IReadOnlyList<RunStep> steps, string note, string workflowId, string runRecordId) => db.InTransactionAsync(async () =>
    {
        var now = clock.UtcNow;
        var claim = await db.SingleAsync<string>("SELECT status FROM claims WHERE id = @c", new { c = claimId });
        var reran = await workItems.CompleteByKeyAsync("workflow-failed:" + workflowId, now);
        await history.AppendAsync(claimId, now, "communication", "New account asked for: RTN-LIFE-01", Actor.Workflow(workflowId), null, null, workflowId);
        await runs.FinishAsync(workflowId, runRecordId, "completed", steps,
            [$"Status → {claim}", "Row written: the payee's new details are due", "Exception work item for the examiner", "Letter in Communications", reran ? "Ops task closed" : "History"], null, now, note);
    });

    public Task RecordReturnedFailureAsync(Guid claimId, string error, IReadOnlyList<RunStep> steps, string workflowId, string runRecordId) =>
        failures.RecordAsync(claimId, workflowId, runRecordId, "Payment returned", error, steps);

    // ------------------------------------------------------------------ payment method updated

    public async Task<MethodFacts> BeginMethodAsync(Guid claimId, Guid methodId, Guid eventId, string workflowId, string runRecordId)
    {
        await runs.BeginAsync(workflowId, runRecordId, "event", "New bank account", claimId, "Outbox relay · event " + eventId + " (bank details saved)", "outbox_event", eventId, clock.UtcNow);
        var run = await runs.FindAsync(workflowId, runRecordId);
        if (run is { RunNo: > 1 }) await runs.AppendNoteAsync(workflowId, runRecordId, DocumentEventService.RerunNote(workflowId, run.RunNo));
        var m = await payments.FindMethodAsync(methodId) ?? throw new InvalidOperationException($"Payment method {methodId} does not exist");
        var name = await db.SingleAsync<string>("SELECT full_name FROM parties WHERE id = @p", new { p = m.PartyId });
        var items = await payments.ItemsOfMethodAsync(methodId);
        return new MethodFacts(claimId, methodId, m.PartyId, name, m.RoutingLast4, m.AccountLast4, m.Status, items.Count, run?.RunNo ?? 1);
    }

    /// <summary>Asks the bank whether the account is open and the name matches. An answer, not an error; only an unreachable bank throws (and is retried).</summary>
    public async Task<Verified> VerifyAccountAsync(Guid methodId, int attempt)
    {
        var m = await payments.FindMethodAsync(methodId) ?? throw new InvalidOperationException($"Payment method {methodId} does not exist");
        var name = await db.SingleAsync<string>("SELECT full_name FROM parties WHERE id = @p", new { p = m.PartyId });
        var v = await bank.VerifyAccountAsync(new BankAccount(name, m.RoutingLast4, m.AccountLast4));
        return new Verified(v.Verified, v.Reference, v.Detail, attempt);
    }

    /// <summary>Verified: the method is marked verified and the payee is told (RTN-LIFE-02, once per method).</summary>
    public async Task<bool> ConfirmAsync(Guid methodId, string workflowId)
    {
        var now = clock.UtcNow;
        var m = await payments.FindMethodAsync(methodId) ?? throw new InvalidOperationException($"Payment method {methodId} does not exist");
        await payments.SetMethodStatusAsync(methodId, "verified", now);
        var item = await db.QueryAsync("SELECT amount, pay_on FROM payment_items WHERE payment_method_id = @m ORDER BY created_at LIMIT 1", new { m = methodId },
            r => (Amount: r.Decimal("amount"), PayOn: r.Date("pay_on")));
        var name = await db.SingleAsync<string>("SELECT full_name FROM parties WHERE id = @p", new { p = m.PartyId });
        var when = item.Count > 0 ? item[0].PayOn.ToString("ddd d MMM", CultureInfo.InvariantCulture) : "the next payment run";
        var amount = item.Count > 0 ? PaymentRules.Usd(item[0].Amount) : "your payment";
        await letters.SendOnceAsync(new NewLetter(m.ClaimId, "RTN-LIFE-02", "email", m.PartyId, name, "New account confirmed · " + LifeIntakeRules.First(name),
            $"Thank you. We pay {amount} to your new account (ending {m.AccountLast4}) in the {when} payment run.", "outbox_event", null, workflowId, "payment-method:" + methodId + ":confirmed"), name);
        return true;
    }

    /// <summary>
    /// The bank cannot verify the account: the method is `rejected`, the replacement item stops (it is held, if no run has taken it yet) and the examiner gets a work item.
    /// Nothing else waits: the payee's row is a deadline the examiner sees.
    /// </summary>
    public Task<int> RejectAsync(Guid methodId, string detail, string workflowId) => db.InTransactionAsync(async () =>
    {
        var now = clock.UtcNow;
        var m = await payments.FindMethodAsync(methodId) ?? throw new InvalidOperationException($"Payment method {methodId} does not exist");
        await payments.SetMethodStatusAsync(methodId, "rejected", now);
        var held = await payments.HoldClearedForMethodAsync(methodId, "The bank could not verify the new account: " + detail);
        var owner = await db.SingleOrDefaultAsync<Guid?>("SELECT owner_id FROM claims WHERE id = @c", new { c = m.ClaimId });
        var name = await db.SingleAsync<string>("SELECT full_name FROM parties WHERE id = @p", new { p = m.PartyId });
        await workItems.InsertOnceAsync("method-rejected:" + methodId, owner, m.ClaimId, 1, "New account could not be verified: " + LifeIntakeRules.First(name),
            $"{detail} · the replacement payment is held; ask {LifeIntakeRules.First(name)} for another account", calendar.LocalDate(now), name, "payments", "workflow", null);
        await history.AppendAsync(m.ClaimId, now, "payment", "New account could not be verified: " + name, Actor.Workflow(workflowId),
            $"{detail} · {held.Count} replacement item held", methodId.ToString(), workflowId);
        return held.Count;
    });

    public Task CompleteMethodAsync(Guid claimId, Guid methodId, string status, IReadOnlyList<RunStep> steps, string note, string workflowId, string runRecordId) => db.InTransactionAsync(async () =>
    {
        var now = clock.UtcNow;
        var reran = await workItems.CompleteByKeyAsync("workflow-failed:" + workflowId, now);
        await history.AppendAsync(claimId, now, "payment", status == "verified" ? "New bank account verified: the replacement payment is cleared" : "New bank account not verified", Actor.Workflow(workflowId), null, methodId.ToString(), workflowId);
        await runs.FinishAsync(workflowId, runRecordId, status == "verified" ? "completed" : "needs_review", steps,
            [status == "verified" ? "Account verified · replacement item stays cleared" : "Account rejected · replacement item held", "History", reran ? "Ops task closed" : "Letter in Communications"], null, now, note);
    });

    public Task RecordMethodFailureAsync(Guid claimId, string error, IReadOnlyList<RunStep> steps, string workflowId, string runRecordId) =>
        failures.RecordAsync(claimId, workflowId, runRecordId, "New bank account", error, steps);

    private static string Iso(DateOnly d) => d.ToString("yyyy-MM-dd", CultureInfo.InvariantCulture);
}
