using Temporalio.Common;
using Temporalio.Workflows;

namespace Claims.Temporal;

/// <summary>Run by a Temporal Schedule every minute. Not a long-running loop: each run polls and ends.</summary>
[Workflow("DeadlineDispatcherWorkflow")]
public class DeadlineDispatcherWorkflow
{
    private const int MaxBatches = 20;

    public sealed record Total(int Batches, int Claimed, int Started, int AlreadyStarted, int Failed);

    private static readonly ActivityOptions Options = new()
    {
        StartToCloseTimeout = TimeSpan.FromSeconds(120),
        RetryPolicy = new RetryPolicy { MaximumAttempts = 3 },
    };

    [WorkflowRun]
    public async Task<Total> RunAsync()
    {
        int batches = 0, claimed = 0, started = 0, already = 0, failed = 0;
        while (batches < MaxBatches)
        {
            var s = await Workflow.ExecuteActivityAsync((DispatcherActivities a) => a.DispatchDueAsync(), Options);
            batches++;
            claimed += s.Claimed;
            started += s.Started;
            already += s.AlreadyStarted;
            failed += s.Failed;
            if (!s.More) break;
        }
        return new Total(batches, claimed, started, already, failed);
    }
}
