using Claims.Common;

namespace Claims.Store;

/// <summary>Every SQL statement that touches the documents table.</summary>
public sealed class DocumentRepository(Db db)
{
    public sealed record Row(Guid Id, Guid ClaimId, Guid? RequirementId, Guid? PartyId, string Kind, string Source, string AttributesJson, string Status,
                             string? StatusNote, DateTimeOffset ReceivedAt, string ReceivedBy, long Version);

    private const string Cols = "id, claim_id, requirement_id, party_id, kind, source, attributes::text AS attributes, status, status_note, received_at, received_by, version";

    private static readonly Func<DbRow, Row> Map = r => new Row(r.Guid("id"), r.Guid("claim_id"), r.GuidOrNull("requirement_id"), r.GuidOrNull("party_id"), r.Text("kind"),
        r.Text("source"), r.Text("attributes"), r.Text("status"), r.Str("status_note"), r.Instant("received_at"), r.Text("received_by"), r.Long("version"));

    public Task<Guid> InsertAsync(Guid claimId, Guid? requirementId, Guid? partyId, string kind, string source, string attributesJson, DateTimeOffset receivedAt,
                                  string receivedBy) => db.SingleAsync<Guid>("""
        INSERT INTO documents (claim_id, requirement_id, party_id, kind, source, attributes, received_at, received_by)
        VALUES (@claim, @req, @party, @kind, @source, cast(@attrs as jsonb), @at, @by) RETURNING id
        """, new { claim = claimId, req = requirementId, party = partyId, kind, source, attrs = attributesJson, at = receivedAt.ToUniversalTime(), by = receivedBy });

    public Task<int> SetOutboxEventAsync(Guid id, Guid outboxEventId) =>
        db.ExecuteAsync("UPDATE documents SET outbox_event_id = @e WHERE id = @id", new { id, e = outboxEventId });

    public Task<Row?> FindAsync(Guid id) => db.QueryOptionalAsync("SELECT " + Cols + " FROM documents WHERE id = @id", new { id }, Map);

    public Task<Row?> LockAsync(Guid id) => db.QueryOptionalAsync("SELECT " + Cols + " FROM documents WHERE id = @id FOR UPDATE", new { id }, Map);

    /// <summary>The workflow's decision about a document: its status and why. Never moves a document out of a final state it did not set (compare-and-set on the old status).</summary>
    public async Task<bool> SetStatusAsync(Guid id, string[] from, string status, string? note) => await db.ExecuteAsync(
        "UPDATE documents SET status = @status, status_note = @note WHERE id = @id AND status = ANY (cast(@from as text[]))",
        new { id, status, note, from = Db.ArrayLiteral(from) }) == 1;

    public async Task<bool> ReviewAsync(Guid id, string status, string? note, string reviewedBy, string? reason, DateTimeOffset at) => await db.ExecuteAsync("""
        UPDATE documents SET status = @status, status_note = @note, reviewed_by = @by, reviewed_at = @at, review_reason = @reason
        WHERE id = @id AND status = 'under_review'
        """, new { id, status, note, by = reviewedBy, reason, at = at.ToUniversalTime() }) == 1;
}
