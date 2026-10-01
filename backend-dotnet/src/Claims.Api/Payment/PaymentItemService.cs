using Claims.Clock;
using Claims.Common;
using Claims.Store;
using Claims.View;

namespace Claims.Payment;

/// <summary>
/// Holding and releasing a payment item. Only the payment run touches an item that is `in_run`; a hold that arrives after that cannot stop it and
/// becomes a recovery work item instead (409 item_in_run). A held item is not selected by any run, so it also keeps its claim from closing.
/// </summary>
public sealed class PaymentItemService(Db db, IClock clock, BusinessCalendar calendar, PaymentRepository payments, HistoryRepository history,
                                       WorkItemRepository workItems, ClaimQueries queries)
{
    private sealed record Outcome(PaymentItemView? Item, ApiException? Error);

    public async Task<PaymentItemView> HoldAsync(Guid id, long ifMatch, string? reason, Actor actor)
    {
        if (string.IsNullOrWhiteSpace(reason)) throw ApiException.Unprocessable("reason_required", "Holding a payment item needs a reason");
        // The recovery work item must be committed even though the request fails, so the error is raised after the transaction.
        var outcome = await db.InTransactionAsync(async () =>
        {
            var item = await payments.LockItemAsync(id) ?? throw ApiException.NotFound("Payment item", id);
            var now = clock.UtcNow;
            if (item.Status == "in_run")
            {
                var owner = await db.SingleOrDefaultAsync<Guid?>("SELECT owner_id FROM claims WHERE id = @c", new { c = item.ClaimId });
                await workItems.InsertOnceAsync("hold-recovery:" + id, owner, item.ClaimId, 1, "Recover a payment that is already in a run",
                    $"{actor.Name} asked to hold item {id} after it went to the bank; only the payment run may touch it. Ask the bank to recall it. Reason: {reason.Trim()}",
                    calendar.LocalDate(now), "You", "payments", "workflow", null);
                await history.AppendAsync(item.ClaimId, now, "task", "Hold refused: the payment item is already in a run", actor, reason.Trim(), id.ToString(), null);
                return new Outcome(null, ApiException.Conflict("item_in_run", "The payment item is in a payment run and cannot be held; a recovery task was opened"));
            }
            if (item.Version != ifMatch) throw ApiException.VersionConflict("Payment item " + id);
            if (item.Status is not ("awaiting_proof" or "cleared"))
                throw ApiException.Conflict("invalid_state", "Only an item that has not reached a run can be held; this one is " + item.Status);
            await payments.HoldAsync(id, reason.Trim());
            await history.AppendAsync(item.ClaimId, now, "payment", "Payment item held", actor, reason.Trim(), id.ToString(), null);
            return new Outcome((await queries.PaymentItemAsync(id))!, null);
        });
        return outcome.Error is not null ? throw outcome.Error : outcome.Item!;
    }

    public Task<PaymentItemView> ReleaseAsync(Guid id, long ifMatch, Actor actor) => db.InTransactionAsync(async () =>
    {
        var item = await payments.LockItemAsync(id) ?? throw ApiException.NotFound("Payment item", id);
        if (item.Version != ifMatch) throw ApiException.VersionConflict("Payment item " + id);
        if (item.Status != "held") throw ApiException.Conflict("invalid_state", "Only a held item can be released; this one is " + item.Status);
        await payments.ReleaseAsync(id);
        await history.AppendAsync(item.ClaimId, clock.UtcNow, "payment", "Payment item released", actor, null, id.ToString(), null);
        return (await queries.PaymentItemAsync(id))!;
    });
}
