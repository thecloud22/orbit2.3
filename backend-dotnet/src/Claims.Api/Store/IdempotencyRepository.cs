using Claims.Common;

namespace Claims.Store;

/// <summary>
/// The <c>idempotency_keys</c> table for the POSTs that create something other than a claim (a document, a payment method). A key is written in the same
/// transaction as what it created, so it exists if and only if the resource does; the same key with the same body finds that resource again.
/// </summary>
public sealed class IdempotencyRepository(Db db)
{
    public sealed record Seen(string Hash, Guid? ResourceId);

    /// <summary>Serialises concurrent requests with the same (scope, key) until the transaction ends.</summary>
    public Task<int> LockAsync(string scope, string key) => db.SingleAsync<int>(
        "SELECT 1 FROM (SELECT pg_advisory_xact_lock(hashtextextended(@k, 0))) AS locked", new { k = scope + "|" + key });

    public async Task<Seen?> FindAsync(string scope, string key)
    {
        var rows = await db.QueryAsync("SELECT request_hash, resource_id FROM idempotency_keys WHERE scope = @s AND key = @k", new { s = scope, k = key },
            r => new Seen(r.Text("request_hash"), r.GuidOrNull("resource_id")));
        return rows.Count == 0 ? null : rows[0];
    }

    public Task<int> InsertAsync(string scope, string key, string hash, Guid claimId, Guid resourceId) => db.ExecuteAsync(
        "INSERT INTO idempotency_keys (scope, key, request_hash, claim_id, resource_id) VALUES (@s, @k, @h, @c, @r)",
        new { s = scope, k = key, h = hash, c = claimId, r = resourceId });
}
