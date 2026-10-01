using System.Diagnostics;
using System.Globalization;
using Claims.Common;
using Claims.Events;
using Claims.Gateway;
using Claims.Payment;
using Claims.Store;
using Claims.Tests.Support;
using Npgsql;

namespace Claims.Tests.Postgres;

/// <summary>
/// REQUIRES POSTGRES. The bank sends a payment back, and the claim reopens and closes again. The returns BATCH (which never changes a claim), the claim side of it (what the workflow's
/// database work does), the payee's new account with its replacement item, and the payment run that pays it. The batch's one locking statement is proved with a second connection and a
/// negative control, as the payment run's is. Business time: decided Mon 12 Oct 11:30, paid Tue 13 Oct 02:00 Central, the mock's dates (24 days of interest, $230.13 and $230.14).
/// </summary>
public class BankReturnPostgresTests(BankReturnPostgresTests.Fixture fixture) : IClassFixture<BankReturnPostgresTests.Fixture>, IAsyncLifetime
{
    public sealed class Fixture : PostgresApiFixture
    {
        protected override string Hint => "bankreturn";

        protected override DateTimeOffset? ClockStart => DateTimeOffset.Parse("2026-10-12T16:30:00Z", CultureInfo.InvariantCulture);

        protected override IReadOnlyDictionary<string, string?> Settings { get; } = new Dictionary<string, string?> { ["Claims:Db:DevSeed"] = "true" };
    }

    private static DateTimeOffset At(string iso) => DateTimeOffset.Parse(iso, CultureInfo.InvariantCulture);

    private Db Sql => fixture.Db;
    private StubBankGateway Bank => fixture.Get<StubBankGateway>();
    private IFaultRegistry Faults => fixture.Get<IFaultRegistry>();
    private PaymentReturnsService Returns => fixture.Get<PaymentReturnsService>();
    private PaymentReturnEventService Events => fixture.Get<PaymentReturnEventService>();

    public async ValueTask InitializeAsync()
    {
        if (!PostgresSupport.Available) return;
        // Other tests' items that never got paid would ride along in a run: put them out of the way. Returns still in the stub bank's queue are dropped too.
        await Sql.ExecuteAsync("UPDATE payment_items SET status = 'cancelled', hold_reason = NULL WHERE status IN ('cleared', 'held', 'awaiting_proof')");
        foreach (var f in Faults.Active) Faults.Set(f, false);
        await Bank.AcknowledgeReturnsAsync(Bank.Queue.Select(r => r.ReturnId));
        fixture.Clock.Set(At("2026-10-12T16:30:00Z"));
    }

    public ValueTask DisposeAsync() => ValueTask.CompletedTask;

    private Task<T> One<T>(string sql, object? param = null) => Sql.SingleAsync<T>(sql, param);

    private sealed record PaidClaim(Guid ClaimId, Guid Diane, Guid Mark, Guid DianeParty, Guid MarkParty);

    /// <summary>A decided claim (Mon 12 Oct 11:30) paid by the run of Tue 13 Oct 02:00: closed, both items paid.</summary>
    private async Task<PaidClaim> PaidAsync()
    {
        fixture.Clock.Set(At("2026-10-12T16:30:00Z"));
        var (claim, result) = await LifeScenario.ApprovedAsync(fixture);
        Assert.Equal("recorded", result.Kind);
        fixture.Clock.Set(At("2026-10-13T07:00:00Z"));
        var run = await fixture.Get<PaymentRunService>().RunManualAsync(new DateOnly(2026, 10, 13), "run-" + Guid.NewGuid(), "ops");
        Assert.Equal(2, run.Run.PaidCount);
        Assert.Equal("closed", await One<string>("SELECT status FROM claims WHERE id = @c", new { c = claim.ClaimId }));
        return new PaidClaim(claim.ClaimId, await ItemOf(claim.ClaimId, "Diane"), await ItemOf(claim.ClaimId, "Mark"), await PartyOf("Diane", claim.ClaimId), await PartyOf("Mark", claim.ClaimId));
    }

    private async Task<DateTimeOffset?> ClosedAt(Guid claim) =>
        (await Sql.QueryAsync("SELECT closed_at FROM claims WHERE id = @c", new { c = claim }, r => r.InstantOrNull("closed_at")))[0];

    private Task<Guid> ItemOf(Guid claim, string first) => One<Guid>(
        "SELECT pi.id FROM payment_items pi JOIN parties p ON p.id = pi.payee_party_id WHERE pi.claim_id = @c AND p.full_name LIKE @n AND pi.replacement_of_id IS NULL", new { c = claim, n = first + "%" });

    private Task<Guid> PartyOf(string first, Guid claim) => One<Guid>(
        "SELECT p.id FROM claim_parties cp JOIN parties p ON p.id = cp.party_id WHERE cp.claim_id = @c AND cp.role = 'beneficiary' AND p.full_name LIKE @n", new { c = claim, n = first + "%" });

    private async Task<Guid> ReturnAsync(Guid item, string code = "R02", string reason = "Account closed")
    {
        Bank.EnqueueReturn(item, code, reason, fixture.Clock.UtcNow);
        return item;
    }

    // ------------------------------------------------------------------ the batch

    [PostgresFact]
    public async Task TheBatchMarksAPaidItemReturnedRecordsAHoldAndWritesTheEventAndNeverTouchesTheClaim()
    {
        var c = await PaidAsync();
        fixture.Clock.Set(At("2026-10-15T11:30:00Z"));   // Thu 15 Oct 06:30 Central: the returns job
        await ReturnAsync(c.Mark);

        var r = await Returns.ProcessAsync("ops");

        Assert.Equal((1, 1, 0), (r.Read, r.Processed.Count, r.Skipped.Count));
        var p = r.Processed[0];
        Assert.Equal((c.Mark, "Mark Castellano", "100230.14", "R02"), (p.PaymentItemId, p.PayeeName, p.Amount.Amount, p.ReturnCode));
        // The item is returned, with the bank's code and reason; its money, payee and payment record are exactly what they were.
        var item = await Sql.QueryAsync("SELECT status, principal_amount, interest_amount, amount, return_code, return_reason, payment_reference, paid_at, run_id FROM payment_items WHERE id = @i", new { i = c.Mark },
            x => (x.Text("status"), x.Decimal("principal_amount"), x.Decimal("interest_amount"), x.Decimal("amount"), x.Str("return_code"), x.Str("return_reason"), x.Str("payment_reference"), x.InstantOrNull("paid_at"), x.GuidOrNull("run_id")));
        Assert.Equal(("returned", 100000m, 230.14m, 100230.14m, "R02", "Account closed"), (item[0].Item1, item[0].Item2, item[0].Item3, item[0].Item4, item[0].Item5, item[0].Item6));
        Assert.StartsWith("STUB-EFT-", item[0].Item7, StringComparison.Ordinal);
        Assert.NotNull(item[0].Item8);
        Assert.NotNull(item[0].Item9);
        // Diane's item is untouched. The hold is on Mark's closed account, one per returned item.
        Assert.Equal("paid", await One<string>("SELECT status FROM payment_items WHERE id = @i", new { i = c.Diane }));
        Assert.Equal((1, "R02 Account closed"), (await One<int>("SELECT count(*) FROM payment_method_holds WHERE source_item_id = @i AND party_id = @p AND claim_id = @c", new { i = c.Mark, p = c.MarkParty, c = c.ClaimId }),
            await One<string>("SELECT reason FROM payment_method_holds WHERE source_item_id = @i", new { i = c.Mark })));
        // One outbox event, unpublished: a workflow does the claim side. The batch itself did not touch the claim.
        Assert.Equal(1, await One<int>("SELECT count(*) FROM outbox_events WHERE claim_id = @c AND event_type = 'payment_returned' AND published_at IS NULL AND id = @e AND payload->>'paymentItemId' = @i",
            new { c = c.ClaimId, e = p.OutboxEventId, i = c.Mark.ToString() }));
        Assert.Equal("closed", await One<string>("SELECT status FROM claims WHERE id = @c", new { c = c.ClaimId }));
        Assert.NotNull(await ClosedAt(c.ClaimId));
        Assert.Equal(1, await One<int>("SELECT count(*) FROM history_events WHERE claim_id = @c AND title LIKE 'Payment returned by the bank: Mark%' AND actor_kind = 'batch'", new { c = c.ClaimId }));
        // The bank's queue was acknowledged after the commit; a second batch reads nothing and writes nothing.
        Assert.Empty(Bank.Queue);
        var again = await Returns.ProcessAsync("ops");
        Assert.Equal((0, 0), (again.Read, again.Processed.Count));
        Assert.Equal(1, await One<int>("SELECT count(*) FROM outbox_events WHERE claim_id = @c AND event_type = 'payment_returned'", new { c = c.ClaimId }));
    }

    [PostgresFact]
    public async Task AReturnedItemStaysAsItWasAndCanNeverBeEditedOrUnreturned()
    {
        var c = await PaidAsync();
        await ReturnAsync(c.Mark);
        await Returns.ProcessAsync("ops");

        foreach (var sql in new[]
                 {
                     "UPDATE payment_items SET principal_amount = principal_amount + 1 WHERE id = @i",
                     "UPDATE payment_items SET interest_amount = 0 WHERE id = @i",
                     "UPDATE payment_items SET status = 'paid' WHERE id = @i",
                     "UPDATE payment_items SET status = 'cleared', run_id = NULL WHERE id = @i",
                     "UPDATE payment_items SET payment_reference = 'edited' WHERE id = @i",
                     "UPDATE payment_items SET payee_party_id = (SELECT id FROM parties WHERE full_name LIKE 'Diane%' LIMIT 1) WHERE id = @i",
                 })
        {
            var e = await Assert.ThrowsAsync<PostgresException>(() => Sql.ExecuteAsync(sql, new { i = c.Mark }));
            Assert.Equal("23000", e.SqlState);   // integrity_constraint_violation, from the trigger
        }
    }

    [PostgresFact]
    public async Task ReturnsThatCannotBeProcessedAreSkippedWithAReasonAndOnlyTheSettledOnesAreAcknowledged()
    {
        var c = await PaidAsync();
        var unknown = Guid.NewGuid();
        var pending = await Sql.SingleAsync<Guid>("""
            INSERT INTO payment_items (claim_id, benefit_line_id, decision_id, payee_party_id, basis, principal_amount, interest_amount, method, pay_on, status, kind, replacement_of_id)
            SELECT claim_id, benefit_line_id, decision_id, payee_party_id, 'not paid yet', 1, 0, 'eft', pay_on, 'cleared', 'benefit', id FROM payment_items WHERE id = @i RETURNING id
            """, new { i = c.Diane });
        await ReturnAsync(unknown);
        await ReturnAsync(pending);
        await ReturnAsync(c.Diane);

        var first = await Returns.ProcessAsync("ops");

        // Diane's item was paid, so it is returned; the unknown item and the not-yet-paid item cannot be.
        Assert.Equal(3, first.Read);
        Assert.Equal([c.Diane], first.Processed.Select(p => p.PaymentItemId));
        Assert.Equal(["not_found", "not_paid"], first.Skipped.Select(x => x.Reason).Order());
        // Acknowledged: what was processed and the unknown one (nothing will ever change). Kept: the cleared item, because it may still be paid and returned later.
        Assert.Equal([pending], Bank.Queue.Select(q => q.ItemId));

        await ReturnAsync(c.Diane, "R03", "No account");   // the bank repeats itself (a returns file sent twice)
        var second = await Returns.ProcessAsync("ops");

        Assert.Equal(2, second.Read);
        Assert.Empty(second.Processed);
        Assert.Equal(["not_paid", "not_paid"], second.Skipped.Select(x => x.Reason));
        Assert.Equal([pending], Bank.Queue.Select(q => q.ItemId));   // the repeat (an item already returned) was acknowledged too
        Assert.Equal("R02", await One<string>("SELECT return_code FROM payment_items WHERE id = @i", new { i = c.Diane }));   // the repeat's R03 changed nothing
    }

    [PostgresFact]
    public async Task ARowAnotherBatchHoldsIsSkippedNotWaitedOnAndWithoutSkipLockedTheSameStatementBlocks()
    {
        var c = await PaidAsync();
        await ReturnAsync(c.Mark);
        await ReturnAsync(c.Diane);

        // Connection A holds Diane's item (an open transaction, as a concurrent batch would).
        await using var a = await Sql.DataSource.OpenConnectionAsync();
        await using var txA = await a.BeginTransactionAsync();
        await using (var lockIt = new NpgsqlCommand("SELECT id FROM payment_items WHERE id = @id FOR UPDATE", a, txA))
        {
            lockIt.Parameters.AddWithValue("id", c.Diane);
            await lockIt.ExecuteScalarAsync();
        }

        // The real batch returns at once: it takes Mark's item, and reports Diane's as being processed by another batch (and leaves her return in the bank's queue).
        var clock = Stopwatch.StartNew();
        var r = await Returns.ProcessAsync("ops");
        Assert.True(clock.Elapsed < TimeSpan.FromSeconds(5), $"the batch waited {clock.Elapsed}");
        Assert.Equal([c.Mark], r.Processed.Select(p => p.PaymentItemId));
        Assert.Equal([("locked_by_another_batch", c.Diane)], r.Skipped.Select(s => (s.Reason, s.PaymentItemId)));
        Assert.Equal([c.Diane], Bank.Queue.Select(q => q.ItemId));

        // NEGATIVE CONTROL: the identical statement with SKIP LOCKED removed waits on the held row (here it gives up after 500 ms).
        var withoutSkipLocked = PaymentRepository.LockPaidForReturnSql.Replace("SKIP LOCKED", "", StringComparison.Ordinal);
        Assert.NotEqual(PaymentRepository.LockPaidForReturnSql, withoutSkipLocked);
        await using (var b = await Sql.DataSource.OpenConnectionAsync())
        await using (var txB = await b.BeginTransactionAsync())
        {
            await using (var timeout = new NpgsqlCommand("SET LOCAL lock_timeout = '500ms'", b, txB)) await timeout.ExecuteNonQueryAsync();
            await using var cmd = new NpgsqlCommand(withoutSkipLocked.Replace("@ids", "@x", StringComparison.Ordinal), b, txB);
            cmd.Parameters.AddWithValue("x", NpgsqlTypes.NpgsqlDbType.Text, Db.ArrayLiteral([c.Diane.ToString()]));
            var e = await Assert.ThrowsAsync<PostgresException>(async () => await cmd.ExecuteReaderAsync());
            Assert.Equal("55P03", e.SqlState);   // lock_not_available: it blocked on the row connection A holds
        }

        await txA.RollbackAsync();
        var later = await Returns.ProcessAsync("ops");   // with the lock gone the next batch takes Diane's item
        Assert.Equal([c.Diane], later.Processed.Select(p => p.PaymentItemId));
        Assert.Empty(Bank.Queue);
    }

    [PostgresFact]
    public async Task BatchesRunningAtTheSameTimeProcessEveryReturnExactlyOnce()
    {
        var claims = new List<PaidClaim>();
        for (var i = 0; i < 4; i++) claims.Add(await PaidAsync());
        fixture.Clock.Set(At("2026-10-15T11:30:00Z"));
        foreach (var c in claims) { await ReturnAsync(c.Mark); await ReturnAsync(c.Diane); }

        var results = await Task.WhenAll(Enumerable.Range(0, 6).Select(_ => Task.Run(() => Returns.ProcessAsync("ops"))));

        var processed = results.SelectMany(r => r.Processed).Select(p => p.PaymentItemId).ToList();
        Assert.Equal(8, processed.Count);
        Assert.Equal(8, processed.Distinct().Count());   // no item twice
        var ids = claims.SelectMany(c => new[] { c.Mark, c.Diane }).ToHashSet();
        Assert.True(ids.SetEquals(processed));
        Assert.Equal(8, await One<int>("SELECT count(*) FROM payment_items WHERE id = ANY (cast(@ids as uuid[])) AND status = 'returned'", new { ids = Db.ArrayLiteral(ids.Select(i => i.ToString())) }));
        Assert.Equal(8, await One<int>("SELECT count(*) FROM outbox_events WHERE event_type = 'payment_returned' AND payload->>'paymentItemId' = ANY (cast(@ids as text[]))", new { ids = Db.ArrayLiteral(ids.Select(i => i.ToString())) }));
        Assert.Equal(8, await One<int>("SELECT count(*) FROM payment_method_holds WHERE source_item_id = ANY (cast(@ids as uuid[]))", new { ids = Db.ArrayLiteral(ids.Select(i => i.ToString())) }));
        Assert.Empty(Bank.Queue);
    }

    // ------------------------------------------------------------------ the claim side

    [PostgresFact]
    public async Task TheClaimReopensThroughTheWorkflowsDatabaseWorkWithADetailsRowAndAWorkItemAndDoesSoOnce()
    {
        var c = await PaidAsync();
        fixture.Clock.Set(At("2026-10-15T13:10:00Z"));   // Thu 15 Oct 08:10 Central
        await ReturnAsync(c.Mark);
        await Returns.ProcessAsync("ops");
        var wf = "event-test-returned-" + c.Mark;

        var facts = await Events.BeginReturnedAsync(c.ClaimId, c.Mark, Guid.NewGuid(), wf, "run-1");
        Assert.Equal(("Mark Castellano", "$100,230.14", "R02", "closed"), (facts.PayeeName, facts.Amount, facts.ReturnCode, facts.ClaimStatus));
        var reopen = await Events.ReopenAsync(c.Mark, wf);
        var again = await Events.ReopenAsync(c.Mark, wf);   // an activity retried after its answer was lost

        Assert.Equal((true, "reopened", "2026-10-25"), (reopen.Reopened, reopen.ClaimStatus, reopen.DetailsDue));   // 10 days after Thu 15 Oct: Sun 25 Oct, the mock's D-715
        Assert.False(again.Reopened);
        Assert.Equal("reopened", await One<string>("SELECT status FROM claims WHERE id = @c", new { c = c.ClaimId }));
        Assert.Null(await ClosedAt(c.ClaimId));   // claims_closed_ck: closed_at only while closed
        Assert.Equal("approved", await One<string>("SELECT status FROM benefit_lines WHERE claim_id = @c AND kind = 'base'", new { c = c.ClaimId }));   // the line waits for the replacement
        Assert.Equal(1, await One<int>("SELECT count(*) FROM deadlines WHERE claim_id = @c AND kind = 'bank_details_by' AND state = 'open' AND party_id = @p", new { c = c.ClaimId, p = c.MarkParty }));
        Assert.Equal("2026-10-25", await One<string>("SELECT to_char(due_at AT TIME ZONE 'America/Chicago', 'YYYY-MM-DD') FROM deadlines WHERE claim_id = @c AND kind = 'bank_details_by'", new { c = c.ClaimId }));
        Assert.Equal(1, await One<int>("SELECT count(*) FROM work_items WHERE dedupe_key = 'payment-returned:' || @i AND status = 'open'", new { i = c.Mark.ToString() }));
        Assert.Equal(1, await One<int>("SELECT count(*) FROM history_events WHERE claim_id = @c AND title = 'Claim reopened: payment returned'", new { c = c.ClaimId }));
        // The letter, once.
        await Events.AskForNewAccountAsync(c.Mark, wf);
        await Events.AskForNewAccountAsync(c.Mark, wf);
        Assert.Equal(1, await One<int>("SELECT count(*) FROM letters WHERE claim_id = @c AND template_code = 'RTN-LIFE-01' AND status = 'sent'", new { c = c.ClaimId }));
    }

    // ------------------------------------------------------------------ the new account, the replacement, the second close

    private async Task<PaidClaim> ReopenedAsync()
    {
        var c = await PaidAsync();
        fixture.Clock.Set(At("2026-10-15T13:10:00Z"));
        await ReturnAsync(c.Mark);
        await Returns.ProcessAsync("ops");
        await Events.BeginReturnedAsync(c.ClaimId, c.Mark, Guid.NewGuid(), "event-test-returned-" + c.Mark, "run-1");
        await Events.ReopenAsync(c.Mark, "event-test-returned-" + c.Mark);
        return c;
    }

    private static string Account(string account = "000123441") => $"{{\"kind\":\"eft\",\"routingNumber\":\"021000021\",\"accountNumber\":\"{account}\"}}";

    private static Dictionary<string, string> Key() => new() { ["Idempotency-Key"] = "pm-" + Guid.NewGuid(), ["X-Actor"] = "portal.mark" };

    [PostgresFact]
    public async Task ANewAccountCreatesTheReplacementItemWithTheSameAmountAndClosesTheDetailsRowInOneTransaction()
    {
        var c = await ReopenedAsync();
        fixture.Clock.Set(At("2026-10-20T01:15:00Z"));   // Mon 19 Oct 20:15 Central
        var headers = Key();
        var client = fixture.CreateClient();
        var path = $"/claims/{c.ClaimId}/payees/{c.MarkParty}:update-payment-method";

        var r = await client.PostApiAsync(path, Account(), headers);

        Assert.Equal(201, r.StatusCode);
        Assert.Equal(("eft", "0021", "3441", "pending_verification"), (r.Str("paymentMethod.kind"), r.Str("paymentMethod.routingLast4"), r.Str("paymentMethod.accountLast4"), r.Str("paymentMethod.status")));
        var item = r.Json["replacementItems"]![0]!;
        Assert.Equal(("cleared", "100000.00", "230.14", "100230.14", "2026-10-20", c.Mark.ToString()),
            (item["status"]!.ToString(), item["principal"]!["amount"]!.ToString(), item["interest"]!["amount"]!.ToString(), item["amount"]!["amount"]!.ToString(), item["payOn"]!.ToString(), item["replacementOfId"]!.ToString()));
        Assert.Equal(r.Str("paymentMethod.id"), item["paymentMethodId"]!.ToString());
        // The returned item points forward to it and is untouched.
        var returned = (await client.GetApiAsync($"/claims/{c.ClaimId}/payment-items")).Items.Single(i => i["id"]!.ToString() == c.Mark.ToString());
        Assert.Equal(("returned", item["id"]!.ToString()), (returned["status"]!.ToString(), returned["replacedById"]!.ToString()));
        // The details row closed without firing; the reissue target (2 business days: Wed 21 Oct) was written; the examiner's work item is done.
        Assert.Equal(("done", false), (await One<string>("SELECT state FROM deadlines WHERE claim_id = @c AND kind = 'bank_details_by'", new { c = c.ClaimId }), await One<bool>("SELECT fired FROM deadlines WHERE claim_id = @c AND kind = 'bank_details_by'", new { c = c.ClaimId })));
        Assert.Equal("2026-10-21", r.Json["reissueDeadline"]!["dueAt"]!.ToString().Length > 0 ? await One<string>("SELECT to_char(due_at AT TIME ZONE 'America/Chicago', 'YYYY-MM-DD') FROM deadlines WHERE claim_id = @c AND kind = 'payment_due' AND sla = 'reissue'", new { c = c.ClaimId }) : "");
        Assert.Equal("done", await One<string>("SELECT status FROM work_items WHERE dedupe_key = 'payment-returned:' || @i", new { i = c.Mark.ToString() }));
        Assert.Equal(1, await One<int>("SELECT count(*) FROM outbox_events WHERE claim_id = @c AND event_type = 'payment_method_updated' AND published_at IS NULL", new { c = c.ClaimId }));
        // The hold on the closed account records which account replaced it (and stays: the closed account stays closed).
        Assert.Equal(r.Str("paymentMethod.id"), (await One<Guid>("SELECT superseded_by_method_id FROM payment_method_holds WHERE source_item_id = @i", new { i = c.Mark })).ToString());
        // Only the last four digits of the numbers exist anywhere in the database.
        Assert.Equal(0, await One<int>("SELECT count(*) FROM payment_methods WHERE routing_last4 = '0210' OR account_last4 LIKE '%123%'", null));

        // The same key and body again: the same result, nothing new. The same key with another account is refused.
        var replay = await client.PostApiAsync(path, Account(), headers);
        Assert.Equal((200, "true"), (replay.StatusCode, replay.Header("Idempotent-Replayed")));
        Assert.Equal(1, await One<int>("SELECT count(*) FROM payment_items WHERE replacement_of_id = @i", new { i = c.Mark }));
        Assert.Equal(409, (await client.PostApiAsync(path, Account("000999999"), headers)).StatusCode);
        // A second account with a new key: there is no returned payment left to replace.
        Assert.Equal((409, "no_returned_payment"), (await Send(client, path, Account("000555777"))));
        // Diane has no returned payment either; an unknown payee is 404; bad numbers are 422.
        Assert.Equal((409, "no_returned_payment"), (await Send(client, $"/claims/{c.ClaimId}/payees/{c.DianeParty}:update-payment-method", Account())));
        Assert.Equal(404, (await client.PostApiAsync($"/claims/{c.ClaimId}/payees/{Guid.NewGuid()}:update-payment-method", Account(), Key())).StatusCode);
        Assert.Equal(422, (await client.PostApiAsync(path, "{\"kind\":\"eft\",\"routingNumber\":\"12\",\"accountNumber\":\"abc\"}", Key())).StatusCode);
    }

    private static async Task<(int, string?)> Send(HttpClient client, string path, string body)
    {
        var r = await client.PostApiAsync(path, body, Key());
        return (r.StatusCode, r.Str("code"));
    }

    [PostgresFact]
    public async Task TheRunLeavesItemsThatPayToTheClosedAccountAloneAndPaysTheReplacementAndTheClaimClosesAgain()
    {
        var c = await ReopenedAsync();
        fixture.Clock.Set(At("2026-10-20T01:15:00Z"));
        var client = fixture.CreateClient();
        var updated = await client.PostApiAsync($"/claims/{c.ClaimId}/payees/{c.MarkParty}:update-payment-method", Account(), Key());
        Assert.Equal(201, updated.StatusCode);
        var replacement = Guid.Parse(updated.Json["replacementItems"]![0]!["id"]!.ToString());

        // A cleared item that would still pay to the account on file (no payment method) is not picked up while the hold lasts.
        var stray = await Sql.SingleAsync<Guid>("""
            INSERT INTO payment_items (claim_id, benefit_line_id, decision_id, payee_party_id, basis, principal_amount, interest_amount, method, pay_on, status, kind, replacement_of_id)
            SELECT claim_id, benefit_line_id, decision_id, payee_party_id, 'stray: pays to the account on file', 1, 0, 'eft', '2026-10-20', 'cleared', 'benefit', @r FROM payment_items WHERE id = @r RETURNING id
            """, new { r = replacement });
        fixture.Clock.Set(At("2026-10-20T07:00:00Z"));   // Tue 20 Oct 02:00 Central
        var run = await fixture.Get<PaymentRunService>().RunManualAsync(new DateOnly(2026, 10, 20), "run-" + Guid.NewGuid(), "ops");

        Assert.Equal((1, 1, "100230.14"), (run.Run.ItemCount, run.Run.PaidCount, run.Run.Total.Amount));
        Assert.Equal("paid", await One<string>("SELECT status FROM payment_items WHERE id = @i", new { i = replacement }));
        Assert.Equal("cleared", await One<string>("SELECT status FROM payment_items WHERE id = @i", new { i = stray }));   // skipped, not paid
        // The stray item keeps the claim from closing. Take it out of the way and the same statements the run uses close it.
        Assert.Equal("reopened", await One<string>("SELECT status FROM claims WHERE id = @c", new { c = c.ClaimId }));
        await Sql.ExecuteAsync("UPDATE payment_items SET status = 'cancelled' WHERE id = @i", new { i = stray });
        var payments = fixture.Get<PaymentRepository>();
        await payments.MarkPaidLinesAsync(c.ClaimId);
        Assert.True(await payments.TryCloseClaimAsync(c.ClaimId, fixture.Clock.UtcNow));
        Assert.Equal("closed", await One<string>("SELECT status FROM claims WHERE id = @c", new { c = c.ClaimId }));
    }

    [PostgresFact]
    public async Task ThePaidReplacementClosesTheClaimAgainWithItsOwnClosingLetterAndTheHistoryShowsTwoCloses()
    {
        var c = await ReopenedAsync();
        fixture.Clock.Set(At("2026-10-20T01:15:00Z"));
        var client = fixture.CreateClient();
        Assert.Equal(201, (await client.PostApiAsync($"/claims/{c.ClaimId}/payees/{c.MarkParty}:update-payment-method", Account(), Key())).StatusCode);
        fixture.Clock.Set(At("2026-10-20T07:00:00Z"));

        var run = await fixture.Get<PaymentRunService>().RunManualAsync(new DateOnly(2026, 10, 20), "run-" + Guid.NewGuid(), "ops");

        Assert.Equal((1, 1), (run.Run.ItemCount, run.Run.PaidCount));
        Assert.Equal("closed", await One<string>("SELECT status FROM claims WHERE id = @c", new { c = c.ClaimId }));   // reopened -> closed: the second close
        Assert.Equal(new DateTimeOffset(2026, 10, 20, 7, 0, 0, TimeSpan.Zero), await ClosedAt(c.ClaimId));
        Assert.Equal("paid", await One<string>("SELECT status FROM benefit_lines WHERE claim_id = @c AND kind = 'base'", new { c = c.ClaimId }));
        Assert.Equal(2, await One<int>("SELECT count(*) FROM history_events WHERE claim_id = @c AND title = 'Claim closed: every benefit line paid or closed'", new { c = c.ClaimId }));
        Assert.Equal(2, await One<int>("SELECT count(*) FROM outbox_events WHERE claim_id = @c AND event_type = 'items_paid'", new { c = c.ClaimId }));
        // The final money: Diane's item and Mark's replacement are paid, the returned item is returned: 100,230.13 + 100,230.14 = 200,460.27 paid; the docs page's figure.
        var paid = await One<decimal>("SELECT sum(amount) FROM payment_items WHERE claim_id = @c AND status = 'paid'", new { c = c.ClaimId });
        Assert.Equal(200_460.27m, paid);
        // The closing letter of the second close has its own key: the first close's letter is not reused (and not sent twice).
        var events = fixture.Get<PaymentEventService>();
        var runIds = await Sql.ListAsync<Guid>("SELECT DISTINCT run_id FROM payment_items WHERE claim_id = @c AND run_id IS NOT NULL ORDER BY 1", new { c = c.ClaimId });
        Assert.Equal(2, runIds.Count);
        var firstRun = await One<Guid>("SELECT run_id FROM payment_items WHERE id = @i", new { i = c.Diane });
        var secondRun = runIds.Single(r => r != firstRun);
        Assert.True(await events.SendClosingLetterAsync(c.ClaimId, firstRun, "event-first"));
        Assert.True(await events.SendClosingLetterAsync(c.ClaimId, secondRun, "event-second"));
        Assert.True(await events.SendClosingLetterAsync(c.ClaimId, secondRun, "event-second"));   // the same workflow again (a retried activity): no third letter
        Assert.Equal(2, await One<int>("SELECT count(*) FROM letters WHERE claim_id = @c AND template_code = 'CLS-LIFE-01'", new { c = c.ClaimId }));
    }

    [PostgresFact]
    public async Task AnAccountTheBankCannotVerifyHoldsTheReplacementAndOpensAWorkItem()
    {
        var c = await ReopenedAsync();
        fixture.Clock.Set(At("2026-10-20T01:15:00Z"));
        var client = fixture.CreateClient();
        var r = await client.PostApiAsync($"/claims/{c.ClaimId}/payees/{c.MarkParty}:update-payment-method", Account("000000000"), Key());   // ends 0000: the stub says closed
        Assert.Equal(201, r.StatusCode);
        var method = Guid.Parse(r.Str("paymentMethod.id")!);
        var wf = "event-test-method-" + method;

        var facts = await Events.BeginMethodAsync(c.ClaimId, method, Guid.NewGuid(), wf, "run-1");
        Assert.Equal((1, "0000"), (facts.Items, facts.AccountLast4));
        var answer = await Events.VerifyAccountAsync(method, 1);
        Assert.False(answer.Ok);   // an ANSWER
        Assert.Equal(1, await Events.RejectAsync(method, answer.Detail, wf));

        Assert.Equal("held", await One<string>("SELECT status FROM payment_items WHERE payment_method_id = @m", new { m = method }));
        Assert.Equal("rejected", await One<string>("SELECT status FROM payment_methods WHERE id = @m", new { m = method }));
        Assert.Equal(1, await One<int>("SELECT count(*) FROM work_items WHERE dedupe_key = 'method-rejected:' || @m AND status = 'open'", new { m = method.ToString() }));
        // A payment run does not pay a held item.
        fixture.Clock.Set(At("2026-10-20T07:00:00Z"));
        var run = await fixture.Get<PaymentRunService>().RunManualAsync(new DateOnly(2026, 10, 20), "run-" + Guid.NewGuid(), "ops");
        Assert.Equal(0, run.Run.ItemCount);
        Assert.Equal("reopened", await One<string>("SELECT status FROM claims WHERE id = @c", new { c = c.ClaimId }));
    }

    [PostgresFact]
    public async Task AClaimThatWasNotClosedIsNotReopenedAndAPaidReplacementIsNotWaitedFor()
    {
        var c = await PaidAsync();
        await ReturnAsync(c.Mark);
        await Returns.ProcessAsync("ops");
        // The payee was quicker than the workflow: the replacement was saved and paid before the reopen step ran.
        fixture.Clock.Set(At("2026-10-14T13:00:00Z"));
        var updated = await fixture.CreateClient().PostApiAsync($"/claims/{c.ClaimId}/payees/{c.MarkParty}:update-payment-method", Account(), Key());
        Assert.Equal(201, updated.StatusCode);
        fixture.Clock.Set(At("2026-10-15T07:00:00Z"));
        await fixture.Get<PaymentRunService>().RunManualAsync(new DateOnly(2026, 10, 15), "run-" + Guid.NewGuid(), "ops");

        var reopen = await Events.ReopenAsync(c.Mark, "event-late");

        Assert.False(reopen.Reopened);   // nothing is owed any more, so the claim is not reopened
        Assert.NotEqual("reopened", await One<string>("SELECT status FROM claims WHERE id = @c", new { c = c.ClaimId }));
    }
}
