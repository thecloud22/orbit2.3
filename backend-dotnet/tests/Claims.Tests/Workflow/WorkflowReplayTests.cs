using Claims.Temporal;
using Temporalio.Client;
using Temporalio.Worker;

namespace Claims.Tests.Workflow;

/// <summary>
/// Not a port of a Java test (the Java slice lists replay tests as "not built"). Runs the intake workflow once, takes its recorded history and
/// replays it against the current workflow code: this fails if a change to the workflow is not backward compatible with runs already in flight.
/// In CI, the histories of real runs (exported from Temporal) belong here as well.
/// </summary>
public class WorkflowReplayTests(WorkflowEnvironmentFixture fixture) : WorkflowTestBase(fixture)
{
    [Fact]
    public async Task ARecordedIntakeRunReplaysAgainstTheCurrentWorkflowCode()
    {
        var acts = new FakeLifeIntakeActivities();
        acts.FailSanctionsTimes(1);   // a history with a retry in it

        var history = await WithWorkerAsync(
            o => o.AddWorkflow<LifeIntakeWorkflow>().AddAllActivities(acts),
            async queue =>
            {
                var handle = await Client.StartWorkflowAsync(
                    (LifeIntakeWorkflow wf) => wf.RunAsync(new LifeIntakeActivities.Input(Guid.NewGuid(), Guid.NewGuid())), Options("orch-replay", queue));
                await handle.GetResultAsync();
                return await handle.FetchHistoryAsync();
            });

        var replayer = new WorkflowReplayer(new WorkflowReplayerOptions { DataConverter = Claims.Temporal.TemporalSetup.DataConverterFor() }
            .AddWorkflow<LifeIntakeWorkflow>());
        var result = await replayer.ReplayWorkflowAsync(history, true, TestContext.Current.CancellationToken);   // throws if the history no longer replays

        Assert.Null(result.ReplayFailure);
    }
}
