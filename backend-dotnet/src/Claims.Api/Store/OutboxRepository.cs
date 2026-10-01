using Claims.Common;

namespace Claims.Store;

public sealed class OutboxRepository(Db db)
{
    public sealed record Event(Guid Id, Guid? ClaimId, string Type, string Payload, int Attempts);

    public Task<Guid> InsertAsync(Guid claimId, string type, string payloadJson) => db.SingleAsync<Guid>(
        "INSERT INTO outbox_events (claim_id, event_type, payload) VALUES (@c, @t, cast(@p as jsonb)) RETURNING id",
        new { c = claimId, t = type, p = payloadJson });

    public async Task<Event?> FindAsync(Guid id)
    {
        var rows = await db.QueryAsync("SELECT id, claim_id, event_type, payload::text AS payload, publish_attempts FROM outbox_events WHERE id = @id", new { id },
            r => new Event(r.Guid("id"), r.GuidOrNull("claim_id"), r.Text("event_type"), r.Text("payload"), r.Int("publish_attempts")));
        return rows.Count == 0 ? null : rows[0];
    }

    /// <summary>Oldest unpublished events, locked so two relays never publish the same one.</summary>
    public Task<List<Event>> LockUnpublishedAsync(DateTimeOffset now, int limit) => db.QueryAsync("""
        SELECT id, claim_id, event_type, payload::text AS payload, publish_attempts FROM outbox_events
        WHERE published_at IS NULL AND (retry_after IS NULL OR retry_after <= @now)
        ORDER BY created_at, id LIMIT @limit FOR UPDATE SKIP LOCKED
        """, new { now = now.ToUniversalTime(), limit },
        r => new Event(r.Guid("id"), r.GuidOrNull("claim_id"), r.Text("event_type"), r.Text("payload"), r.Int("publish_attempts")));

    public Task<int> MarkPublishedAsync(Guid id, string workflowId, DateTimeOffset now) => db.ExecuteAsync(
        "UPDATE outbox_events SET published_at = @now, workflow_id = @wf, publish_attempts = publish_attempts + 1, last_error = NULL WHERE id = @id",
        new { now = now.ToUniversalTime(), wf = workflowId, id });

    public Task<int> MarkFailedAsync(Guid id, string? error, DateTimeOffset retryAfter) => db.ExecuteAsync(
        "UPDATE outbox_events SET publish_attempts = publish_attempts + 1, last_error = @e, retry_after = @r WHERE id = @id",
        new { e = error is null ? null : error[..Math.Min(error.Length, 1000)], r = retryAfter.ToUniversalTime(), id });
}
