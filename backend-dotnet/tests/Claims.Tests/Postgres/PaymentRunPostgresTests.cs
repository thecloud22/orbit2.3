using System.Diagnostics;
using System.Text.Json;
using Claims.Common;
using Claims.Gateway;
using Claims.Payment;
using Claims.Store;
using Claims.Tests.Support;
using Npgsql;

namespace Claims.Tests.Postgres;

/// <summary>
/// REQUIRES POSTGRES. The payment run, a plain batch with no Temporal in sight: the one statement that claims items (and the proof it does not wait
/// on, or double-take, an item another transaction holds), the run pipeline against a stub bank that can fail or return an item, holds, and the
/// immutability of paid items. Business time is frozen at Fri 9 Oct 2026 02:00 Central, the mock's run.
/// </summary>
public class PaymentRunPostgresTests(PaymentRunPostgresTests.Fixture fixture) : IClassFixture<PaymentRunPostgresTests.Fixture>, IAsyncLifetime
{
    public sealed class Fixture : PostgresApiFixture
    {
        protected override string Hint => "paymentrun";

        // The claims are decided on Thu 8 Oct 11:30 (pay date Fri 9 Oct); each test moves the clock to the run.
        protected override DateTimeOffset? ClockStart => DateTimeOffset.Parse("2026-10-08T16:30:00Z", System.Globalization.CultureInfo.InvariantCulture);

        protected override IReadOnlyDictionary<string, string?> Settings { get; } = new Dictionary<string, string?> { ["Claims:Db:DevSeed"] = "true" };
    }

    private static readonly DateTimeOffset Decided = DateTimeOffset.Parse("2026-10-08T16:30:00Z", System.Globalization.CultureInfo.InvariantCulture);
    private static readonly DateTimeOffset RunTime = DateTimeOffset.Parse("2026-10-09T07:00:00Z", System.Globalization.CultureInfo.InvariantCulture);
    private static readonly DateOnly RunDay = new(2026, 10, 9);

    private Db Sql => fixture.Db;
    private PaymentRunService Runs => fixture.Get<PaymentRunService>();
    private StubBankGateway Bank => fixture.Get<StubBankGateway>();
    private IFaultRegistry Faults => fixture.Get<IFaultRegistry>();

    public async ValueTask InitializeAsync()
    {
        if (!PostgresSupport.Available) return;
        // Earlier tests may leave items that never got paid (held, or waiting): take them out of the way, so a run counts only this test's items.
        await Sql.ExecuteAsync("UPDATE payment_items SET status = 'cancelled', hold_reason = NULL WHERE status IN ('cleared', 'held', 'awaiting_proof')");
        foreach (var f in Faults.Active) Faults.Set(f, false);
        fixture.Clock.Set(Decided);
    }

    public ValueTask DisposeAsync() => ValueTask.CompletedTask;

    private static Dictionary<string, string> NewKey() => new() { ["Idempotency-Key"] = "run-" + Guid.NewGuid() };

    private Task<PaymentRunService.Outcome> RunAsync() => Runs.RunManualAsync(RunDay, "run-" + Guid.NewGuid(), "ops");

    private Task<T> One<T>(string sql, object? param = null) => Sql.SingleAsync<T>(sql, param);

    private async Task<ReadyClaim> ApprovedAsync()
    {
        fixture.Clock.Set(Decided);
        var (claim, result) = await LifeScenario.ApprovedAsync(fixture);
        Assert.Equal("recorded", result.Kind);
        return claim;
    }

    private Task<string> ItemStates(Guid claim) => One<string>("SELECT string_agg(status, ',' ORDER BY status) FROM payment_items WHERE claim_id = @c", new { c = claim });

    private Task<Guid> ItemOf(Guid claim, string payee) => One<Guid>(
        "SELECT pi.id FROM payment_items pi JOIN parties p ON p.id = pi.payee_party_id WHERE pi.claim_id = @c AND p.full_name LIKE @n", new { c = claim, n = payee + "%" });

    [PostgresFact]
    public async Task ARunPaysTheClearedItemsWritesTheHistoryAndClosesTheClaim()
    {
        var claim = await ApprovedAsync();
        // A later day than the other tests use, because the manual trigger's default key is the run date: this test is about that default.
        var later = DateTimeOffset.Parse("2026-10-20T07:00:00Z", System.Globalization.CultureInfo.InvariantCulture);
        fixture.Clock.Set(later);
        var client = fixture.CreateClient();

        var r = await client.PostApiAsync("/payment-runs", "{\"runDate\":\"2026-10-20\"}");

        Assert.Equal(201, r.StatusCode);
        Assert.Equal(("reconciled", "manual", 2, 2, 0, "200383.56"), (r.Str("status"), r.Str("trigger"), r.At("itemCount")!.GetValue<int>(), r.At("paidCount")!.GetValue<int>(),
            r.At("returnedCount")!.GetValue<int>(), r.Str("total.amount")));
        Assert.StartsWith("STUB-FILE-20261020-", r.Str("fileReference"), StringComparison.Ordinal);
        Assert.Equal("/payment-runs/" + r.Str("id"), r.Header("Location"));
        Assert.Equal("2026-10-20T07:00:00Z", r.Str("startedAt"));
        var run = Guid.Parse(r.Str("id")!);

        // Items: paid, stamped with the run, with the bank's reference and the run's (business) time.
        Assert.Equal("paid,paid", await ItemStates(claim.ClaimId));
        Assert.Equal(2, await One<int>("SELECT count(*) FROM payment_items WHERE claim_id = @c AND run_id = @r AND payment_reference LIKE 'STUB-EFT-%' AND paid_at = @t", new { c = claim.ClaimId, r = run, t = later }));
        // The claim closed in the same transaction: status, closed_at, lines, the payment_due row, the work queue.
        Assert.Equal("closed", await One<string>("SELECT status FROM claims WHERE id = @c", new { c = claim.ClaimId }));
        Assert.Equal(later, (await Sql.QueryAsync("SELECT closed_at FROM claims WHERE id = @c", new { c = claim.ClaimId }, x => x.Instant("closed_at")))[0]);
        Assert.Equal("paid|closed", string.Join('|', await Sql.ListAsync<string>("SELECT status FROM benefit_lines WHERE claim_id = @c ORDER BY kind", new { c = claim.ClaimId })));
        Assert.Equal("done:payment:Met: paid in the 02:00 run", await One<string>("SELECT state || ':' || closed_by || ':' || result FROM deadlines WHERE claim_id = @c AND kind = 'payment_due'", new { c = claim.ClaimId }));
        Assert.Equal(0, await One<int>("SELECT count(*) FROM work_items WHERE claim_id = @c AND status = 'open'", new { c = claim.ClaimId }));
        // History, and an items_paid event for the confirmation workflow.
        Assert.Equal(["Claim closed: every benefit line paid or closed", "Paid $200,383.56 in the daily payment run", "2 payment items in the 2026-10-20 payment run"],
            await Sql.ListAsync<string>("SELECT title FROM history_events WHERE claim_id = @c AND occurred_at = @t ORDER BY seq DESC", new { c = claim.ClaimId, t = later }));
        Assert.Equal(1, await One<int>("SELECT count(*) FROM outbox_events WHERE claim_id = @c AND event_type = 'items_paid' AND (payload->>'closed')::boolean AND payload->>'runId' = @r", new { c = claim.ClaimId, r = run.ToString() }));
        // The bank saw both payments once, each keyed by its item id.
        var sent = Bank.SentFiles.Single(f => f.RunId == run);
        Assert.Equal(2, sent.Payments.Count);
        Assert.All(sent.Payments, p => Assert.Equal(p.ItemId.ToString(), p.IdempotencyKey));

        // Idempotent per run date: the same click again is the same run, and nothing is sent again.
        var repeat = await client.PostApiAsync("/payment-runs", "{\"runDate\":\"2026-10-20\"}");
        Assert.Equal((200, "true", r.Str("id")), (repeat.StatusCode, repeat.Header("Idempotent-Replayed"), repeat.Str("id")));
        Assert.Equal(1, Bank.SentFiles.Count(f => f.RunId == run));
        // A new key is a new run, and it finds nothing to pay.
        var another = await client.PostApiAsync("/payment-runs", "{\"runDate\":\"2026-10-20\"}", NewKey());
        Assert.Equal((201, 0), (another.StatusCode, another.At("itemCount")!.GetValue<int>()));
        Assert.Equal("reconciled", another.Str("status"));
        Assert.Equal(200, (await client.GetApiAsync("/payment-runs/" + r.Str("id"))).StatusCode);
        var listed = await client.GetApiAsync("/payment-runs");
        Assert.Contains(listed.Items, i => i["id"]!.ToString() == r.Str("id"));
    }

    [PostgresFact]
    public async Task TheRunChecksItsDateAndItsKeyAndTheClaimShowsItsItems()
    {
        var claim = await ApprovedAsync();
        var client = fixture.CreateClient();

        var future = await client.PostApiAsync("/payment-runs", "{\"runDate\":\"2026-10-10\"}");
        Assert.Equal((422, "run_date_in_future"), (future.StatusCode, future.Str("code")));
        var missing = await client.PostApiAsync("/payment-runs", "{}");
        Assert.Equal((422, "validation_failed"), (missing.StatusCode, missing.Str("code")));
        var shortKey = await client.PostApiAsync("/payment-runs", "{\"runDate\":\"2026-10-08\"}", new Dictionary<string, string> { ["Idempotency-Key"] = "abc" });
        Assert.Equal((400, "invalid_idempotency_key"), (shortKey.StatusCode, shortKey.Str("code")));
        // A run dated before the items are due (pay date Fri 9 Oct) does not touch them.
        var early = await client.PostApiAsync("/payment-runs", "{\"runDate\":\"2026-10-08\"}");
        Assert.Equal(0, early.At("itemCount")!.GetValue<int>());
        Assert.Equal("cleared,cleared", await ItemStates(claim.ClaimId));

        var items = await client.GetApiAsync($"/claims/{claim.ClaimId}/payment-items");
        Assert.Equal(["cleared", "cleared"], items.Items.Select(i => i["status"]!.ToString()));
        Assert.Equal(404, (await client.GetApiAsync($"/claims/{Guid.NewGuid()}/payment-items")).StatusCode);
        Assert.Equal(404, (await client.GetApiAsync($"/payment-runs/{Guid.NewGuid()}")).StatusCode);
    }

    [PostgresFact]
    public async Task TheScheduledRunHappensOncePerDateAndAnAttemptToRepeatItDoesNothing()
    {
        var claim = await ApprovedAsync();
        fixture.Clock.Set(RunTime);

        var first = await Runs.RunScheduledAsync(RunDay);
        var second = await Runs.RunScheduledAsync(RunDay);

        Assert.NotNull(first);
        Assert.Null(second);
        Assert.Equal(("schedule", 2, 2), (first.Trigger, first.ItemCount, first.PaidCount));
        Assert.Equal("closed", await One<string>("SELECT status FROM claims WHERE id = @c", new { c = claim.ClaimId }));
        Assert.Equal(1, await One<int>("SELECT count(*) FROM payment_runs WHERE run_date = @d AND trigger = 'schedule'", new { d = RunDay }));
        // Nothing here started a workflow: the run does not depend on Temporal (the tests run with no Temporal at all).
        Assert.DoesNotContain(fixture.Launcher.StartedEvents, e => e.EventType == "items_paid" && e.ClaimId == claim.ClaimId);
    }

    [PostgresFact]
    public async Task ConcurrentRunsNeverTakeTheSameItemAndEveryItemIsPaidOnce()
    {
        var claims = new List<ReadyClaim>();
        for (var i = 0; i < 12; i++) claims.Add(await ApprovedAsync());
        fixture.Clock.Set(RunTime);
        var sentBefore = Bank.SentFiles.Count;

        var runs = await Task.WhenAll(Enumerable.Range(0, 6).Select(i => Task.Run(() => Runs.RunManualAsync(RunDay, "concurrent-" + i + "-" + Guid.NewGuid(), "ops"))));

        Assert.Equal(24, runs.Sum(r => r.Run.ItemCount));
        Assert.Equal(24, runs.Sum(r => r.Run.PaidCount));
        // Every claim is closed, even those whose two items were taken by two different runs (the closing race, see PaymentRepository.LockClaimsAsync).
        foreach (var c in claims) Assert.Equal("closed", await One<string>("SELECT status FROM claims WHERE id = @c", new { c = c.ClaimId }));
        // Each item belongs to exactly one run and reached the bank exactly once.
        var sent = Bank.SentFiles.Skip(sentBefore).SelectMany(f => f.Payments).Select(p => p.ItemId).ToList();
        Assert.Equal(24, sent.Count);
        Assert.Equal(24, sent.Distinct().Count());
        Assert.Equal(24, await One<int>("SELECT count(*) FROM payment_items WHERE status = 'paid' AND run_id = ANY (cast(@r as uuid[]))", new { r = Db.ArrayLiteral(runs.Select(r => r.Run.Id.ToString())) }));
    }

    [PostgresFact]
    public async Task ARowAnotherTransactionHoldsIsSkippedNotWaitedOnAndWithoutSkipLockedTheSameStatementBlocks()
    {
        var claim = await ApprovedAsync();
        var held = await ItemOf(claim.ClaimId, "Diane");
        var free = await ItemOf(claim.ClaimId, "Mark");
        var run = await One<Guid>("INSERT INTO payment_runs (run_date, trigger) VALUES (@d, 'manual') RETURNING id", new { d = RunDay });
        var runB = await One<Guid>("INSERT INTO payment_runs (run_date, trigger) VALUES (@d, 'manual') RETURNING id", new { d = RunDay });

        // Connection A takes a row lock on Diane's item and keeps it (an open transaction, as a concurrent run would).
        await using var a = await Sql.DataSource.OpenConnectionAsync();
        await using var txA = await a.BeginTransactionAsync();
        await using (var lockIt = new NpgsqlCommand("SELECT id FROM payment_items WHERE id = @id FOR UPDATE", a, txA))
        {
            lockIt.Parameters.AddWithValue("id", held);
            await lockIt.ExecuteScalarAsync();
        }

        // The real statement on connection B returns at once with the free item only.
        await using (var b = await Sql.DataSource.OpenConnectionAsync())
        await using (var txB = await b.BeginTransactionAsync())
        {
            var clock = Stopwatch.StartNew();
            var taken = await ClaimAsync(b, txB, PaymentRepository.ClaimClearedSql, run);
            Assert.Equal([free], taken);
            Assert.True(clock.Elapsed < TimeSpan.FromSeconds(3), $"the claim statement waited {clock.Elapsed}");
            await txB.RollbackAsync();
        }

        // NEGATIVE CONTROL: the identical statement with SKIP LOCKED removed waits on the held row (here it gives up after 500 ms).
        var withoutSkipLocked = PaymentRepository.ClaimClearedSql.Replace("SKIP LOCKED", "", StringComparison.Ordinal);
        Assert.NotEqual(PaymentRepository.ClaimClearedSql, withoutSkipLocked);
        await using (var b = await Sql.DataSource.OpenConnectionAsync())
        await using (var txB = await b.BeginTransactionAsync())
        {
            await using (var timeout = new NpgsqlCommand("SET LOCAL lock_timeout = '500ms'", b, txB)) await timeout.ExecuteNonQueryAsync();
            var e = await Assert.ThrowsAsync<PostgresException>(() => ClaimAsync(b, txB, withoutSkipLocked, runB));
            Assert.Equal("55P03", e.SqlState);   // lock_not_available: it blocked on the row connection A holds
        }

        await txA.RollbackAsync();
        // With the lock gone the real statement takes both.
        await using var c = await Sql.DataSource.OpenConnectionAsync();
        await using var txC = await c.BeginTransactionAsync();
        Assert.Equal(2, (await ClaimAsync(c, txC, PaymentRepository.ClaimClearedSql, run)).Count);
        await txC.RollbackAsync();
    }

    private static async Task<List<Guid>> ClaimAsync(NpgsqlConnection connection, NpgsqlTransaction tx, string sql, Guid run)
    {
        await using var command = new NpgsqlCommand(sql.Replace("@runDate", "@rd", StringComparison.Ordinal).Replace("@run", "@r", StringComparison.Ordinal), connection, tx);
        command.Parameters.AddWithValue("rd", NpgsqlTypes.NpgsqlDbType.Date, RunDay);
        command.Parameters.AddWithValue("r", run);
        var ids = new List<Guid>();
        await using var reader = await command.ExecuteReaderAsync();
        while (await reader.ReadAsync()) ids.Add(reader.GetGuid(0));
        return ids;
    }

    [PostgresFact]
    public async Task PaidItemsNeverChangeAgainAndOnlyTheBankCanReturnOne()
    {
        var claim = await ApprovedAsync();
        fixture.Clock.Set(RunTime);
        await RunAsync();
        var item = await ItemOf(claim.ClaimId, "Diane");

        foreach (var sql in new[]
                 {
                     "UPDATE payment_items SET principal_amount = principal_amount + 1 WHERE id = @id",
                     "UPDATE payment_items SET interest_amount = 0 WHERE id = @id",
                     "UPDATE payment_items SET payee_party_id = (SELECT id FROM parties WHERE full_name = 'Mark Castellano' LIMIT 1) WHERE id = @id",
                     "UPDATE payment_items SET method = 'check' WHERE id = @id",
                     "UPDATE payment_items SET pay_on = pay_on + 1 WHERE id = @id",
                     "UPDATE payment_items SET payment_reference = 'edited' WHERE id = @id",
                     "UPDATE payment_items SET paid_at = paid_at + interval '1 day' WHERE id = @id",
                     "UPDATE payment_items SET run_id = NULL, status = 'cleared', paid_at = NULL WHERE id = @id",
                     "UPDATE payment_items SET status = 'held', hold_reason = 'x', paid_at = NULL WHERE id = @id",
                 })
        {
            var e = await Assert.ThrowsAsync<PostgresException>(() => Sql.ExecuteAsync(sql, new { id = item }));
            Assert.Equal("23000", e.SqlState);
        }
        Assert.Equal("paid", await One<string>("SELECT status FROM payment_items WHERE id = @id", new { id = item }));
        Assert.Equal("100191.78", await One<string>("SELECT amount::text FROM payment_items WHERE id = @id", new { id = item }));

        // The one thing that can happen to a paid item: the bank returns it. It is then final; a fix is a new item, never an edit.
        await Sql.ExecuteAsync("UPDATE payment_items SET status = 'returned', return_code = 'R02', return_reason = 'Account closed' WHERE id = @id", new { id = item });
        var final = await Assert.ThrowsAsync<PostgresException>(() => Sql.ExecuteAsync("UPDATE payment_items SET status = 'paid' WHERE id = @id", new { id = item }));
        Assert.Contains("final", final.Message, StringComparison.Ordinal);
        Assert.Equal("100191.78", await One<string>("SELECT amount::text FROM payment_items WHERE id = @id", new { id = item }));
    }

    [PostgresFact]
    public async Task AHeldItemIsSkippedByTheRunKeepsTheClaimOpenAndIsPaidOnceReleased()
    {
        var claim = await ApprovedAsync();
        var client = fixture.CreateClient();
        var diane = await ItemOf(claim.ClaimId, "Diane");
        var version = await One<long>("SELECT version FROM payment_items WHERE id = @id", new { id = diane });

        Assert.Equal(428, (await client.PostApiAsync($"/payment-items/{diane}:hold", "{\"reason\":\"Sanctions review\"}")).StatusCode);
        var noReason = await client.PostApiAsync($"/payment-items/{diane}:hold", "{}", new Dictionary<string, string> { ["If-Match"] = $"\"{version}\"" });
        Assert.Equal((422, "reason_required"), (noReason.StatusCode, noReason.Str("code")));
        var stale = await client.PostApiAsync($"/payment-items/{diane}:hold", "{\"reason\":\"x\"}", new Dictionary<string, string> { ["If-Match"] = "\"77\"" });
        Assert.Equal((412, "version_conflict"), (stale.StatusCode, stale.Str("code")));
        var held = await client.PostApiAsync($"/payment-items/{diane}:hold", "{\"reason\":\"Sanctions review\"}", new Dictionary<string, string> { ["If-Match"] = $"\"{version}\"", ["X-Actor"] = "rachel" });
        Assert.Equal(200, held.StatusCode);
        Assert.Equal(("held", "Sanctions review", $"\"{version + 1}\""), (held.Str("status"), held.Str("holdReason"), held.Header("ETag")));

        fixture.Clock.Set(RunTime);
        var run = await client.PostApiAsync("/payment-runs", "{\"runDate\":\"2026-10-09\"}", NewKey());
        Assert.Equal((1, 1), (run.At("itemCount")!.GetValue<int>(), run.At("paidCount")!.GetValue<int>()));
        Assert.Equal("held,paid", await ItemStates(claim.ClaimId));
        Assert.Equal("paying", await One<string>("SELECT status FROM claims WHERE id = @c", new { c = claim.ClaimId }));   // not closed while an item is unpaid
        Assert.Equal("approved", await One<string>("SELECT status FROM benefit_lines WHERE id = @l", new { l = claim.BaseLineId }));
        Assert.Equal("open", await One<string>("SELECT state FROM deadlines WHERE claim_id = @c AND kind = 'payment_due'", new { c = claim.ClaimId }));

        // Release it (a held item can only be released; a paid one cannot be held).
        var release = await client.PostApiAsync($"/payment-items/{diane}:release", null, new Dictionary<string, string> { ["If-Match"] = held.Header("ETag")! });
        Assert.Equal((200, "cleared", true), (release.StatusCode, release.Str("status"), release.At("holdReason") is null));
        var releaseAgain = await client.PostApiAsync($"/payment-items/{diane}:release", null, new Dictionary<string, string> { ["If-Match"] = release.Header("ETag")! });
        Assert.Equal((409, "invalid_state"), (releaseAgain.StatusCode, releaseAgain.Str("code")));
        var mark = await ItemOf(claim.ClaimId, "Mark");
        var holdPaid = await client.PostApiAsync($"/payment-items/{mark}:hold", "{\"reason\":\"too late\"}",
            new Dictionary<string, string> { ["If-Match"] = $"\"{await One<long>("SELECT version FROM payment_items WHERE id = @id", new { id = mark })}\"" });
        Assert.Equal((409, "invalid_state"), (holdPaid.StatusCode, holdPaid.Str("code")));

        var second = await client.PostApiAsync("/payment-runs", "{\"runDate\":\"2026-10-09\"}", new Dictionary<string, string> { ["Idempotency-Key"] = "after-release-" + Guid.NewGuid() });
        Assert.Equal(1, second.At("paidCount")!.GetValue<int>());
        Assert.Equal("paid,paid", await ItemStates(claim.ClaimId));
        Assert.Equal("closed", await One<string>("SELECT status FROM claims WHERE id = @c", new { c = claim.ClaimId }));
        Assert.Equal("done", await One<string>("SELECT state FROM deadlines WHERE claim_id = @c AND kind = 'payment_due'", new { c = claim.ClaimId }));
    }

    [PostgresFact]
    public async Task AHoldThatArrivesAfterTheItemIsInARunIsRefusedAndBecomesARecoveryTask()
    {
        var claim = await ApprovedAsync();
        var diane = await ItemOf(claim.ClaimId, "Diane");
        var run = await One<Guid>("INSERT INTO payment_runs (run_date, trigger) VALUES (@d, 'manual') RETURNING id", new { d = RunDay });
        await Sql.ExecuteAsync("UPDATE payment_items SET status = 'in_run', run_id = @r WHERE id = @id", new { r = run, id = diane });
        var staleVersion = 0;   // the client read the item before the run took it

        var r = await fixture.CreateClient().PostApiAsync($"/payment-items/{diane}:hold", "{\"reason\":\"Payee reported fraud\"}",
            new Dictionary<string, string> { ["If-Match"] = $"\"{staleVersion}\"", ["X-Actor"] = "rachel" });

        Assert.Equal((409, "item_in_run"), (r.StatusCode, r.Str("code")));
        Assert.Equal("in_run", await One<string>("SELECT status FROM payment_items WHERE id = @id", new { id = diane }));   // the run's item is untouched
        Assert.Equal("Recover a payment that is already in a run|payments|open", await One<string>(
            "SELECT action || '|' || section || '|' || status FROM work_items WHERE dedupe_key = @k", new { k = "hold-recovery:" + diane }));
        // Put it back so later tests' runs are not confused by it.
        await Sql.ExecuteAsync("UPDATE payment_items SET status = 'cancelled', run_id = NULL WHERE id = @id", new { id = diane });
    }

    [PostgresFact]
    public async Task IfTheBankCannotBeReachedTheRunFailsItsItemsGoBackAndTheNextRunPaysThem()
    {
        var claim = await ApprovedAsync();
        fixture.Clock.Set(RunTime);
        Faults.Set("bank.down", true);

        var failed = await Runs.RunManualAsync(RunDay, "bank-down-" + Guid.NewGuid(), "ops");

        Assert.Equal("failed", failed.Run.Status);
        Assert.Contains("unreachable", failed.Run.Error, StringComparison.Ordinal);
        Assert.Equal("cleared,cleared", await ItemStates(claim.ClaimId));
        Assert.Equal(0, await One<int>("SELECT count(*) FROM payment_items WHERE claim_id = @c AND run_id IS NOT NULL", new { c = claim.ClaimId }));
        Assert.Equal("approved", await One<string>("SELECT status FROM claims WHERE id = @c", new { c = claim.ClaimId }));
        Assert.Equal(1, await One<int>("SELECT count(*) FROM history_events WHERE claim_id = @c AND title LIKE 'Payment run % failed%'", new { c = claim.ClaimId }));

        Faults.Set("bank.down", false);
        var ok = await Runs.RunManualAsync(RunDay, "bank-back-" + Guid.NewGuid(), "ops");
        Assert.Equal(("reconciled", 2), (ok.Run.Status, ok.Run.PaidCount));
        Assert.Equal("closed", await One<string>("SELECT status FROM claims WHERE id = @c", new { c = claim.ClaimId }));
    }

    [PostgresFact]
    public async Task IfTheBankReturnsAnItemItIsMarkedReturnedAndTheClaimStaysOpen()
    {
        var claim = await ApprovedAsync();
        fixture.Clock.Set(RunTime);
        var mark = await ItemOf(claim.ClaimId, "Mark");
        Bank.RejectItem(mark, "R02", "Account closed");

        var run = await RunAsync();

        Assert.Equal(("reconciled", 1, 1), (run.Run.Status, run.Run.PaidCount, run.Run.ReturnedCount));
        Assert.Equal("paid,returned", await ItemStates(claim.ClaimId));
        Assert.Equal("R02|Account closed", await One<string>("SELECT return_code || '|' || return_reason FROM payment_items WHERE id = @id", new { id = mark }));
        Assert.Equal("paying", await One<string>("SELECT status FROM claims WHERE id = @c", new { c = claim.ClaimId }));
        Assert.Equal("open", await One<string>("SELECT state FROM deadlines WHERE claim_id = @c AND kind = 'payment_due'", new { c = claim.ClaimId }));
        Assert.Equal(1, await One<int>("SELECT count(*) FROM history_events WHERE claim_id = @c AND title LIKE 'Payment returned by the bank: Mark%'", new { c = claim.ClaimId }));
        Assert.Equal("Payment returned: Mark|payments", await One<string>("SELECT action || '|' || section FROM work_items WHERE dedupe_key = @k", new { k = "payment-returned:" + mark }));
        // Only the paid payee gets a payment confirmation event; the claim is not closed.
        Assert.Equal(1, await One<int>("SELECT count(*) FROM outbox_events WHERE claim_id = @c AND event_type = 'items_paid' AND NOT (payload->>'closed')::boolean", new { c = claim.ClaimId }));
        Assert.Equal(JsonValueKind.Array, JsonDocument.Parse(await One<string>("SELECT payload->'itemIds' FROM outbox_events WHERE claim_id = @c AND event_type = 'items_paid'", new { c = claim.ClaimId })).RootElement.ValueKind);
    }
}
