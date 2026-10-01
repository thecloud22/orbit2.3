using Claims.Deadline;
using Temporalio.Activities;

namespace Claims.Temporal;

/// <summary>Activity type names are prefixed (Dispatcher_...) for the same reason as the other activity classes.</summary>
public sealed class DispatcherActivities(DeadlineDispatcher dispatcher)
{
    public sealed record Summary(int Claimed, int Started, int AlreadyStarted, int Failed, bool More);

    /// <summary>One poll of the deadlines table.</summary>
    [Activity("Dispatcher_DispatchDue")]
    public async Task<Summary> DispatchDueAsync()
    {
        var r = await dispatcher.DispatchDueAsync();
        return new Summary(r.Claimed, r.Started, r.AlreadyStarted, r.Failed, r.BatchWasFull);
    }
}
