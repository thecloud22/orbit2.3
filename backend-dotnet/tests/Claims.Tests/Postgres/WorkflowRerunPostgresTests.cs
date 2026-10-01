using System.Globalization;
using Claims.Common;
using Claims.Domain;
using Claims.Store;
using Claims.Temporal;
using Claims.Tests.Support;

namespace Claims.Tests.Postgres;

/// <summary>
/// REQUIRES POSTGRES. The ops re-run of a FAILED workflow run (`POST /workflow-runs/{id}:rerun`): only a failed run that is the latest of its workflow id, started again through the launcher's
/// normal entry points (a stand-in records what would have been started), under the same workflow id and with the same outbox event, so it cannot send anything twice. The run record's
/// numbering (run 1, run 2, linked) is what Begin writes.
/// </summary>
public class WorkflowRerunPostgresTests(WorkflowRerunPostgresTests.Fixture fixture) : IClassFixture<WorkflowRerunPostgresTests.Fixture>
{
    public sealed class Fixture : PostgresApiFixture
    {
        protected override string Hint => "rerun";

        protected override DateTimeOffset? ClockStart => DateTimeOffset.Parse("2026-10-01T20:05:00Z", CultureInfo.InvariantCulture);

        protected override IReadOnlyDictionary<string, string?> Settings { get; } = new Dictionary<string, string?> { ["Claims:Db:DevSeed"] = "true" };
    }

    private Db Sql => fixture.Db;
    private WorkflowRunRepository Runs => fixture.Get<WorkflowRunRepository>();

    private static Dictionary<string, string> Ops(string actor = "ops.dev") => new() { ["X-Actor"] = actor };

    private async Task<(Guid Claim, Guid Event, string Workflow)> FailedEventRunAsync(string type = "document_rejected")
    {
        var claim = await LifeScenario.GatheringAsync(fixture);
        var doc = Guid.NewGuid();
        var eventId = await fixture.Get<OutboxRepository>().InsertAsync(claim.ClaimId, type, Json.Serialize(new { documentId = doc.ToString(), claimId = claim.ClaimId.ToString() }));
        var wf = "event-" + eventId;
        await Sql.ExecuteAsync("UPDATE outbox_events SET published_at = now(), workflow_id = @w WHERE id = @e", new { w = wf, e = eventId });
        await Runs.BeginAsync(wf, "temporal-run-1", "event", "Certificate rejected", claim.ClaimId, "Outbox relay", "outbox_event", eventId, fixture.Clock.UtcNow);
        await Runs.FinishAsync(wf, "temporal-run-1", "failed", [RunStep.Failed("Send it", "503", "Letters service", 5)], ["Ops task opened"], "503", fixture.Clock.UtcNow, "note");
        return (claim.ClaimId, eventId, wf);
    }

    private async Task<Guid> RunIdAsync(string workflowId, string runId) =>
        await Sql.SingleAsync<Guid>("SELECT id FROM workflow_runs WHERE workflow_id = @w AND run_id = @r", new { w = workflowId, r = runId });

    [PostgresFact]
    public async Task AFailedEventRunIsStartedAgainWithTheSameWorkflowIdAndTheSameOutboxEvent()
    {
        var (claim, eventId, wf) = await FailedEventRunAsync();
        var id = await RunIdAsync(wf, "temporal-run-1");
        fixture.Launcher.Reset();

        var list = await fixture.CreateClient().GetApiAsync("/workflow-runs?status=failed");
        Assert.True(list.Items.Single(r => r["id"]!.ToString() == id.ToString())["canRerun"]!.GetValue<bool>());

        var r = await fixture.CreateClient().PostApiAsync($"/workflow-runs/{id}:rerun", null, Ops());

        Assert.Equal(202, r.StatusCode);
        Assert.Equal((wf, "started", id.ToString()), (r.Str("workflowId"), r.Str("outcome"), r.Str("previousRunId")));
        var started = Assert.Single(fixture.Launcher.StartedEvents);
        Assert.Equal((eventId, claim, "document_rejected"), (started.EventId, started.ClaimId, started.EventType));   // the SAME event: its workflow id is the same, so the id-reuse policy decides
        Assert.Equal(wf, EventWorkflows.WorkflowIdFor(started));
        Assert.Equal(1, await Sql.SingleAsync<int>("SELECT count(*) FROM history_events WHERE claim_id = @c AND title = 'Ops re-run requested: ' || @w AND actor = 'ops.dev'", new { c = claim, w = wf }));
    }

    [PostgresFact]
    public async Task OnlyAFailedRunCanBeRerunAndOnlyTheLatestOfItsWorkflowId()
    {
        var (_, _, wf) = await FailedEventRunAsync();
        var client = fixture.CreateClient();
        var first = await RunIdAsync(wf, "temporal-run-1");

        // Run 2 exists (an earlier re-run) and completed: run 1 is no longer the latest, and run 2 did not fail.
        await Runs.BeginAsync(wf, "temporal-run-2", "event", "Certificate rejected", (await Sql.SingleAsync<Guid>("SELECT claim_id FROM workflow_runs WHERE id = @i", new { i = first })), "Ops", "outbox_event",
            await Sql.SingleAsync<Guid>("SELECT trigger_id FROM workflow_runs WHERE id = @i", new { i = first }), fixture.Clock.UtcNow);
        var second = await RunIdAsync(wf, "temporal-run-2");
        Assert.Equal((2, first), (await Sql.SingleAsync<int>("SELECT run_no FROM workflow_runs WHERE id = @i", new { i = second }), await Sql.SingleAsync<Guid>("SELECT rerun_of_id FROM workflow_runs WHERE id = @i", new { i = second })));
        var notLatest = await client.PostApiAsync($"/workflow-runs/{first}:rerun", null, Ops());
        Assert.Equal((409, "run_not_latest"), (notLatest.StatusCode, notLatest.Str("code")));   // even though run 1 failed

        await Runs.FinishAsync(wf, "temporal-run-2", "completed", [], [], null, fixture.Clock.UtcNow);
        var notFailed = await client.PostApiAsync($"/workflow-runs/{second}:rerun", null, Ops());
        Assert.Equal((409, "run_not_failed"), (notFailed.StatusCode, notFailed.Str("code")));
        var list = (await client.GetApiAsync("/workflow-runs?status=failed")).Items.Single(r => r["id"]!.ToString() == first.ToString());
        Assert.False(list["canRerun"]!.GetValue<bool>());   // the operations view says so too

        Assert.Equal(404, (await client.PostApiAsync($"/workflow-runs/{Guid.NewGuid()}:rerun", null, Ops())).StatusCode);
        Assert.Equal(400, (await client.PostApiAsync($"/workflow-runs/{first}:rerun")).StatusCode);   // X-Actor is required
        Assert.Equal(400, (await client.GetApiAsync("/workflow-runs?status=exploded")).StatusCode);
    }

    [PostgresFact]
    public async Task AFailedIntakeRunAndAFailedDeadlineRunAreRestartedThroughTheirOwnEntryPoints()
    {
        var claim = await LifeScenario.GatheringAsync(fixture);
        var number = await Sql.SingleAsync<string>("SELECT claim_number FROM claims WHERE id = @c", new { c = claim.ClaimId });
        var eventId = Guid.NewGuid();
        await Runs.BeginAsync("orch-" + number + "-intake", "t1", "orchestration", "Intake checks and set-up", claim.ClaimId, "Outbox relay", "outbox_event", eventId, fixture.Clock.UtcNow);
        await Runs.FinishAsync("orch-" + number + "-intake", "t1", "failed", [], [], "boom", fixture.Clock.UtcNow);
        var row = await Sql.SingleAsync<Guid>("SELECT id FROM deadlines WHERE claim_id = @c AND kind = 'requirement_follow_up' LIMIT 1", new { c = claim.ClaimId });
        await Runs.BeginAsync("deadline-" + row, "t1", "deadline", "Requirement follow-up", claim.ClaimId, "Dispatcher", "deadline", row, fixture.Clock.UtcNow);
        await Runs.FinishAsync("deadline-" + row, "t1", "failed", [], [], "boom", fixture.Clock.UtcNow);
        fixture.Launcher.Reset();
        var client = fixture.CreateClient();

        Assert.Equal(202, (await client.PostApiAsync($"/workflow-runs/{await RunIdAsync("orch-" + number + "-intake", "t1")}:rerun", null, Ops())).StatusCode);
        Assert.Equal(202, (await client.PostApiAsync($"/workflow-runs/{await RunIdAsync("deadline-" + row, "t1")}:rerun", null, Ops())).StatusCode);

        Assert.Equal([number], fixture.Launcher.StartedIntakes);
        Assert.Equal([row], fixture.Launcher.StartedDeadlines);
    }
}
