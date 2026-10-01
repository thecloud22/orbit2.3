using Claims.Common;

namespace Claims.Store;

public sealed class WorkItemRepository(Db db)
{
    /// <summary>Idempotent by dedupe key: a retried activity cannot put a second item in the queue.</summary>
    public async Task<bool> InsertOnceAsync(string dedupeKey, Guid? ownerId, Guid claimId, int priority, string action, string why,
                                            DateOnly dueOn, string waitingOn, string section, string sourceKind, Guid? sourceId) =>
        await db.ExecuteAsync("""
            INSERT INTO work_items (dedupe_key, owner_id, claim_id, priority, action, why, due_on, waiting_on, section, source_kind, source_id)
            VALUES (@key, @owner, @claim, @prio, @action, @why, @due, @waiting, @section, @sk, @sid)
            ON CONFLICT (dedupe_key) DO NOTHING
            """, new
        {
            key = dedupeKey,
            owner = ownerId,
            claim = claimId,
            prio = (short)priority,
            action,
            why,
            due = dueOn,
            waiting = waitingOn,
            section,
            sk = sourceKind,
            sid = sourceId,
        }) == 1;

    /// <summary>
    /// Like <see cref="InsertOnceAsync"/>, but an item that was already done is opened again: a workflow that fails a second time (a re-run that failed too)
    /// must put its ops task back in the queue rather than leave the old finished one. Returns true when it inserted or reopened.
    /// </summary>
    public async Task<bool> InsertOrReopenAsync(string dedupeKey, Guid? ownerId, Guid claimId, int priority, string action, string why,
                                                DateOnly dueOn, string waitingOn, string section, string sourceKind, Guid? sourceId) =>
        await db.ExecuteAsync("""
            INSERT INTO work_items (dedupe_key, owner_id, claim_id, priority, action, why, due_on, waiting_on, section, source_kind, source_id)
            VALUES (@key, @owner, @claim, @prio, @action, @why, @due, @waiting, @section, @sk, @sid)
            ON CONFLICT (dedupe_key) DO UPDATE SET status = 'open', completed_at = NULL, why = EXCLUDED.why, due_on = EXCLUDED.due_on
            WHERE work_items.status = 'done'
            """, new
        {
            key = dedupeKey,
            owner = ownerId,
            claim = claimId,
            prio = (short)priority,
            action,
            why,
            due = dueOn,
            waiting = waitingOn,
            section,
            sk = sourceKind,
            sid = sourceId,
        }) == 1;

    public Task<Guid?> IdByKeyAsync(string dedupeKey) => db.SingleOrDefaultAsync<Guid?>("SELECT id FROM work_items WHERE dedupe_key = @k", new { k = dedupeKey });

    /// <summary>Done, by the action that made the item obsolete. Only an open item changes; returns whether one did.</summary>
    public async Task<bool> CompleteByKeyAsync(string dedupeKey, DateTimeOffset now) => await db.ExecuteAsync(
        "UPDATE work_items SET status = 'done', completed_at = @now WHERE dedupe_key = @k AND status = 'open'",
        new { k = dedupeKey, now = now.ToUniversalTime() }) == 1;

    /// <summary>Done: every open item of the claim in this section (all sections when null), for example when the claim closes.</summary>
    public Task<int> CompleteOpenForClaimAsync(Guid claimId, string? section, DateTimeOffset now) => db.ExecuteAsync(
        "UPDATE work_items SET status = 'done', completed_at = @now WHERE claim_id = @c AND status = 'open' AND (cast(@s as text) IS NULL OR section = @s)",
        new { c = claimId, s = section, now = now.ToUniversalTime() });

    public sealed record Row(Guid Id, Guid ClaimId, string Status, long Version, string Action, string DedupeKey);

    public Task<Row?> LockAsync(Guid id) => db.QueryOptionalAsync(
        "SELECT id, claim_id, status, version, action, dedupe_key FROM work_items WHERE id = @id FOR UPDATE", new { id },
        r => new Row(r.Guid("id"), r.Guid("claim_id"), r.Text("status"), r.Long("version"), r.Text("action"), r.Text("dedupe_key")));

    public Task<int> CompleteAsync(Guid id, DateTimeOffset now) => db.ExecuteAsync(
        "UPDATE work_items SET status = 'done', completed_at = @now WHERE id = @id", new { id, now = now.ToUniversalTime() });
}
