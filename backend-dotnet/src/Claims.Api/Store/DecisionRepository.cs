using Claims.Common;

namespace Claims.Store;

/// <summary>Every SQL statement that touches decisions and their approvals. There is deliberately no update or delete (the table refuses them).</summary>
public sealed class DecisionRepository(Db db)
{
    public sealed record NewDecision(Guid ClaimId, Guid BenefitLineId, Guid GroupId, string Outcome, string OutcomeText, string Basis,
                                     IReadOnlyList<string> Evidence, IReadOnlyList<string> Provisions, DateTimeOffset RecordedAt, Guid RecordedBy,
                                     string AuthorityNote, bool RequiresApproval, string? LetterTemplate, decimal? Amount);

    /// <summary>Row of a decision as the approval step needs it.</summary>
    public sealed record Row(Guid Id, Guid ClaimId, Guid BenefitLineId, Guid GroupId, string Outcome, bool RequiresApproval, bool Approved,
                             Guid RecordedBy, string Basis, string AuthorityNote, decimal? Amount);

    /// <summary>Version 1 of a line, or the next version when the line already has decisions (a correction; not reachable yet).</summary>
    public Task<Guid> InsertAsync(NewDecision d) => db.SingleAsync<Guid>("""
        INSERT INTO decisions (claim_id, benefit_line_id, group_id, version, supersedes_id, outcome, outcome_text, basis, evidence, provisions,
                               recorded_at, recorded_by, authority_note, requires_approval, letter_template, amount)
        VALUES (@claim, @line, @grp,
                COALESCE((SELECT max(version) FROM decisions WHERE benefit_line_id = @line), 0) + 1,
                (SELECT id FROM decisions WHERE benefit_line_id = @line ORDER BY version DESC LIMIT 1),
                @outcome, @text, @basis, cast(@evidence as jsonb), cast(@provisions as jsonb), @at, @by, @note, @requires, @letter, @amount)
        RETURNING id
        """, new
    {
        claim = d.ClaimId,
        line = d.BenefitLineId,
        grp = d.GroupId,
        outcome = d.Outcome,
        text = d.OutcomeText,
        basis = d.Basis,
        evidence = Json.Serialize(d.Evidence),
        provisions = Json.Serialize(d.Provisions),
        at = d.RecordedAt.ToUniversalTime(),
        by = d.RecordedBy,
        note = d.AuthorityNote,
        requires = d.RequiresApproval,
        letter = d.LetterTemplate,
        amount = d.Amount,
    });

    private const string Cols = """
        d.id, d.claim_id, d.benefit_line_id, d.group_id, d.outcome, d.requires_approval, d.recorded_by, d.basis, d.authority_note, d.amount,
        EXISTS (SELECT 1 FROM decision_approvals a WHERE a.decision_id = d.id) AS approved
        """;

    private static readonly Func<DbRow, Row> Map = r => new Row(r.Guid("id"), r.Guid("claim_id"), r.Guid("benefit_line_id"), r.Guid("group_id"),
        r.Text("outcome"), r.Bool("requires_approval"), r.Bool("approved"), r.Guid("recorded_by"), r.Text("basis"), r.Text("authority_note"),
        r.DecimalOrNull("amount"));

    public Task<Row?> FindAsync(Guid id) => db.QueryOptionalAsync("SELECT " + Cols + " FROM decisions d WHERE d.id = @id", new { id }, Map);

    /// <summary>Locks the decisions of one act, base line first. The claim row is locked before this, everywhere.</summary>
    public Task<List<Row>> LockGroupAsync(Guid groupId) => db.QueryAsync(
        "SELECT " + Cols + " FROM decisions d JOIN benefit_lines b ON b.id = d.benefit_line_id WHERE d.group_id = @g ORDER BY b.kind, b.created_at, d.id FOR UPDATE OF d",
        new { g = groupId }, Map);

    public Task<int> InsertApprovalAsync(Guid decisionId, Guid approvedBy, DateTimeOffset at, string? note) => db.ExecuteAsync(
        "INSERT INTO decision_approvals (decision_id, approved_by, approved_at, note) VALUES (@d, @by, @at, @note)",
        new { d = decisionId, by = approvedBy, at = at.ToUniversalTime(), note });

    public Task<int> CountForLineAsync(Guid lineId) => db.SingleAsync<int>("SELECT count(*) FROM decisions WHERE benefit_line_id = @l", new { l = lineId });

    /// <summary>The idempotency lookup for POST /decisions: (scope, key) to the request hash and the group it produced.</summary>
    public async Task<(string Hash, Guid? GroupId)?> FindKeyAsync(string scope, string key)
    {
        var rows = await db.QueryAsync("SELECT request_hash, resource_id FROM idempotency_keys WHERE scope = @s AND key = @k", new { s = scope, k = key },
            r => (r.Text("request_hash"), r.GuidOrNull("resource_id")));
        return rows.Count == 0 ? null : rows[0];
    }

    public Task<int> InsertKeyAsync(string scope, string key, string hash, Guid claimId, Guid groupId) => db.ExecuteAsync(
        "INSERT INTO idempotency_keys (scope, key, request_hash, claim_id, resource_id) VALUES (@s, @k, @h, @c, @g)",
        new { s = scope, k = key, h = hash, c = claimId, g = groupId });
}
