using Claims.Common;
using Claims.Domain;

namespace Claims.Store;

/// <summary>Every SQL statement that touches the deadlines table.</summary>
public sealed class DeadlineRepository(Db db)
{
    public sealed record Row(Guid Id, Guid ClaimId, DeadlineKind Kind, Guid? RequirementId, string What, DateTimeOffset DueAt,
                             DeadlineState State, int Attempt, long Version);

    public sealed record NewDeadline(Guid ClaimId, DeadlineKind Kind, Guid? RequirementId, string What, string? Sla, DateTimeOffset DueAt,
                                     Guid? DocumentId = null, Guid? PartyId = null);

    private const string Cols = "id, claim_id, kind, requirement_id, what, due_at, state, attempt, version";

    private static readonly Func<DbRow, Row> Map = r => new Row(r.Guid("id"), r.Guid("claim_id"), EnumText.Parse<DeadlineKind>(r.Text("kind")),
        r.GuidOrNull("requirement_id"), r.Text("what"), r.Instant("due_at"), EnumText.Parse<DeadlineState>(r.Text("state")), r.Int("attempt"),
        r.Long("version"));

    public Task<Guid> InsertAsync(NewDeadline d) => db.SingleAsync<Guid>("""
        INSERT INTO deadlines (claim_id, kind, requirement_id, what, sla, due_at, original_due_at, document_id, party_id)
        VALUES (@claim, @kind, @req, @what, @sla, @due, @due, @doc, @party) RETURNING id
        """, new { claim = d.ClaimId, kind = d.Kind.Db(), req = d.RequirementId, what = d.What, sla = d.Sla, due = d.DueAt.ToUniversalTime(), doc = d.DocumentId, party = d.PartyId });

    public Task<Row?> FindAsync(Guid id) =>
        db.QueryOptionalAsync("SELECT " + Cols + " FROM deadlines WHERE id = @id", new { id }, Map);

    public Task<Row?> LockAsync(Guid id) =>
        db.QueryOptionalAsync("SELECT " + Cols + " FROM deadlines WHERE id = @id FOR UPDATE", new { id }, Map);

    /// <summary>
    /// The dispatcher's poll. FOR UPDATE SKIP LOCKED means two dispatchers (or a Schedule run overlapping a
    /// manual one) never take the same row: each simply skips what the other holds. Uses deadlines_dispatch_idx.
    /// </summary>
    public Task<List<Row>> LockDueAsync(DateTimeOffset now, IEnumerable<DeadlineKind> kinds, int limit) => db.QueryAsync(
        "SELECT " + Cols + """
         FROM deadlines
        WHERE state = 'open' AND due_at <= @now AND (retry_after IS NULL OR retry_after <= @now)
          AND kind = ANY (cast(@kinds as text[]))
        ORDER BY due_at, id
        LIMIT @limit
        FOR UPDATE SKIP LOCKED
        """,
        new { now = now.ToUniversalTime(), kinds = Db.ArrayLiteral(kinds.Select(k => k.Db())), limit }, Map);

    public Task<int> MarkDispatchedAsync(Guid id, string workflowId, string outcome, DateTimeOffset now) => db.ExecuteAsync("""
        UPDATE deadlines SET state = 'dispatched', attempt = attempt + 1, dispatched_at = @now, workflow_id = @wf,
               last_outcome = @outcome, last_error = NULL, retry_after = NULL
        WHERE id = @id AND state = 'open'
        """, new { now = now.ToUniversalTime(), wf = workflowId, outcome, id });

    public Task<int> MarkStartFailedAsync(Guid id, string error, DateTimeOffset retryAfter) => db.ExecuteAsync("""
        UPDATE deadlines SET attempt = attempt + 1, last_outcome = 'start_failed', last_error = @err, retry_after = @retry
        WHERE id = @id AND state = 'open'
        """, new { err = Truncate(error), retry = retryAfter.ToUniversalTime(), id });

    public Task<int> AddAttemptAsync(Guid id, int attempt, string outcome, string? workflowId, string? error) => db.ExecuteAsync(
        "INSERT INTO deadline_attempts (deadline_id, attempt, outcome, workflow_id, error) VALUES (@id, @n, @o, @wf, @e)",
        new { id, n = attempt, o = outcome, wf = workflowId, e = Truncate(error) });

    /// <summary>
    /// Compare-and-set close: only a live row (open or dispatched) can be closed, so a repeated call, or
    /// a workflow that lost a race with the requirement being accepted, changes nothing and returns false.
    /// </summary>
    public async Task<bool> CloseLiveAsync(Guid id, DeadlineState to, string closedBy, string result, bool fired, string outcome,
                                           string? runId, DateTimeOffset now) => await db.ExecuteAsync("""
        UPDATE deadlines SET state = @to, closed_at = @now, closed_by = @by, result = @result,
               fired = (fired OR @fired), last_outcome = @outcome, workflow_run_id = COALESCE(@run, workflow_run_id)
        WHERE id = @id AND state IN ('open', 'dispatched')
        """, new { to = to.Db(), now = now.ToUniversalTime(), by = closedBy, result, fired, outcome, run = runId, id }) == 1;

    /// <summary>A requirement was accepted or waived: its waiting follow-up rows close without ever firing.</summary>
    public Task<int> CloseOpenFollowUpsAsync(Guid requirementId, string result, DateTimeOffset now) => db.ExecuteAsync("""
        UPDATE deadlines SET state = 'done', closed_at = @now, closed_by = 'requirement', result = @result,
               last_outcome = 'closed_early'
        WHERE requirement_id = @req AND kind = 'requirement_follow_up' AND state = 'open'
        """, new { now = now.ToUniversalTime(), result, req = requirementId });

    /// <summary>
    /// A document changed what a requirement is waiting for: every live follow-up row for it (open, or dispatched and in flight) closes, so the next row can be
    /// written without meeting the one-live-follow-up index. A workflow still running for a dispatched row finds it closed and does nothing more.
    /// </summary>
    public Task<List<Guid>> CloseLiveFollowUpsAsync(Guid requirementId, string result, DateTimeOffset now) => db.ListAsync<Guid>("""
        UPDATE deadlines SET state = 'done', closed_at = @now, closed_by = 'requirement', result = @result, last_outcome = 'closed_early'
        WHERE requirement_id = @req AND kind = 'requirement_follow_up' AND state IN ('open', 'dispatched') RETURNING id
        """, new { now = now.ToUniversalTime(), result, req = requirementId });

    /// <summary>
    /// The decision (or the payment run) makes some open rows moot or met: close them in one statement. Only live rows change, so repeating it is harmless.
    /// Returns the kinds closed, for the history line.
    /// </summary>
    public Task<List<string>> CloseLiveByKindAsync(Guid claimId, IEnumerable<DeadlineKind> kinds, DeadlineState to, string closedBy, string result,
                                                   DateTimeOffset now) => db.ListAsync<string>("""
        UPDATE deadlines SET state = @to, closed_at = @now, closed_by = @by, result = @result,
               last_outcome = CASE WHEN @to = 'skipped' THEN 'skipped' ELSE 'closed_early' END
        WHERE claim_id = @c AND kind = ANY (cast(@kinds as text[])) AND state IN ('open', 'dispatched')
        RETURNING kind
        """, new { to = to.Db(), now = now.ToUniversalTime(), by = closedBy, result, c = claimId, kinds = Db.ArrayLiteral(kinds.Select(k => k.Db())) });

    /// <summary>The examiner reviewed the document: its review row closes (done, by a person). Returns the ids closed.</summary>
    public Task<List<Guid>> CloseLiveForDocumentAsync(Guid documentId, string result, DateTimeOffset now) => db.ListAsync<Guid>("""
        UPDATE deadlines SET state = 'done', closed_at = @now, closed_by = 'user', result = @result, last_outcome = 'closed_early'
        WHERE document_id = @d AND kind = 'document_review_by' AND state IN ('open', 'dispatched') RETURNING id
        """, new { d = documentId, result, now = now.ToUniversalTime() });

    /// <summary>The payee gave new bank details: the row waiting for them closes without ever firing. Returns the ids closed.</summary>
    public Task<List<Guid>> CloseLiveBankDetailsAsync(Guid claimId, Guid partyId, string result, DateTimeOffset now) => db.ListAsync<Guid>("""
        UPDATE deadlines SET state = 'done', closed_at = @now, closed_by = 'user', result = @result, last_outcome = 'closed_early'
        WHERE claim_id = @c AND party_id = @p AND kind = 'bank_details_by' AND state IN ('open', 'dispatched') RETURNING id
        """, new { c = claimId, p = partyId, result, now = now.ToUniversalTime() });

    /// <summary>Is a row of this kind still waiting for that payee? (Makes "write the row" safe to repeat.)</summary>
    public Task<bool> HasLiveForPartyAsync(Guid claimId, Guid partyId, DeadlineKind kind) => db.SingleAsync<bool>(
        "SELECT EXISTS (SELECT 1 FROM deadlines WHERE claim_id = @c AND party_id = @p AND kind = @k AND state IN ('open', 'dispatched'))",
        new { c = claimId, p = partyId, k = kind.Db() });

    public sealed record OverdueRow(Guid Id, Guid ClaimId, DeadlineKind Kind, string What, DateTimeOffset DueAt, Guid? OwnerId, string ClaimNumber);

    /// <summary>
    /// The nightly overdue check's poll: open rows past due, of a kind no workflow fires, on a claim that is not closed. FOR UPDATE OF d SKIP LOCKED so two
    /// checks at once (or a check overlapping the action that closes a row) never work on the same row.
    /// </summary>
    public Task<List<OverdueRow>> LockOverdueAsync(DateTimeOffset now, IEnumerable<DeadlineKind> kindsWithoutWorkflow, int limit) => db.QueryAsync("""
        SELECT d.id, d.claim_id, d.kind, d.what, d.due_at, c.owner_id, c.claim_number
        FROM deadlines d JOIN claims c ON c.id = d.claim_id
        WHERE d.state = 'open' AND d.due_at < @now AND d.kind = ANY (cast(@kinds as text[])) AND c.status <> 'closed'
        ORDER BY d.due_at, d.id
        LIMIT @limit
        FOR UPDATE OF d SKIP LOCKED
        """, new { now = now.ToUniversalTime(), kinds = Db.ArrayLiteral(kindsWithoutWorkflow.Select(k => k.Db())), limit },
        r => new OverdueRow(r.Guid("id"), r.Guid("claim_id"), EnumText.Parse<DeadlineKind>(r.Text("kind")), r.Text("what"), r.Instant("due_at"), r.GuidOrNull("owner_id"),
            r.Text("claim_number")));

    public Task<Row?> LiveFollowUpAsync(Guid requirementId) => db.QueryOptionalAsync(
        "SELECT " + Cols + " FROM deadlines WHERE requirement_id = @r AND kind = 'requirement_follow_up' AND state IN ('open','dispatched')",
        new { r = requirementId }, Map);

    /// <summary>Extending is an UPDATE with a reason. Only an open row, and only when the caller saw the current version.</summary>
    public Task<int> ExtendAsync(Guid id, long expectedVersion, DateTimeOffset newDueAt, string reason) => db.ExecuteAsync("""
        UPDATE deadlines SET due_at = @due, extension_reason = @reason
        WHERE id = @id AND version = @v AND state = 'open'
        """, new { due = newDueAt.ToUniversalTime(), reason, id, v = expectedVersion });

    private static string? Truncate(string? s) => s is null ? null : s.Length > 1000 ? s[..1000] : s;
}
