using Claims.Clock;
using Claims.Common;
using Claims.Domain;
using Claims.Store;
using Claims.View;

namespace Claims.Deadline;

public sealed class DeadlineService(DeadlineRepository deadlines, HistoryRepository history, ClaimQueries queries, Db db, IClock clock)
{
    /// <summary>An extension is a row update with a reason: due_at moves, original_due_at stays, the history says why.</summary>
    public Task<DeadlineView> ExtendAsync(Guid id, long ifMatch, DateTimeOffset newDueAt, string? reason, Actor actor)
    {
        if (string.IsNullOrWhiteSpace(reason)) throw ApiException.Unprocessable("reason_required", "An extension needs a reason");
        return db.InTransactionAsync(async () =>
        {
            var d = await deadlines.LockAsync(id) ?? throw ApiException.NotFound("Deadline", id);
            if (d.Version != ifMatch) throw ApiException.VersionConflict("Deadline " + id);
            if (d.State != DeadlineState.Open)
                throw ApiException.Conflict("deadline_not_open", "Only an open deadline can be extended; this one is " + d.State.Db());
            if (newDueAt <= d.DueAt) throw ApiException.Unprocessable("not_an_extension", "The new due date must be later than the current one");
            await deadlines.ExtendAsync(id, ifMatch, newDueAt, reason.Trim());
            await history.AppendAsync(d.ClaimId, clock.UtcNow, "data", "Deadline extended: " + d.What, actor,
                "From " + InstantConverter.Format(d.DueAt) + " to " + InstantConverter.Format(newDueAt) + ": " + reason.Trim(), null, null);
            return (await queries.DeadlineAsync(id))!;
        });
    }
}
