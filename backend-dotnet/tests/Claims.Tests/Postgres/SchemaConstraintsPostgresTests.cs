using Claims.Common;
using Claims.Intake;
using Claims.Tests.Support;
using Npgsql;

namespace Claims.Tests.Postgres;

/// <summary>REQUIRES POSTGRES. The constraints, triggers and indexes that make the rules hold whoever writes the rows.</summary>
public class SchemaConstraintsPostgresTests(SchemaConstraintsPostgresTests.Fixture fixture) : IClassFixture<SchemaConstraintsPostgresTests.Fixture>
{
    public sealed class Fixture : PostgresApiFixture
    {
        protected override string Hint => "schema";
    }

    private Db Sql => fixture.Db;

    private async Task<Guid> ClaimAsync()
    {
        var result = await fixture.Get<LifeIntakeService>().SubmitAsync(
            TestData.Castellano("natural", TestData.NewPolicy(), "Schema Person", true), "key-" + Guid.NewGuid(), Actor.User("test"));
        return result.Claim.Id;
    }

    private static async Task<PostgresException> RejectedAsync(Task<int> statement) => await Assert.ThrowsAsync<PostgresException>(() => statement);

    [PostgresFact]
    public async Task MigrationsCreatedEveryTableTheSliceNeeds()
    {
        var tables = await Sql.ListAsync<string>("SELECT table_name FROM information_schema.tables WHERE table_schema = 'public'");
        // DbUp's journal is schemaversions, where Flyway's was flyway_schema_history; everything else is the Flyway files' own tables.
        foreach (var expected in new[]
                 {
                     "claims", "parties", "policies", "benefit_lines", "requirements", "deadlines", "deadline_attempts", "decisions",
                     "payment_items", "payment_runs", "letters", "history_events", "work_items", "workflow_runs", "outbox_events",
                     "idempotency_keys", "life_claim_details", "claim_parties", "staff_users", "schemaversions",
                 })
            Assert.Contains(expected, tables);
    }

    [PostgresFact]
    public async Task HistoryIsAppendOnly()
    {
        var claim = await ClaimAsync();
        Assert.Equal(2, await Sql.SingleAsync<int>("SELECT count(*) FROM history_events WHERE claim_id = @c", new { c = claim }));
        Assert.Contains("append-only", (await RejectedAsync(Sql.ExecuteAsync("UPDATE history_events SET title = 'edited' WHERE claim_id = @c", new { c = claim }))).Message);
        Assert.Contains("append-only", (await RejectedAsync(Sql.ExecuteAsync("DELETE FROM history_events WHERE claim_id = @c", new { c = claim }))).Message);
        Assert.Contains("append-only", (await RejectedAsync(Sql.ExecuteAsync("TRUNCATE history_events"))).Message);
    }

    [PostgresFact]
    public async Task DecisionsAreLockedAndVersionedNotEdited()
    {
        var claim = await ClaimAsync();
        var line = await Sql.SingleAsync<Guid>("SELECT id FROM benefit_lines WHERE claim_id = @c AND kind = 'base'", new { c = claim });
        var staff = await Sql.SingleAsync<Guid>(
            "INSERT INTO staff_users (handle, display_name, team, role, payout_limit) VALUES (@h, 'Rachel', 'Life', 'life_examiner', 250000) RETURNING id",
            new { h = "r-" + Guid.NewGuid() });
        var v1 = await Sql.SingleAsync<Guid>("""
            INSERT INTO decisions (claim_id, benefit_line_id, version, outcome, outcome_text, basis, recorded_by, authority_note)
            VALUES (@c, @l, 1, 'approved', 'Approved', 'In force', @s, 'within authority') RETURNING id
            """, new { c = claim, l = line, s = staff });

        Assert.Contains("append-only", (await RejectedAsync(Sql.ExecuteAsync("UPDATE decisions SET outcome = 'denied' WHERE id = @id", new { id = v1 }))).Message);
        // Version 1 has no predecessor; version 2 must supersede something; the pair is unique.
        await RejectedAsync(Sql.ExecuteAsync("""
            INSERT INTO decisions (claim_id, benefit_line_id, version, outcome, outcome_text, basis, recorded_by, authority_note)
            VALUES (@c, @l, 2, 'denied', 'Denied', 'x', @s, 'x')
            """, new { c = claim, l = line, s = staff }));
        await Sql.ExecuteAsync("""
            INSERT INTO decisions (claim_id, benefit_line_id, version, supersedes_id, outcome, outcome_text, basis, recorded_by, authority_note)
            VALUES (@c, @l, 2, @prev, 'approved_in_part', 'Part', 'corrected', @s, 'x')
            """, new { c = claim, l = line, prev = v1, s = staff });
        Assert.Contains("decisions_version_unique", (await RejectedAsync(Sql.ExecuteAsync("""
            INSERT INTO decisions (claim_id, benefit_line_id, version, supersedes_id, outcome, outcome_text, basis, recorded_by, authority_note)
            VALUES (@c, @l, 2, @prev, 'denied', 'dup', 'x', @s, 'x')
            """, new { c = claim, l = line, prev = v1, s = staff }))).Message);
    }

    [PostgresFact]
    public async Task OneLiveFollowUpPerRequirementSoWritingTheNextRowTwiceFails()
    {
        var claim = await ClaimAsync();
        var req = await Sql.SingleAsync<Guid>("SELECT r.id FROM requirements r WHERE r.claim_id = @c AND r.state = 'requested' LIMIT 1", new { c = claim });
        Assert.Contains("deadlines_one_live_follow_up", (await RejectedAsync(Sql.ExecuteAsync("""
            INSERT INTO deadlines (claim_id, kind, requirement_id, what, due_at, original_due_at)
            VALUES (@c, 'requirement_follow_up', @r, 'second live row', now(), now())
            """, new { c = claim, r = req }))).Message);
    }

    [PostgresFact]
    public async Task MovingADueDateNeedsAReasonAndTheOriginalIsKept()
    {
        var claim = await ClaimAsync();
        var d = await Sql.SingleAsync<Guid>("SELECT id FROM deadlines WHERE claim_id = @c AND kind = 'acknowledge_by'", new { c = claim });
        Assert.Contains("deadlines_extension_ck", (await RejectedAsync(Sql.ExecuteAsync("UPDATE deadlines SET due_at = due_at + interval '5 days' WHERE id = @id", new { id = d }))).Message);
        await Sql.ExecuteAsync("UPDATE deadlines SET due_at = due_at + interval '5 days', extension_reason = 'Claimant asked for time' WHERE id = @id", new { id = d });
        Assert.Equal("5 days", await Sql.SingleAsync<string>("SELECT (due_at - original_due_at)::text FROM deadlines WHERE id = @id", new { id = d }));
    }

    [PostgresFact]
    public async Task AFinishedDeadlineNeedsAResultAndWhoClosedIt()
    {
        var claim = await ClaimAsync();
        var d = await Sql.SingleAsync<Guid>("SELECT id FROM deadlines WHERE claim_id = @c AND kind = 'forms_by'", new { c = claim });
        Assert.Contains("deadlines_result_ck", (await RejectedAsync(Sql.ExecuteAsync("UPDATE deadlines SET state = 'done', closed_at = now() WHERE id = @id", new { id = d }))).Message);
        Assert.Contains("deadlines_dispatched_ck", (await RejectedAsync(Sql.ExecuteAsync("UPDATE deadlines SET state = 'dispatched' WHERE id = @id", new { id = d }))).Message);
    }

    [PostgresFact]
    public async Task EveryMutableRowBumpsItsVersionOnAnyUpdate()
    {
        var claim = await ClaimAsync();
        var before = await Sql.SingleAsync<long>("SELECT version FROM claims WHERE id = @c", new { c = claim });
        await Sql.ExecuteAsync("UPDATE claims SET team = 'Other team' WHERE id = @c", new { c = claim });   // a plain SQL fix, not the app
        Assert.Equal(before + 1, await Sql.SingleAsync<long>("SELECT version FROM claims WHERE id = @c", new { c = claim }));
    }

    [PostgresFact]
    public async Task AWaivedRequirementNeedsAReasonAndAPaidPaymentItemCannotBeEdited()
    {
        var claim = await ClaimAsync();
        var req = await Sql.SingleAsync<Guid>("SELECT id FROM requirements WHERE claim_id = @c AND state = 'requested' LIMIT 1", new { c = claim });
        Assert.Contains("requirements_waived_ck", (await RejectedAsync(Sql.ExecuteAsync("UPDATE requirements SET state = 'waived', waived_at = now() WHERE id = @id", new { id = req }))).Message);

        var line = await Sql.SingleAsync<Guid>("SELECT id FROM benefit_lines WHERE claim_id = @c AND kind = 'base'", new { c = claim });
        var payee = await Sql.SingleAsync<Guid>("SELECT party_id FROM claim_parties WHERE claim_id = @c AND payee LIMIT 1", new { c = claim });
        var run = await Sql.SingleAsync<Guid>("INSERT INTO payment_runs (run_date) VALUES (current_date) RETURNING id");
        var item = await Sql.SingleAsync<Guid>("""
            INSERT INTO payment_items (claim_id, benefit_line_id, payee_party_id, basis, principal_amount, interest_amount, method, pay_on, status, run_id, paid_at)
            VALUES (@c, @l, @p, '50% of proceeds', 100000.00, 191.78, 'eft', current_date, 'paid', @r, now()) RETURNING id
            """, new { c = claim, l = line, p = payee, r = run });
        Assert.Equal("100191.78", await Sql.SingleAsync<string>("SELECT amount::text FROM payment_items WHERE id = @id", new { id = item }));
        Assert.Contains("cannot be edited", (await RejectedAsync(Sql.ExecuteAsync("UPDATE payment_items SET principal_amount = 1 WHERE id = @id", new { id = item }))).Message);
        Assert.Contains("can only become returned",
            (await RejectedAsync(Sql.ExecuteAsync("UPDATE payment_items SET status = 'cleared', paid_at = NULL, run_id = NULL WHERE id = @id", new { id = item }))).Message);
    }
}
