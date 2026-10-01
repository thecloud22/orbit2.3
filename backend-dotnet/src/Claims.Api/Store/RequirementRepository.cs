using Claims.Common;
using Claims.Domain;

namespace Claims.Store;

public sealed class RequirementRepository(Db db)
{
    public sealed record Row(Guid Id, Guid ClaimId, string Name, string Key, RequirementState State, int FollowUpDays,
                             int FollowUpCount, Guid? FromPartyId, string FromLabel, long Version);

    private const string Cols = "id, claim_id, name, key, state, follow_up_days, follow_up_count, from_party_id, from_label, version";

    private static readonly Func<DbRow, Row> Map = r => new Row(r.Guid("id"), r.Guid("claim_id"), r.Text("name"), r.Text("key"),
        EnumText.Parse<RequirementState>(r.Text("state")), r.Int("follow_up_days"), r.Int("follow_up_count"),
        r.GuidOrNull("from_party_id"), r.Text("from_label"), r.Long("version"));

    public Task<List<Row>> ForClaimAsync(Guid claimId) =>
        db.QueryAsync("SELECT " + Cols + " FROM requirements WHERE claim_id = @c ORDER BY created_at, id", new { c = claimId }, Map);

    public Task<Row?> FindAsync(Guid id) =>
        db.QueryOptionalAsync("SELECT " + Cols + " FROM requirements WHERE id = @id", new { id }, Map);

    /// <summary>Lock order in this codebase: requirement first, then its deadline rows.</summary>
    public Task<Row?> LockAsync(Guid id) =>
        db.QueryOptionalAsync("SELECT " + Cols + " FROM requirements WHERE id = @id FOR UPDATE", new { id }, Map);

    public Task<int> MarkAcceptedAsync(Guid id, string satisfiedBy, DateTimeOffset now) => db.ExecuteAsync(
        "UPDATE requirements SET state = 'accepted', accepted_at = @now, received_at = COALESCE(received_at, @now), satisfied_by = @by, state_note = NULL WHERE id = @id",
        new { now = now.ToUniversalTime(), by = satisfiedBy, id });

    public Task<int> MarkWaivedAsync(Guid id, string reason, string by, DateTimeOffset now) => db.ExecuteAsync(
        "UPDATE requirements SET state = 'waived', waived_at = @now, waive_reason = @reason, waived_by = @by WHERE id = @id",
        new { now = now.ToUniversalTime(), reason, by, id });

    /// <summary>
    /// A document arrived or was reviewed and the requirement is not met yet: `received` (a person must decide), `not_enough` (what arrived was not enough) or
    /// `requested` again (the examiner rejected it). <paramref name="note"/> says why. Never touches a requirement that is already met.
    /// </summary>
    public Task<int> SetStateAsync(Guid id, string state, string? note, DateTimeOffset now) => db.ExecuteAsync(
        """
        UPDATE requirements SET state = @state, state_note = @note, received_at = CASE WHEN @state = 'requested' THEN received_at ELSE COALESCE(received_at, @now) END
        WHERE id = @id AND state NOT IN ('accepted', 'waived')
        """, new { id, state, note, now = now.ToUniversalTime() });

    public Task<int> RecordReminderAsync(Guid id, DateTimeOffset now) => db.ExecuteAsync(
        "UPDATE requirements SET follow_up_count = follow_up_count + 1, last_reminder_at = @now WHERE id = @id",
        new { now = now.ToUniversalTime(), id });

    /// <summary>Requirements on the claim that are not yet accepted or waived.</summary>
    public Task<int> CountUnmetAsync(Guid claimId) => db.SingleAsync<int>(
        "SELECT count(*) FROM requirements WHERE claim_id = @c AND state NOT IN ('accepted', 'waived')", new { c = claimId });
}
