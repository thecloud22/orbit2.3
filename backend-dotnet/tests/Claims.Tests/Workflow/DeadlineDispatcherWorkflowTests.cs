using Temporalio.Client;
using Claims.Temporal;
using Temporalio.Activities;

namespace Claims.Tests.Workflow;

public class DeadlineDispatcherWorkflowTests(WorkflowEnvironmentFixture fixture) : WorkflowTestBase(fixture)
{
    private sealed class Polls(Func<int, DispatcherActivities.Summary> script)
    {
        private int count;
        public int Count => Volatile.Read(ref count);

        [Activity("Dispatcher_DispatchDue")]
        public Task<DispatcherActivities.Summary> DispatchDueAsync() => Task.FromResult(script(Interlocked.Increment(ref count)));
    }

    private Task<DeadlineDispatcherWorkflow.Total> RunAsync(Polls polls) => WithWorkerAsync(
        o => o.AddWorkflow<DeadlineDispatcherWorkflow>().AddAllActivities(polls),
        queue => Client.ExecuteWorkflowAsync((DeadlineDispatcherWorkflow wf) => wf.RunAsync(), Options("deadline-dispatcher", queue)));

    [Fact]
    public async Task KeepsPollingWhileBatchesComeBackFullThenStops()
    {
        var polls = new Polls(n => n < 3 ? new DispatcherActivities.Summary(25, 25, 0, 0, true) : new DispatcherActivities.Summary(7, 6, 1, 0, false));

        var t = await RunAsync(polls);

        Assert.Equal(3, t.Batches);
        Assert.Equal(57, t.Claimed);
        Assert.Equal(56, t.Started);
        Assert.Equal(1, t.AlreadyStarted);
    }

    [Fact]
    public async Task NeverLoopsForeverEvenIfEveryBatchIsFull()
    {
        var polls = new Polls(_ => new DispatcherActivities.Summary(25, 25, 0, 0, true));

        var t = await RunAsync(polls);

        Assert.Equal(20, t.Batches);      // the rest waits for the next minute's run
        Assert.Equal(20, polls.Count);
    }
}
