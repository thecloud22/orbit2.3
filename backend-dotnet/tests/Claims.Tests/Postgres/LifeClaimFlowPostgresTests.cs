using Claims.Common;
using Claims.Config;
using Claims.Deadline;
using Claims.Gateway;
using Claims.Intake;
using Claims.Outbox;
using Claims.Requirement;
using Claims.Temporal;
using Claims.Tests.Support;
using Microsoft.Extensions.DependencyInjection;
using Temporalio.Client;
using Temporalio.Testing;
using Temporalio.Worker;

namespace Claims.Tests.Postgres;

/// <summary>
/// REQUIRES POSTGRES. The whole slice together: real services, real SQL, real activities, the real launcher code, and Temporal's
/// in-process time-skipping test server. Nothing here fakes a database or the workflow logic; only the outside systems (sanctions,
/// notifications) are stubs, and sanctions times out once to show the retry.
/// </summary>
[TestCaseOrderer(typeof(OrderAttributeOrderer))]
public class LifeClaimFlowPostgresTests(LifeClaimFlowPostgresTests.Fixture fixture) : IClassFixture<LifeClaimFlowPostgresTests.Fixture>
{
    private static int sanctionsCalls;

    private sealed class FlakySanctions : ISanctionsGateway
    {
        public Task<Screening> ScreenAsync(IReadOnlyList<string> names) =>
            Interlocked.Increment(ref sanctionsCalls) == 1
                ? throw new InvalidOperationException("sanctions service timed out")
                : Task.FromResult(new Screening(true, "ref-ok"));
    }

    public sealed class Fixture : PostgresApiFixture
    {
        private CancellationTokenSource? stop;
        private Task? workerTask;

        public WorkflowEnvironment Env { get; private set; } = null!;

        protected override string Hint => "flow";

        protected override async Task BeforeStartAsync() =>
            Env = await WorkflowEnvironment.StartTimeSkippingAsync(new WorkflowEnvironmentStartTimeSkippingOptions { DataConverter = TemporalSetup.DataConverterFor() });

        protected override void ConfigureServices(IServiceCollection services)
        {
            // The production launcher, on the test server.
            services.AddSingleton<IWorkflowLauncher>(sp => new TemporalWorkflowLauncher(Env.Client, sp.GetRequiredService<ClaimsOptions>()));
            services.AddSingleton<ISanctionsGateway, FlakySanctions>();
        }

        protected override Task StartedAsync()
        {
            // The dispatcher workflow is not run here (the test calls DispatchDueAsync itself), so its activities are not registered.
            var worker = new TemporalWorker(Env.Client, TemporalWorkerService.WorkerOptions("claims",
                Get<LifeIntakeActivities>(), Get<RequirementFollowUpActivities>()));
            stop = new CancellationTokenSource();
            workerTask = worker.ExecuteAsync(stop.Token);
            return Task.CompletedTask;
        }

        public override async ValueTask DisposeAsync()
        {
            if (stop is not null)
            {
                await stop.CancelAsync();
                try { await workerTask!; } catch (OperationCanceledException) { }
            }
            await base.DisposeAsync();
            if (Env is not null) await Env.ShutdownAsync();
        }
    }

    private static Guid claimId;
    private static string claimNumber = "";
    private static Guid rachel;

    private Db Sql => fixture.Db;

    private Task<T> One<T>(string sql, object? param = null) => Sql.SingleAsync<T>(sql, param);

    private Task<T> ResultAsync<T>(string workflowId) => fixture.Env.Client.GetWorkflowHandle(workflowId).GetResultAsync<T>();

    private Task<Guid> RequirementIdAsync(string namePart) =>
        One<Guid>("SELECT id FROM requirements WHERE claim_id = @c AND name LIKE @n", new { c = claimId, n = "%" + namePart + "%" });

    private Task<Guid> FollowUpForAsync(Guid requirement) =>
        One<Guid>("SELECT id FROM deadlines WHERE requirement_id = @r AND state IN ('open', 'dispatched')", new { r = requirement });

    private Task MakeDueAsync(Guid deadline) => Sql.ExecuteAsync(
        "UPDATE deadlines SET due_at = now() - interval '1 minute', original_due_at = now() - interval '1 minute' WHERE id = @id", new { id = deadline });

    [PostgresFact, Order(1)]
    public async Task SubmitCommitsAndReturnsBeforeAnyWorkflowRuns()
    {
        rachel = await One<Guid>("INSERT INTO staff_users (handle, display_name, team, role, payout_limit) VALUES ('rachel', 'Rachel Kim', 'Life & annuity team', 'life_examiner', 250000) RETURNING id");

        var claim = (await fixture.Get<LifeIntakeService>().SubmitAsync(TestData.Castellano("natural"), "flow-" + Guid.NewGuid(), Actor.User("diane.intake"))).Claim;
        claimId = claim.Id;
        claimNumber = claim.ClaimNumber;

        Assert.Equal("received", claim.Status);
        Assert.Equal(0, await One<int>("SELECT count(*) FROM workflow_runs WHERE claim_id = @c", new { c = claimId }));
        Assert.Equal(0, await One<int>("SELECT count(*) FROM letters WHERE claim_id = @c", new { c = claimId }));
    }

    [PostgresFact, Order(2)]
    public async Task OutboxRelayStartsTheIntakeOrchestrationAndItSetsTheClaimUp()
    {
        Assert.Equal(1, await fixture.Get<OutboxRelay>().PublishPendingAsync());

        var r = await ResultAsync<LifeIntakeWorkflow.Result>("orch-" + claimNumber + "-intake");

        Assert.Equal("set_up", r.Outcome);
        Assert.Equal(2, Volatile.Read(ref sanctionsCalls));      // timed out once, retried by Temporal
        // The claim moved on, routed by rule LF-01 and owned by the least-loaded examiner.
        Assert.Equal("gathering_evidence/fast_track_life/LF-01", await One<string>("SELECT status || '/' || track || '/' || route_rule FROM claims WHERE id = @c", new { c = claimId }));
        Assert.Equal(rachel, await One<Guid>("SELECT owner_id FROM claims WHERE id = @c", new { c = claimId }));
        // Acknowledge and forms rows were closed by the run, never having fired; the other five are still open.
        Assert.Equal(["acknowledge_by", "forms_by"], await Sql.ListAsync<string>(
            "SELECT kind FROM deadlines WHERE claim_id = @c AND state = 'done' AND closed_by = 'intake' AND fired = false ORDER BY kind", new { c = claimId }));
        Assert.Equal(5, await One<int>("SELECT count(*) FROM deadlines WHERE claim_id = @c AND state = 'open'", new { c = claimId }));
        // Letters: acknowledgement, a packet for each payee, and the agent notice (consent was given).
        Assert.Equal(["ACK-LIFE-01", "AGT-NOTE-01", "PKT-LIFE-02", "PKT-LIFE-02"], await Sql.ListAsync<string>(
            "SELECT template_code FROM letters WHERE claim_id = @c AND status = 'sent' ORDER BY template_code, recipient_label", new { c = claimId }));
        // The examiner's queue and the run record.
        Assert.Equal("New life claim: welcome call to Diane", await One<string>("SELECT action FROM work_items WHERE claim_id = @c AND owner_id = @o", new { c = claimId, o = rachel }));
        var wf = "orch-" + claimNumber + "-intake";
        Assert.Equal("completed", await One<string>("SELECT status FROM workflow_runs WHERE workflow_id = @w", new { w = wf }));
        Assert.True(await One<bool>("SELECT steps @> '[{\"label\": \"Screen the beneficiaries\", \"state\": \"retried\"}]'::jsonb FROM workflow_runs WHERE workflow_id = @w", new { w = wf }));
        Assert.Equal(6, await One<int>("SELECT jsonb_array_length(steps) FROM workflow_runs WHERE workflow_id = @w", new { w = wf }));
        Assert.Equal(1, await One<int>("SELECT count(*) FROM outbox_events WHERE claim_id = @c AND published_at IS NOT NULL", new { c = claimId }));
    }

    [PostgresFact, Order(3)]
    public async Task ARepeatedOutboxPublishStartsNothingNew()
    {
        // Simulate the relay crashing after starting the workflow but before stamping published_at.
        await Sql.ExecuteAsync("UPDATE outbox_events SET published_at = NULL WHERE claim_id = @c", new { c = claimId });
        var lettersBefore = await One<int>("SELECT count(*) FROM letters WHERE claim_id = @c", new { c = claimId });

        Assert.Equal(1, await fixture.Get<OutboxRelay>().PublishPendingAsync());    // published again: the start reported AlreadyStarted

        Assert.Equal(1, await One<int>("SELECT count(*) FROM workflow_runs WHERE claim_id = @c", new { c = claimId }));
        Assert.Equal(lettersBefore, await One<int>("SELECT count(*) FROM letters WHERE claim_id = @c", new { c = claimId }));
        Assert.Equal(1, await One<int>("SELECT count(*) FROM outbox_events WHERE claim_id = @c AND published_at IS NOT NULL", new { c = claimId }));
    }

    [PostgresFact, Order(4)]
    public async Task ADueFollowUpFiresRemindsAndWritesTheNextRow()
    {
        var mark = await RequirementIdAsync("Mark");
        var row = await FollowUpForAsync(mark);
        await MakeDueAsync(row);

        var d = await fixture.Get<DeadlineDispatcher>().DispatchDueAsync();
        Assert.Equal(1, d.Started);
        var r = await ResultAsync<RequirementFollowUpActivities.Result>("deadline-" + row);

        Assert.Equal("reminded", r.Outcome);
        // This row is done and fired; the dispatcher's attempt is on record.
        Assert.Equal("done:true:workflow:1:completed",
            await One<string>("SELECT state || ':' || fired || ':' || closed_by || ':' || attempt || ':' || last_outcome FROM deadlines WHERE id = @id", new { id = row }));
        Assert.Equal(1, await One<int>("SELECT count(*) FROM deadline_attempts WHERE deadline_id = @id AND outcome = 'started'", new { id = row }));
        // Exactly one new live row for Mark, ten days out at 08:00 Central.
        var next = await FollowUpForAsync(mark);
        Assert.NotEqual(row, next);
        Assert.Equal(r.NextDeadlineId, next);
        var due = (await Sql.QueryAsync("SELECT due_at FROM deadlines WHERE id = @id", new { id = next }, x => x.Instant("due_at")))[0];
        Assert.InRange(due, DateTimeOffset.UtcNow.AddDays(9), DateTimeOffset.UtcNow.AddDays(11));
        Assert.Equal("08:00:00", await One<string>("SELECT (due_at AT TIME ZONE 'America/Chicago')::time::text FROM deadlines WHERE id = @id", new { id = next }));
        Assert.Equal(1, await One<int>("SELECT follow_up_count FROM requirements WHERE id = @id", new { id = mark }));
        Assert.Equal("REM-LIFE-01:email:sent",
            await One<string>("SELECT template_code || ':' || channel || ':' || status FROM letters WHERE claim_id = @c AND source_id = @d", new { c = claimId, d = row }));
        Assert.Equal("completed", await One<string>("SELECT status FROM workflow_runs WHERE workflow_id = @w", new { w = "deadline-" + row }));
        Assert.Equal(1, await One<int>("SELECT count(*) FROM history_events WHERE claim_id = @c AND workflow_id = @w AND title LIKE 'Reminder sent%'", new { c = claimId, w = "deadline-" + row }));
        // Nothing else is due: another poll starts nothing.
        Assert.Equal(0, (await fixture.Get<DeadlineDispatcher>().DispatchDueAsync()).Claimed);
    }

    [PostgresFact, Order(5)]
    public async Task ARequirementMetWhileItsRowWasWaitingIsSkippedNotReminded()
    {
        var diane = await RequirementIdAsync("Diane");
        var row = await FollowUpForAsync(diane);
        // A requirement that was met by some path that did not close the row (the race the workflow re-check guards).
        await Sql.ExecuteAsync("UPDATE requirements SET state = 'accepted', accepted_at = now(), received_at = now() WHERE id = @id", new { id = diane });
        await MakeDueAsync(row);
        var lettersBefore = await One<int>("SELECT count(*) FROM letters WHERE claim_id = @c", new { c = claimId });

        await fixture.Get<DeadlineDispatcher>().DispatchDueAsync();
        var r = await ResultAsync<RequirementFollowUpActivities.Result>("deadline-" + row);

        Assert.Equal("skipped", r.Outcome);
        Assert.StartsWith("skipped:false:Skipped: Requirement is already accepted", await One<string>("SELECT state || ':' || fired || ':' || result FROM deadlines WHERE id = @id", new { id = row }));
        Assert.Equal(lettersBefore, await One<int>("SELECT count(*) FROM letters WHERE claim_id = @c", new { c = claimId }));   // no reminder
        Assert.Equal(0, await One<int>("SELECT count(*) FROM deadlines WHERE requirement_id = @r AND state IN ('open', 'dispatched')", new { r = diane }));   // no next row
        Assert.Equal("skipped", await One<string>("SELECT status FROM workflow_runs WHERE workflow_id = @w", new { w = "deadline-" + row }));
    }

    [PostgresFact, Order(6)]
    public async Task AcceptingTheRemainingRequirementsLeavesNothingScheduledAndCompletesProofOfLoss()
    {
        var mark = await RequirementIdAsync("Mark");
        var cert = await RequirementIdAsync("death certificate");
        foreach (var r in new[] { mark, cert })
        {
            var version = await One<long>("SELECT version FROM requirements WHERE id = @id", new { id = r });
            await fixture.Get<RequirementService>().AcceptAsync(r, version, "Received", Actor.User("rachel"));
        }

        // Stop when met: no follow-up row is left live on any requirement.
        Assert.Equal(0, await One<int>("SELECT count(*) FROM deadlines WHERE claim_id = @c AND kind = 'requirement_follow_up' AND state IN ('open', 'dispatched')", new { c = claimId }));
        // Proof of loss complete: the decision clock and review target exist, the claim is in review, the examiner has work.
        Assert.Equal("in_review", await One<string>("SELECT status FROM claims WHERE id = @c", new { c = claimId }));
        Assert.Equal(["decision_due", "review_target"], await Sql.ListAsync<string>(
            "SELECT kind FROM deadlines WHERE claim_id = @c AND state = 'open' AND kind IN ('decision_due', 'review_target') ORDER BY kind", new { c = claimId }));
        Assert.Equal(rachel, await One<Guid>("SELECT owner_id FROM work_items WHERE claim_id = @c AND action = 'Record decision: Robert Castellano'", new { c = claimId }));
        // And the dispatcher has nothing to do for this claim.
        Assert.Equal(0, (await fixture.Get<DeadlineDispatcher>().DispatchDueAsync()).Claimed);
    }
}
