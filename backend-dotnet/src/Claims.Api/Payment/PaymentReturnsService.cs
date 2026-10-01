using Claims.Clock;
using Claims.Common;
using Claims.Gateway;
using Claims.Store;
using Claims.View;

namespace Claims.Payment;

/// <summary>
/// The returns batch: a plain batch, NOT a Temporal workflow, and it NEVER changes a claim. It reads what the bank's returns file holds (<see cref="IBankGateway.ReadReturnsAsync"/>:
/// payments the bank took and later returned, with an R-code), and for each item that is `paid`, in ONE transaction:
///
///   * the item becomes `returned` with the code and reason (the original stays as it was: a trigger freezes everything else, a replacement is a NEW item),
///   * a payment-method hold is recorded on that payee's closed account (a payment run leaves items that pay to it alone),
///   * the history says so, and an outbox event `payment_returned` is written.
///
/// The claim side (reopening it, asking the payee, telling the examiner, the deadline row) is <c>PaymentReturnedWorkflow</c>'s job, started from that event.
///
/// The items are locked with <c>FOR UPDATE SKIP LOCKED</c> (<see cref="PaymentRepository.LockPaidForReturnSql"/>): two batches at the same time never process the same return, and once one
/// has committed the item is `returned` and no longer matches. Returns are acknowledged to the bank only after the commit, so a crash between the two re-reads them, and processing them
/// again changes nothing.
/// </summary>
public sealed class PaymentReturnsService(Db db, IClock clock, PaymentRepository payments, HistoryRepository history, OutboxRepository outbox, IBankGateway bank)
{
    public async Task<ReturnsProcessedView> ProcessAsync(string actorName)
    {
        var readAt = clock.UtcNow;
        var returns = await bank.ReadReturnsAsync();
        var first = returns.GroupBy(r => r.ItemId).ToDictionary(g => g.Key, g => g.OrderBy(r => r.QueuedAt).First());
        var processed = new List<ReturnProcessedView>();
        var skipped = new List<ReturnSkippedView>();
        var acknowledge = new List<Guid>();
        if (returns.Count == 0) return new ReturnsProcessedView(readAt, 0, processed, skipped);
        var actor = Actor.Batch("returns job");

        await db.InTransactionAsync(async () =>
        {
            var now = clock.UtcNow;
            var locked = await payments.LockPaidForReturnAsync(first.Keys);
            foreach (var item in locked)
            {
                var r = first[item.Id];
                var reason = string.IsNullOrWhiteSpace(r.ReasonText) ? null : r.ReasonText.Trim();
                if (!await payments.MarkReturnedAfterPaidAsync(item.Id, r.ReasonCode, reason)) continue;   // cannot happen under the lock; kept as a guard
                var label = (r.ReasonCode + " " + reason).Trim();
                await payments.InsertHoldAsync(item.ClaimId, item.PayeePartyId, item.Id, label, now);
                await history.AppendAsync(item.ClaimId, now, "payment", $"Payment returned by the bank: {item.PayeeName} {PaymentRules.Usd(item.Amount)}", actor,
                    $"{label} · the item is now returned (it stays as it was paid; a replacement is a new item) · a hold is recorded on the closed account", item.Id.ToString(), null);
                var eventId = await outbox.InsertAsync(item.ClaimId, "payment_returned", Json.Serialize(new
                {
                    claimId = item.ClaimId.ToString(),
                    paymentItemId = item.Id.ToString(),
                    payeePartyId = item.PayeePartyId.ToString(),
                    returnCode = r.ReasonCode,
                    returnReason = reason,
                }));
                processed.Add(new ReturnProcessedView(item.Id, item.ClaimId, item.PayeeName, Money.Of(item.Amount, item.Currency), r.ReasonCode, reason, eventId));
            }
            var lockedIds = locked.Select(i => i.Id).ToHashSet();
            var others = first.Keys.Where(k => !lockedIds.Contains(k)).ToList();
            var statuses = others.Count == 0 ? [] : await payments.StatusesAsync(others);
            foreach (var id in others)
            {
                if (!statuses.TryGetValue(id, out var status)) skipped.Add(new ReturnSkippedView(id, "not_found"));
                else if (status == "paid") skipped.Add(new ReturnSkippedView(id, "locked_by_another_batch"));   // paid, but another transaction holds it: it is being processed
                else skipped.Add(new ReturnSkippedView(id, "not_paid"));
            }
            // What is settled is acknowledged; what could not be processed yet (locked, not paid yet) stays in the bank's queue for the next batch.
            foreach (var p in processed) acknowledge.AddRange(returns.Where(r => r.ItemId == p.PaymentItemId).Select(r => r.ReturnId));
            foreach (var s in skipped.Where(s => s.Reason == "not_found" || (s.Reason == "not_paid" && statuses.GetValueOrDefault(s.PaymentItemId) == "returned")))
                acknowledge.AddRange(returns.Where(r => r.ItemId == s.PaymentItemId).Select(r => r.ReturnId));
        });
        if (acknowledge.Count > 0) await bank.AcknowledgeReturnsAsync(acknowledge);
        _ = actorName;   // the batch is the actor in the history; who pressed the button is not part of the audit line of a batch job
        return new ReturnsProcessedView(readAt, returns.Count, processed, skipped);
    }
}
