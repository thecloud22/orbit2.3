using Claims.Common;

namespace Claims.Store;

/// <summary>
/// Append-only audit trail. There is deliberately no update or delete here (or in the database).
///
/// The one place an actor is written, so it is named the same way on every event: a `user` actor that is a staff handle known to /staff (active) is recorded by
/// the staff member's DISPLAY NAME ("Rachel Kim"), any other handle ("ops.dev", "examiner.dev") as typed, and the system, workflow, batch and portal labels unchanged.
/// A name that is already a display name (the decision events pass one) is not a handle, so it stays as it is. `actor_kind` is never changed.
/// </summary>
public sealed class HistoryRepository(Db db, StaffRepository staff)
{
    public async Task<int> AppendAsync(Guid claimId, DateTimeOffset occurredAt, string type, string title, Actor actor, string? detail,
                                       string? reference, string? workflowId)
    {
        var name = await ActorNameAsync(actor);
        return await db.ExecuteAsync("""
            INSERT INTO history_events (claim_id, occurred_at, type, title, actor_kind, actor, detail, ref, workflow_id)
            VALUES (@claim, @at, @type, @title, @kind, @actor, @detail, @ref, @wf)
            """, new
        {
            claim = claimId,
            at = occurredAt.ToUniversalTime(),
            type,
            title,
            kind = actor.Kind,
            actor = name,
            detail,
            @ref = reference,
            wf = workflowId,
        });
    }

    /// <summary>The name to record: the display name of the active staff member whose handle this is, else the name as given.</summary>
    public async Task<string> ActorNameAsync(Actor actor) =>
        actor.Kind == "user" && await staff.FindActiveByHandleAsync(actor.Name.Trim()) is { } known ? known.DisplayName : actor.Name;
}
