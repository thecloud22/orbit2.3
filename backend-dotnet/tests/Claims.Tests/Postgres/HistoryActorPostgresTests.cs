using System.Globalization;
using Claims.Common;
using Claims.Store;
using Claims.Tests.Support;

namespace Claims.Tests.Postgres;

/// <summary>
/// REQUIRES POSTGRES. Every history event names its actor the same way, decided in ONE place (<see cref="HistoryRepository"/>): the display name of the active staff member
/// whose handle it is ("Rachel Kim", also for "RACHEL"), any other handle as typed ("examiner.dev" when X-Actor is absent, "ops.dev"), and the system, workflow, batch and
/// portal labels unchanged. `actorKind` never changes. The events checked here are the ones that recorded the raw handle before: requirements, payments, the payment run.
/// </summary>
public class HistoryActorPostgresTests(HistoryActorPostgresTests.Fixture fixture) : IClassFixture<HistoryActorPostgresTests.Fixture>
{
    public sealed class Fixture : PostgresApiFixture
    {
        protected override string Hint => "historyactor";

        protected override DateTimeOffset? ClockStart => DateTimeOffset.Parse("2026-10-08T16:30:00Z", CultureInfo.InvariantCulture);

        protected override IReadOnlyDictionary<string, string?> Settings { get; } = new Dictionary<string, string?> { ["Claims:Db:DevSeed"] = "true" };
    }

    private Db Sql => fixture.Db;

    private async Task<(string Kind, string Actor)> ActorOfAsync(Guid claim, string title) =>
        (await Sql.QuerySingleAsync("SELECT actor_kind, actor FROM history_events WHERE claim_id = @c AND title = @t", new { c = claim, t = title }, r => (r.Text("actor_kind"), r.Text("actor"))));

    private static Dictionary<string, string> Headers(string? actor, string ifMatch) =>
        actor is null ? new() { ["If-Match"] = ifMatch } : new() { ["If-Match"] = ifMatch, ["X-Actor"] = actor };

    [PostgresFact]
    public async Task RequirementEventsNameTheStaffMemberByDisplayNameAndAnUnknownHandleAsTyped()
    {
        var claim = await LifeScenario.GatheringAsync(fixture);
        var client = fixture.CreateClient();
        var reqs = (await client.GetApiAsync($"/claims/{claim.ClaimId}/requirements")).Items.Where(r => r["state"]!.ToString() == "requested").Take(3).ToList();

        Assert.Equal(200, (await client.PostApiAsync($"/requirements/{reqs[0]["id"]}:accept", null, Headers("rachel", "\"" + reqs[0]["version"] + "\""))).StatusCode);
        Assert.Equal(200, (await client.PostApiAsync($"/requirements/{reqs[1]["id"]}:accept", null, Headers(null, "\"" + reqs[1]["version"] + "\""))).StatusCode);   // no X-Actor: examiner.dev
        Assert.Equal(200, (await client.PostApiAsync($"/requirements/{reqs[2]["id"]}:accept", null, Headers("MONICA", "\"" + reqs[2]["version"] + "\""))).StatusCode);   // any case

        var actors = await Sql.QueryAsync("SELECT actor_kind, actor FROM history_events WHERE claim_id = @c AND title LIKE 'Requirement met:%' ORDER BY seq", new { c = claim.ClaimId },
            r => (r.Text("actor_kind"), r.Text("actor")));
        Assert.Equal([("user", "Rachel Kim"), ("user", "examiner.dev"), ("user", "Monica Reyes")], actors);
    }

    [PostgresFact]
    public async Task PaymentAndPaymentRunEventsUseTheSameNamesAsTheDecisionEvents()
    {
        var (claim, result) = await LifeScenario.ApprovedAsync(fixture);
        Assert.Equal("recorded", result.Kind);
        var client = fixture.CreateClient();
        var item = await Sql.SingleAsync<Guid>("SELECT pi.id FROM payment_items pi JOIN parties p ON p.id = pi.payee_party_id WHERE pi.claim_id = @c AND p.full_name LIKE 'Diane%'", new { c = claim.ClaimId });
        var version = await Sql.SingleAsync<long>("SELECT version FROM payment_items WHERE id = @i", new { i = item });

        var held = await client.PostApiAsync($"/payment-items/{item}:hold", "{\"reason\":\"Sanctions review\"}", Headers("rachel", $"\"{version}\""));
        Assert.Equal(200, held.StatusCode);
        Assert.Equal(200, (await client.PostApiAsync($"/payment-items/{item}:release", null, Headers(null, held.Header("ETag")!))).StatusCode);
        fixture.Clock.Set(DateTimeOffset.Parse("2026-10-09T07:00:00Z", CultureInfo.InvariantCulture));
        var run = await client.PostApiAsync("/payment-runs", "{\"runDate\":\"2026-10-09\"}", new Dictionary<string, string> { ["Idempotency-Key"] = "ha-" + Guid.NewGuid(), ["X-Actor"] = "monica" });
        Assert.True(run.StatusCode is 200 or 201);

        Assert.Equal(("user", "Rachel Kim"), await ActorOfAsync(claim.ClaimId, "Payment item held"));
        Assert.Equal(("user", "examiner.dev"), await ActorOfAsync(claim.ClaimId, "Payment item released"));
        // The decision event (which always recorded the display name) and the events of the run, by the same rule.
        Assert.Equal(("user", "Rachel Kim"), await Sql.QuerySingleAsync("SELECT actor_kind, actor FROM history_events WHERE claim_id = @c AND type = 'decision' ORDER BY seq LIMIT 1", new { c = claim.ClaimId }, r => (r.Text("actor_kind"), r.Text("actor"))));
        var paid = await Sql.QueryAsync("SELECT actor_kind, actor FROM history_events WHERE claim_id = @c AND (title LIKE '%payment run' OR title LIKE 'Paid %') ORDER BY seq", new { c = claim.ClaimId },
            r => (r.Text("actor_kind"), r.Text("actor")));
        Assert.NotEmpty(paid);
        Assert.All(paid, p => Assert.Equal(("user", "Monica Reyes"), p));   // the manual run's actor
        // No history event anywhere in this database still carries a known staff handle as its user actor.
        Assert.Equal(0, await Sql.SingleAsync<int>("SELECT count(*) FROM history_events h JOIN staff_users s ON lower(s.handle) = lower(h.actor) WHERE h.actor_kind = 'user'"));
    }

    [PostgresFact]
    public async Task OnlyUserActorsAreRenamedAndOnlyForActiveStaffLabelsAndKindsAreUntouched()
    {
        var history = fixture.Get<HistoryRepository>();
        await Sql.ExecuteAsync("INSERT INTO staff_users (handle, display_name, team, role, payout_limit, active) VALUES ('old.hand', 'Old Hand', 'Life & annuity team', 'life_examiner', 1, false) ON CONFLICT DO NOTHING");

        Assert.Equal("Rachel Kim", await history.ActorNameAsync(Actor.User("rachel")));
        Assert.Equal("Rachel Kim", await history.ActorNameAsync(Actor.User(" Rachel ")));
        Assert.Equal("Rachel Kim", await history.ActorNameAsync(Actor.User("Rachel Kim")));   // already a display name: not a handle, unchanged
        Assert.Equal("examiner.dev", await history.ActorNameAsync(Actor.User("examiner.dev")));
        Assert.Equal("old.hand", await history.ActorNameAsync(Actor.User("old.hand")));       // not in /staff (inactive): as typed
        // System, workflow, batch and portal labels are what they are, even when one happens to equal a handle.
        Assert.Equal("rachel", await history.ActorNameAsync(Actor.System("rachel")));
        Assert.Equal("rachel", await history.ActorNameAsync(Actor.Workflow("rachel")));
        Assert.Equal("rachel", await history.ActorNameAsync(Actor.Batch("rachel")));
        Assert.Equal("rachel", await history.ActorNameAsync(new Actor("portal", "rachel")));
        Assert.Equal("payment run", await history.ActorNameAsync(Actor.Batch("payment run")));
        Assert.Equal("event-abc", await history.ActorNameAsync(Actor.Workflow("event-abc")));

        // Through Append: the row keeps actor_kind and gets the name.
        var claim = await LifeScenario.GatheringAsync(fixture);
        await history.AppendAsync(claim.ClaimId, fixture.Clock.UtcNow, "data", "T1", Actor.User("monica"), null, null, null);
        await history.AppendAsync(claim.ClaimId, fixture.Clock.UtcNow, "data", "T2", Actor.Batch("nightly overdue check"), null, null, null);
        Assert.Equal(("user", "Monica Reyes"), await ActorOfAsync(claim.ClaimId, "T1"));
        Assert.Equal(("batch", "nightly overdue check"), await ActorOfAsync(claim.ClaimId, "T2"));
    }
}
