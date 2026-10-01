using Claims.Clock;
using Claims.Common;
using Claims.Deadline;
using Claims.Intake;
using Claims.Store;
using Claims.Tests.Support;

namespace Claims.Tests.Postgres;

/// <summary>
/// REQUIRES POSTGRES. The virtual business clock: with the Development controls on, moving it makes the dispatcher find rows due that were not due
/// a moment ago, without any row being edited, and every business timestamp follows it. (These use the app's real clock class, not a frozen test clock.)
/// </summary>
public class VirtualClockPostgresTests(VirtualClockPostgresTests.Fixture fixture) : IClassFixture<VirtualClockPostgresTests.Fixture>
{
    public sealed class Fixture : PostgresApiFixture
    {
        protected override string Hint => "vclock";

        protected override IReadOnlyDictionary<string, string?> Settings { get; } = new Dictionary<string, string?>
        {
            ["Claims:Dev:Controls"] = "true",
            ["Claims:Dispatcher:BatchSize"] = "50",
        };
    }

    private Db Sql => fixture.Db;

    private Task<ApiResponse> AdvanceAsync(string json) => fixture.CreateClient().PostApiAsync("/dev/clock:advance", json);

    [PostgresFact]
    public async Task AdvancingTheClockMakesTheDispatcherFireRowsWithoutAnyRowBeingEdited()
    {
        // Notice "now": the follow-ups are due in 10 days, so a poll today finds nothing.
        var intake = fixture.Get<LifeIntakeService>();
        var claim = (await intake.SubmitAsync(TestData.Castellano("natural", TestData.NewPolicy(), "Robert Castellano", true) with { NoticeReceivedAt = null }, "vclock-" + Guid.NewGuid(), Actor.User("t"))).Claim;
        fixture.Launcher.Reset();
        var followUps = await Sql.ListAsync<Guid>("SELECT id FROM deadlines WHERE claim_id = @c AND kind = 'requirement_follow_up' ORDER BY id", new { c = claim.Id });
        Assert.Equal(3, followUps.Count);
        var dueBefore = await Sql.QueryAsync("SELECT id, due_at, original_due_at, version FROM deadlines WHERE claim_id = @c ORDER BY id", new { c = claim.Id },
            r => (Id: r.Guid("id"), Due: r.Instant("due_at"), Original: r.Instant("original_due_at"), Version: r.Long("version")));
        await fixture.Get<DeadlineDispatcher>().DispatchDueAsync();   // a poll before the move: none of these three is due yet
        Assert.DoesNotContain(fixture.Launcher.StartedDeadlines, followUps.Contains);

        var real = DateTimeOffset.UtcNow;
        var moved = await AdvanceAsync("{\"days\":11}");

        Assert.Equal(200, moved.StatusCode);
        Assert.True(moved.At("virtual")!.GetValue<bool>());
        Assert.InRange(DateTimeOffset.Parse(moved.Str("now")!, System.Globalization.CultureInfo.InvariantCulture), real.AddDays(11).AddMinutes(-1), real.AddDays(11).AddMinutes(1));
        Assert.True(moved.At("offsetSeconds")!.GetValue<double>() >= 11 * 86400.0);
        var due = moved.Json["dueDeadlines"]!.AsArray().Select(d => Guid.Parse(d!["id"]!.ToString())).ToList();
        Assert.All(followUps, f => Assert.Contains(f, due));

        // The dispatcher reads the same clock (as its Temporal activity would) and now starts the three follow-ups.
        var d = await fixture.Get<DeadlineDispatcher>().DispatchDueAsync();
        Assert.True(d.Started >= 3);
        Assert.All(followUps, f => Assert.Contains(f, fixture.Launcher.StartedDeadlines));
        // No row was edited to make that happen: due dates and versions are exactly what they were.
        var dueAfter = await Sql.QueryAsync("SELECT id, due_at, original_due_at, version, state FROM deadlines WHERE claim_id = @c AND kind <> 'requirement_follow_up' ORDER BY id", new { c = claim.Id },
            r => (Id: r.Guid("id"), Due: r.Instant("due_at"), Original: r.Instant("original_due_at"), Version: r.Long("version")));
        Assert.Equal(dueBefore.Where(b => !followUps.Contains(b.Id)).Select(b => (b.Id, b.Due, b.Original, b.Version)), dueAfter);
        Assert.All(await Sql.QueryAsync("SELECT due_at, original_due_at FROM deadlines WHERE id = ANY (cast(@ids as uuid[]))", new { ids = Db.ArrayLiteral(followUps.Select(f => f.ToString())) },
            r => (Due: r.Instant("due_at"), Original: r.Instant("original_due_at"))), x => Assert.Equal(x.Original, x.Due));

        // Business timestamps follow the clock: a letter's sent_at and a history event's occurred_at are virtual, not the machine's.
        var virtualNow = fixture.Get<IClock>().UtcNow;
        var letter = await fixture.Get<LetterService>().SendOnceAsync(new LetterRepository.NewLetter(claim.Id, "TEST-01", "email", null, "Diane", "Clock test", null, "user", null, "wf", "clock-test-" + claim.Id), "Diane");
        var sentAt = (await Sql.QueryAsync("SELECT sent_at, created_at FROM letters WHERE id = @id", new { id = letter }, r => (Sent: r.Instant("sent_at"), Created: r.Instant("created_at"))))[0];
        Assert.InRange(sentAt.Sent, virtualNow.AddSeconds(-5), virtualNow.AddSeconds(5));
        Assert.InRange(sentAt.Created, virtualNow.AddSeconds(-5), virtualNow.AddSeconds(5));
        var req = (await fixture.Get<ClaimQueries>().RequirementsAsync(claim.Id)).First(r => r.State == "requested");
        await fixture.Get<Claims.Requirement.RequirementService>().AcceptAsync(req.Id, req.Version, "x", Actor.User("rachel"));
        var occurred = (await Sql.QueryAsync("SELECT occurred_at FROM history_events WHERE claim_id = @c AND title LIKE 'Requirement met%'", new { c = claim.Id }, r => r.Instant("occurred_at")))[0];
        Assert.InRange(occurred, virtualNow.AddSeconds(-5), virtualNow.AddDays(1));
    }

    [PostgresFact]
    public async Task UntilNextDeadlineLandsOnTheEarliestOpenRowAfterNow()
    {
        var clock = fixture.Get<IClock>();
        var next = (await Sql.QueryAsync("SELECT min(due_at) AS m FROM deadlines WHERE state = 'open' AND due_at > @now", new { now = clock.UtcNow }, r => r.InstantOrNull("m")))[0];
        if (next is null)   // a fresh database: give it something to be due
        {
            await fixture.Get<LifeIntakeService>().SubmitAsync(TestData.Castellano("natural", TestData.NewPolicy(), "Robert Castellano", true) with { NoticeReceivedAt = null }, "vclock-next-" + Guid.NewGuid(), Actor.User("t"));
            next = (await Sql.QueryAsync("SELECT min(due_at) AS m FROM deadlines WHERE state = 'open' AND due_at > @now", new { now = clock.UtcNow }, r => r.InstantOrNull("m")))[0];
        }

        var r = await AdvanceAsync("{\"until\":\"next_deadline\"}");

        Assert.Equal(200, r.StatusCode);
        Assert.InRange(DateTimeOffset.Parse(r.Str("now")!, System.Globalization.CultureInfo.InvariantCulture), next!.Value, next.Value.AddSeconds(2));
        // The row it landed on is now due.
        Assert.Contains(r.Json["dueDeadlines"]!.AsArray(), d => DateTimeOffset.Parse(d!["dueAt"]!.ToString(), System.Globalization.CultureInfo.InvariantCulture) == next.Value);
    }

    [PostgresFact]
    public async Task TimeOnlyMovesForwardAndAResetGoesBackToRealTime()
    {
        var client = fixture.CreateClient();
        await AdvanceAsync("{\"days\":2}");
        var now = DateTimeOffset.Parse((await client.GetApiAsync("/dev/clock")).Str("now")!, System.Globalization.CultureInfo.InvariantCulture);

        var back = await AdvanceAsync($"{{\"toIso\":\"{now.AddDays(-1):O}\"}}");
        Assert.Equal((422, "clock_cannot_go_backwards"), (back.StatusCode, back.Str("code")));
        Assert.Equal("clock_cannot_go_backwards", (await AdvanceAsync("{\"days\":0}")).Str("code"));
        Assert.Equal("clock_cannot_go_backwards", (await AdvanceAsync("{\"days\":-1}")).Str("code"));
        Assert.Equal("clock_advance_invalid", (await AdvanceAsync("{}")).Str("code"));
        Assert.Equal("clock_advance_invalid", (await AdvanceAsync("{\"days\":1,\"until\":\"next_deadline\"}")).Str("code"));
        Assert.Equal("clock_advance_invalid", (await AdvanceAsync("{\"until\":\"tomorrow\"}")).Str("code"));
        var stillNow = await client.GetApiAsync("/dev/clock");
        Assert.True(DateTimeOffset.Parse(stillNow.Str("now")!, System.Globalization.CultureInfo.InvariantCulture) >= now);   // refused moves changed nothing

        var toIso = await AdvanceAsync($"{{\"toIso\":\"{now.AddHours(5):O}\"}}");
        Assert.Equal(200, toIso.StatusCode);

        var reset = await client.PostApiAsync("/dev/clock:reset");
        Assert.Equal(200, reset.StatusCode);
        Assert.False(reset.At("virtual")!.GetValue<bool>());
        Assert.Equal(0, reset.At("offsetSeconds")!.GetValue<double>());
        Assert.Equal("America/Chicago", reset.Str("zone"));
    }
}

/// <summary>Without Claims:Dev:Controls the clock endpoints do not exist at all.</summary>
public class DevControlsOffPostgresTests(DevControlsOffPostgresTests.Fixture fixture) : IClassFixture<DevControlsOffPostgresTests.Fixture>
{
    public sealed class Fixture : PostgresApiFixture
    {
        protected override string Hint => "devoff";
    }

    [PostgresFact]
    public async Task TheDevEndpointsAre404WhenControlsAreNotEnabled()
    {
        var client = fixture.CreateClient();
        foreach (var (method, path) in new[] { (HttpMethod.Get, "/dev/clock"), (HttpMethod.Post, "/dev/clock:advance"), (HttpMethod.Post, "/dev/clock:reset"),
                     (HttpMethod.Get, "/dev/faults"), (HttpMethod.Post, "/dev/faults"), (HttpMethod.Get, "/dev/bank/returns"), (HttpMethod.Post, "/dev/bank/returns") })
        {
            var r = await client.SendJsonAsync(method, path, method == HttpMethod.Post ? "{\"days\":1}" : null);
            Assert.Equal(404, r.StatusCode);
            Assert.Equal("application/problem+json", r.ContentType?.Split(';')[0]);
        }
        Assert.False(fixture.Get<IClock>().IsVirtual);
        Assert.False(fixture.Get<Claims.Gateway.IFaultRegistry>().IsOn("letters.down"));   // and nothing is switched on by default
    }
}
