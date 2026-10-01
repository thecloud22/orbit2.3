using System.Globalization;
using Claims.Common;
using Claims.Deadline;
using Claims.Store;
using Claims.Tests.Support;

namespace Claims.Tests.Postgres;

/// <summary>
/// REQUIRES POSTGRES. The nightly overdue check: it lists open rows past due whose kind no workflow fires, raises each ONCE to the claim's owner (a work item and a history line), never touches
/// a row, ignores kinds the dispatcher does fire and claims that are closed, and does not double up when two checks run at once. The welcome call completing first-contact is the existing
/// way that row closes. Business time is set by hand.
/// </summary>
public class OverdueCheckPostgresTests(OverdueCheckPostgresTests.Fixture fixture) : IClassFixture<OverdueCheckPostgresTests.Fixture>, IAsyncLifetime
{
    public sealed class Fixture : PostgresApiFixture
    {
        protected override string Hint => "overdue";

        protected override DateTimeOffset? ClockStart => DateTimeOffset.Parse("2026-09-25T15:03:00Z", CultureInfo.InvariantCulture);

        protected override IReadOnlyDictionary<string, string?> Settings { get; } = new Dictionary<string, string?> { ["Claims:Db:DevSeed"] = "true" };
    }

    private static DateTimeOffset At(string iso) => DateTimeOffset.Parse(iso, CultureInfo.InvariantCulture);

    private Db Sql => fixture.Db;
    private OverdueCheckService Check => fixture.Get<OverdueCheckService>();

    public ValueTask InitializeAsync()
    {
        if (PostgresSupport.Available) fixture.Clock.Set(At("2026-09-25T15:03:00Z"));
        return ValueTask.CompletedTask;
    }

    public ValueTask DisposeAsync() => ValueTask.CompletedTask;

    private Task<T> One<T>(string sql, object? param = null) => Sql.SingleAsync<T>(sql, param);

    [PostgresFact]
    public async Task ARowPastDueThatNoWorkflowFiresIsRaisedToTheOwnerOnceAndNeverChanged()
    {
        var claim = await LifeScenario.GatheringAsync(fixture);
        fixture.Clock.Set(At("2026-09-29T07:30:00Z"));   // Tue 29 Sep 02:30 Central: first contact was due Mon 28 Sep 08:00
        var before = await One<string>("SELECT string_agg(id || ':' || state || ':' || version, ',' ORDER BY id) FROM deadlines WHERE claim_id = @c", new { c = claim.ClaimId });

        var first = await Check.RunAsync();

        var row = await One<Guid>("SELECT id FROM deadlines WHERE claim_id = @c AND kind = 'first_contact_by'", new { c = claim.ClaimId });
        var item = first.Items.Single(i => i.DeadlineId == row);
        Assert.True(item.Raised);
        Assert.Equal("first_contact_by", item.Kind);
        Assert.DoesNotContain(first.Items, i => i.Kind == "requirement_follow_up");   // a kind the dispatcher fires is the dispatcher's, not the check's
        // A work item for the owner (Rachel) and a history line, once.
        var rachel = await One<Guid>("SELECT id FROM staff_users WHERE handle = 'rachel'");
        Assert.Equal((rachel, "open", "workflow"), (await One<Guid>("SELECT owner_id FROM work_items WHERE dedupe_key = 'overdue:' || @d", new { d = row.ToString() }),
            await One<string>("SELECT status FROM work_items WHERE dedupe_key = 'overdue:' || @d", new { d = row.ToString() }), await One<string>("SELECT section FROM work_items WHERE dedupe_key = 'overdue:' || @d", new { d = row.ToString() })));
        Assert.Equal(1, await One<int>("SELECT count(*) FROM history_events WHERE claim_id = @c AND title LIKE 'Deadline overdue:%' AND ref = @d AND actor_kind = 'batch'", new { c = claim.ClaimId, d = row.ToString() }));
        // The row itself is exactly as it was: the check raises, it does not close, move or fire.
        Assert.Equal(before, await One<string>("SELECT string_agg(id || ':' || state || ':' || version, ',' ORDER BY id) FROM deadlines WHERE claim_id = @c", new { c = claim.ClaimId }));

        // Run again: the same rows are found and nothing new is written.
        var second = await Check.RunAsync();
        Assert.False(second.Items.Single(i => i.DeadlineId == row).Raised);
        Assert.Equal(0, second.Raised);
        Assert.Equal(1, await One<int>("SELECT count(*) FROM work_items WHERE dedupe_key = 'overdue:' || @d", new { d = row.ToString() }));
        Assert.Equal(1, await One<int>("SELECT count(*) FROM history_events WHERE claim_id = @c AND title LIKE 'Deadline overdue:%' AND ref = @d", new { c = claim.ClaimId, d = row.ToString() }));
    }

    [PostgresFact]
    public async Task TheOverdueWorkItemIsDoneWhenTheRowItIsAboutClosesWhoeverClosesIt()
    {
        var claim = await LifeScenario.GatheringAsync(fixture);
        var rachel = await One<Guid>("SELECT id FROM staff_users WHERE handle = 'rachel'");
        await fixture.Get<WorkItemRepository>().InsertOnceAsync("welcome-call:" + claim.ClaimId, rachel, claim.ClaimId, 2, "New life claim: welcome call to Diane", "Phone intake",
            new DateOnly(2026, 9, 28), "You", "workflow", "workflow", null);
        fixture.Clock.Set(At("2026-09-29T07:30:00Z"));   // first contact is a day late
        var row = await One<Guid>("SELECT id FROM deadlines WHERE claim_id = @c AND kind = 'first_contact_by'", new { c = claim.ClaimId });
        Assert.True((await Check.RunAsync()).Items.Single(i => i.DeadlineId == row).Raised);
        Assert.Equal("open", await One<string>("SELECT status FROM work_items WHERE dedupe_key = 'overdue:' || @d", new { d = row.ToString() }));

        // Rachel makes the call late: the welcome-call item completes, the row closes (existing behaviour), and the overdue item is done with it.
        fixture.Clock.Set(At("2026-09-29T14:40:00Z"));
        var welcome = await Sql.QueryAsync("SELECT id, version FROM work_items WHERE dedupe_key = 'welcome-call:' || @c", new { c = claim.ClaimId.ToString() }, r => (r.Guid("id"), r.Long("version")));
        Assert.Equal(200, (await fixture.CreateClient().PostApiAsync($"/work-items/{welcome[0].Item1}:complete", null,
            new Dictionary<string, string> { ["If-Match"] = $"\"{welcome[0].Item2}\"", ["X-Actor"] = "rachel" })).StatusCode);

        Assert.Equal("done", await One<string>("SELECT status FROM work_items WHERE dedupe_key = 'overdue:' || @d", new { d = row.ToString() }));
        Assert.DoesNotContain((await Check.RunAsync()).Items, i => i.DeadlineId == row);
    }

    [PostgresFact]
    public async Task TheWelcomeCallClosesFirstContactSoItIsNotRaisedAtAll()
    {
        var claim = await LifeScenario.GatheringAsync(fixture);
        var rachel = await One<Guid>("SELECT id FROM staff_users WHERE handle = 'rachel'");
        await fixture.Get<WorkItemRepository>().InsertOnceAsync("welcome-call:" + claim.ClaimId, rachel, claim.ClaimId, 2, "New life claim: welcome call to Diane", "Phone intake",
            new DateOnly(2026, 9, 28), "You", "workflow", "workflow", null);
        var welcome = await Sql.QueryAsync("SELECT id, version FROM work_items WHERE dedupe_key = 'welcome-call:' || @c", new { c = claim.ClaimId.ToString() }, r => (r.Guid("id"), r.Long("version")));
        fixture.Clock.Set(At("2026-09-28T14:40:00Z"));   // Mon 28 Sep 09:40: Rachel calls, before the row is due
        var done = await fixture.CreateClient().PostApiAsync($"/work-items/{welcome[0].Item1}:complete", null,
            new Dictionary<string, string> { ["If-Match"] = $"\"{welcome[0].Item2}\"", ["X-Actor"] = "rachel" });
        Assert.Equal(200, done.StatusCode);
        Assert.Equal("done", await One<string>("SELECT state FROM deadlines WHERE claim_id = @c AND kind = 'first_contact_by'", new { c = claim.ClaimId }));
        fixture.Clock.Set(At("2026-09-29T07:30:00Z"));

        var r = await Check.RunAsync();

        Assert.DoesNotContain(r.Items, i => i.Kind == "first_contact_by" && i.ClaimId == claim.ClaimId);
        Assert.Equal(0, await One<int>("SELECT count(*) FROM work_items WHERE claim_id = @c AND dedupe_key LIKE 'overdue:%'", new { c = claim.ClaimId }));
    }

    [PostgresFact]
    public async Task TheNewKindsAreRaisedWhenLateAndAClosedClaimIsIgnored()
    {
        var claim = await LifeScenario.GatheringAsync(fixture);
        var closed = await LifeScenario.GatheringAsync(fixture);
        var diane = await One<Guid>("SELECT p.id FROM claim_parties cp JOIN parties p ON p.id = cp.party_id WHERE cp.claim_id = @c AND cp.role = 'beneficiary' AND p.full_name LIKE 'Diane%'", new { c = claim.ClaimId });
        var deadlines = fixture.Get<DeadlineRepository>();
        var review = await deadlines.InsertAsync(new DeadlineRepository.NewDeadline(claim.ClaimId, Claims.Domain.DeadlineKind.DocumentReviewBy, null, "Examiner reviews the certificate", "docReview", At("2026-10-02T13:00:00Z")));
        var bank = await deadlines.InsertAsync(new DeadlineRepository.NewDeadline(claim.ClaimId, Claims.Domain.DeadlineKind.BankDetailsBy, null, "Mark gives new bank details", null, At("2026-10-19T13:00:00Z"), null, diane));
        await Sql.ExecuteAsync("UPDATE claims SET status = 'closed', closed_at = now() WHERE id = @c", new { c = closed.ClaimId });
        fixture.Clock.Set(At("2026-10-03T07:30:00Z"));   // Sat 3 Oct: the review row is late, the bank-details row is not yet

        var r = await Check.RunAsync();

        Assert.Contains(r.Items, i => i.DeadlineId == review && i.Raised);
        Assert.DoesNotContain(r.Items, i => i.DeadlineId == bank);
        Assert.DoesNotContain(r.Items, i => i.ClaimId == closed.ClaimId);
        fixture.Clock.Set(At("2026-10-20T07:30:00Z"));
        var later = await Check.RunAsync();
        Assert.Contains(later.Items, i => i.DeadlineId == bank && i.Raised);
        Assert.Contains(later.Items, i => i.DeadlineId == review && !i.Raised);   // raised before: once per row
    }

    [PostgresFact]
    public async Task TwoChecksAtTheSameTimeRaiseEachRowExactlyOnce()
    {
        var claim = await LifeScenario.GatheringAsync(fixture);
        fixture.Clock.Set(At("2026-11-01T07:30:00Z"));   // every service-level row of this claim is late

        var results = await Task.WhenAll(Enumerable.Range(0, 5).Select(_ => Task.Run(() => Check.RunAsync())));

        var raised = results.SelectMany(r => r.Items).Where(i => i.ClaimId == claim.ClaimId && i.Raised).Select(i => i.DeadlineId).ToList();
        Assert.NotEmpty(raised);
        Assert.Equal(raised.Count, raised.Distinct().Count());   // no row raised twice
        Assert.Equal(raised.Count, await One<int>("SELECT count(*) FROM work_items WHERE claim_id = @c AND dedupe_key LIKE 'overdue:%'", new { c = claim.ClaimId }));
        Assert.Equal(raised.Count, await One<int>("SELECT count(*) FROM history_events WHERE claim_id = @c AND title LIKE 'Deadline overdue:%'", new { c = claim.ClaimId }));
    }
}
