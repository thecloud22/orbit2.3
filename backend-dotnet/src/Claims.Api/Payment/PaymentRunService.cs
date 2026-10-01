using System.Globalization;
using Claims.Clock;
using Claims.Common;
using Claims.Domain;
using Claims.Gateway;
using Claims.Store;
using Claims.View;

namespace Claims.Payment;

/// <summary>
/// The daily payment run: a plain batch, NOT a Temporal workflow (a batch is a query, a file and a status update; Temporal adds nothing and would
/// make paying depend on it). Three steps, because no database transaction may stay open across a call to the bank:
///
///   A (one transaction) create the run, claim every `cleared` item due on or before the run date in ONE statement
///                       (cleared -> in_run, stamped with the run id, FOR UPDATE SKIP LOCKED), claims -> paying, history.
///   B                   send the file to the bank. The payment item id is the idempotency key.
///   C (one transaction) mark items paid or returned, lines paid, close every claim whose items are all paid (status, closed_at, the payment_due
///                       row, open work items, history) and write an `items_paid` outbox event per claim.
///
/// If the bank cannot be reached the items go back to `cleared` and the run is `failed`. Paid items are never edited afterwards.
/// A process that dies between A and C leaves items `in_run` and the run `building`: finding and finishing those is operations work (not built).
/// </summary>
public sealed partial class PaymentRunService(Db db, IClock clock, BusinessCalendar calendar, PaymentRepository payments, HistoryRepository history,
                                              DeadlineRepository deadlines, WorkItemRepository workItems, OutboxRepository outbox, IBankGateway bank,
                                              ClaimQueries queries, ILogger<PaymentRunService> log)
{
    public sealed record Outcome(PaymentRunView Run, bool Replayed);

    /// <summary>Manual trigger. The key defaults to the run date, so a second click for the same date returns the first run.</summary>
    public async Task<Outcome> RunManualAsync(DateOnly runDate, string? idempotencyKey, string actorName)
    {
        var today = calendar.LocalDate(clock.UtcNow);
        if (runDate > today) throw ApiException.Unprocessable("run_date_in_future", $"A run cannot be dated after the business date ({Iso(today)})");
        var key = string.IsNullOrWhiteSpace(idempotencyKey) ? "manual-" + Iso(runDate) : idempotencyKey;
        if (key.Length is < 8 or > 128) throw ApiException.BadRequest("invalid_idempotency_key", "Idempotency-Key must be 8 to 128 characters");

        var actor = Actor.User(actorName);
        var started = await db.InTransactionAsync(async () =>
        {
            var id = await payments.InsertManualRunAsync(runDate, key);
            return id is null ? null : await StartAsync(id.Value, runDate, actor);
        });
        if (started is null)
        {
            var existing = await payments.RunByKeyAsync(key) ?? throw new InvalidOperationException("Run for key " + key + " vanished");
            return new Outcome((await queries.PaymentRunAsync(existing))!, true);
        }
        await FinishAsync(started, actor);
        return new Outcome((await queries.PaymentRunAsync(started.RunId))!, false);
    }

    /// <summary>The daily trigger: one scheduled run per business date. Returns null when that date's run already exists.</summary>
    public async Task<PaymentRunView?> RunScheduledAsync(DateOnly runDate)
    {
        var actor = Actor.Batch("payment run");
        var started = await db.InTransactionAsync(async () =>
        {
            var id = await payments.InsertScheduledRunAsync(runDate);
            return id is null ? null : await StartAsync(id.Value, runDate, actor);
        });
        if (started is null) return null;
        await FinishAsync(started, actor);
        return await queries.PaymentRunAsync(started.RunId);
    }

    // ------------------------------------------------------------------ step A

    private sealed record Started(Guid RunId, DateOnly RunDate, IReadOnlyList<PaymentRepository.RunItem> Items);

    private async Task<Started> StartAsync(Guid runId, DateOnly runDate, Actor actor)
    {
        var now = clock.UtcNow;
        await payments.SetRunStartedAsync(runId, now);
        var claimed = await payments.ClaimClearedAsync(runId, runDate);
        var items = claimed.Count == 0 ? [] : await payments.ItemsOfRunAsync(runId);
        await payments.SetRunTotalsAsync(runId, items.Count, items.Sum(i => i.Amount));
        if (items.Count == 0)
        {
            await payments.FinishRunAsync(runId, "reconciled", null, 0, 0, null, now);
            return new Started(runId, runDate, items);
        }
        var claimIds = items.Select(i => i.ClaimId).Distinct().ToList();
        await payments.LockClaimsAsync(claimIds);
        await payments.SetClaimsPayingAsync(claimIds);
        foreach (var c in claimIds)
        {
            var mine = items.Where(i => i.ClaimId == c).ToList();
            await history.AppendAsync(c, now, "payment", $"{mine.Count} payment items in the {Iso(runDate)} payment run", actor,
                $"{PaymentRules.Usd(mine.Sum(i => i.Amount))} · run {runId}", null, null);
        }
        return new Started(runId, runDate, items);
    }

    // ------------------------------------------------------------------ steps B and C

    private async Task FinishAsync(Started s, Actor actor)
    {
        if (s.Items.Count == 0) return;
        BankFileResult result;
        try
        {
            result = await bank.SendPaymentFileAsync(new BankFile(s.RunId, s.RunDate,
                [.. s.Items.Select(i => new BankPayment(i.Id, i.Id.ToString(), i.PayeeName, i.Amount, i.Currency, i.Method))]));
        }
        catch (Exception e) when (e is not OperationCanceledException)
        {
            LogBankFailed(s.RunId, e.Message);
            await db.InTransactionAsync(() => FailAsync(s, e.Message, actor));
            return;
        }
        await db.InTransactionAsync(() => ReconcileAsync(s, result, actor));
    }

    private async Task FailAsync(Started s, string error, Actor actor)
    {
        var now = clock.UtcNow;
        await payments.ReleaseRunAsync(s.RunId);
        await payments.FinishRunAsync(s.RunId, "failed", null, 0, 0, error, now);
        var claimIds = s.Items.Select(i => i.ClaimId).Distinct().Order().ToList();
        await payments.LockClaimsAsync(claimIds);
        foreach (var c in claimIds)
        {
            await payments.SetClaimApprovedAgainAsync(c);
            await history.AppendAsync(c, now, "payment", $"Payment run {Iso(s.RunDate)} failed: the bank could not be reached", actor,
                $"{error} · the items are cleared again for the next run", null, null);
        }
    }

    private async Task ReconcileAsync(Started s, BankFileResult result, Actor actor)
    {
        var now = clock.UtcNow;
        var answers = result.Payments.ToDictionary(p => p.ItemId);
        int paid = 0, returned = 0;

        // Claim by claim, in id order, each claim locked before its items are touched (see PaymentRepository.LockClaimsAsync): a claim whose items
        // are split across two concurrent runs is closed by whichever run finishes last, never by neither.
        foreach (var claimGroup in s.Items.Where(i => answers.ContainsKey(i.Id)).GroupBy(i => i.ClaimId).OrderBy(g => g.Key))
        {
            var claimId = claimGroup.Key;
            await payments.LockClaimsAsync([claimId]);
            var ok = new List<(PaymentRepository.RunItem Item, BankPaymentResult Answer)>();
            var bad = new List<(PaymentRepository.RunItem Item, BankPaymentResult Answer)>();
            foreach (var item in claimGroup)
            {
                var a = answers[item.Id];   // an item the bank did not answer for stays in_run, for operations to chase
                if (a.Accepted)
                {
                    await payments.MarkPaidAsync(item.Id, s.RunId, a.PaymentReference ?? result.FileReference, now);
                    ok.Add((item, a));
                    paid++;
                }
                else
                {
                    await payments.MarkReturnedAsync(item.Id, s.RunId, a.ReturnCode ?? "R99", a.ReturnReason ?? "Returned by the bank");
                    bad.Add((item, a));
                    returned++;
                }
            }
            var claim = await db.QuerySingleAsync("SELECT claim_number, owner_id FROM claims WHERE id = @c", new { c = claimId },
                r => (Number: r.Text("claim_number"), Owner: r.GuidOrNull("owner_id")));
            if (ok.Count > 0)
                await history.AppendAsync(claimId, now, "payment", $"Paid {PaymentRules.Usd(ok.Sum(x => x.Item.Amount))} in the daily payment run", actor,
                    string.Join(" · ", ok.Select(x => $"{x.Item.PayeeName} {PaymentRules.Usd(x.Item.Amount)} by {x.Item.Method.ToUpperInvariant()} ({x.Answer.PaymentReference})")), null, null);
            foreach (var (item, a) in bad)
            {
                await history.AppendAsync(claimId, now, "payment", $"Payment returned by the bank: {item.PayeeName} {PaymentRules.Usd(item.Amount)}", actor,
                    $"{a.ReturnCode} {a.ReturnReason} · the item is returned; a replacement item is a new item", null, null);
                await workItems.InsertOnceAsync("payment-returned:" + item.Id, claim.Owner, claimId, 1, "Payment returned: " + LifeName(item.PayeeName),
                    $"{PaymentRules.Usd(item.Amount)} came back from the bank ({a.ReturnCode} {a.ReturnReason})", calendar.LocalDate(now), "You", "payments", "workflow", null);
            }

            await payments.MarkPaidLinesAsync(claimId);
            var closed = await payments.TryCloseClaimAsync(claimId, now);
            if (closed)
            {
                var when = TimeZoneInfo.ConvertTime(now, calendar.Zone).ToString("HH:mm", CultureInfo.InvariantCulture);
                await deadlines.CloseLiveByKindAsync(claimId, [DeadlineKind.PaymentDue], DeadlineState.Done, "payment", $"Met: paid in the {when} run", now);
                await workItems.CompleteOpenForClaimAsync(claimId, null, now);
                await history.AppendAsync(claimId, now, "data", "Claim closed: every benefit line paid or closed", Actor.System("payment run"),
                    $"Run {s.RunId} · interest is flagged for the January 1099-INT batch", null, null);
            }
            if (ok.Count > 0)
                await outbox.InsertAsync(claimId, "items_paid", Json.Serialize(new
                {
                    claimId = claimId.ToString(),
                    claimNumber = claim.Number,
                    runId = s.RunId.ToString(),
                    closed,
                    itemIds = ok.Select(x => x.Item.Id.ToString()).ToList(),
                }));
        }
        var settled = paid + returned == s.Items.Count;
        await payments.FinishRunAsync(s.RunId, settled ? "reconciled" : "sent", result.FileReference, paid, returned, null, now);
    }

    private static string LifeName(string full) => Intake.LifeIntakeRules.First(full);

    private static string Iso(DateOnly d) => d.ToString("yyyy-MM-dd", CultureInfo.InvariantCulture);

    [LoggerMessage(Level = LogLevel.Warning, Message = "Payment run {RunId}: the bank could not be reached: {Error}")]
    private partial void LogBankFailed(Guid runId, string error);
}
