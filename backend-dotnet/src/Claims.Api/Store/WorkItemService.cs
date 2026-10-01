using Claims.Clock;
using Claims.Common;
using Claims.View;

namespace Claims.Store;

/// <summary>A person completing an item in their queue directly (the other way items close is as a side effect of the action they point at).</summary>
public sealed class WorkItemService(Db db, IClock clock, WorkItemRepository workItems, DeadlineRepository deadlines, HistoryRepository history, ClaimQueries queries)
{
    public Task<WorkItemView> CompleteAsync(Guid id, long ifMatch, Actor actor) => db.InTransactionAsync(async () =>
    {
        var item = await workItems.LockAsync(id) ?? throw ApiException.NotFound("Work item", id);
        if (item.Version != ifMatch) throw ApiException.VersionConflict("Work item " + id);
        if (item.Status == "done") throw ApiException.Conflict("invalid_state", "The work item is already done");
        var now = clock.UtcNow;
        await workItems.CompleteAsync(id, now);
        await history.AppendAsync(item.ClaimId, now, "task", "Work item done: " + item.Action, actor, null, null, null);
        // The welcome call is what the first-contact service level asks for: doing it meets the row (the mock: "Call logged, D-703 closed").
        if (item.DedupeKey.StartsWith("welcome-call:", StringComparison.Ordinal))
        {
            var met = await deadlines.CloseLiveByKindAsync(item.ClaimId, [Domain.DeadlineKind.FirstContactBy], Domain.DeadlineState.Done, "user",
                "Met: the welcome call was made", now);
            if (met.Count > 0)
                await history.AppendAsync(item.ClaimId, now, "task", "First contact met", actor, "The first-contact deadline row closed without firing", null, null);
        }
        return (await queries.WorkItemAsync(id))!;
    });
}
