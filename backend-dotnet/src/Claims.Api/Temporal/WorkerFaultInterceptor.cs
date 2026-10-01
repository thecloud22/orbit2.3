using Claims.Config;
using Claims.Gateway;
using Claims.Store;
using Temporalio.Activities;
using Temporalio.Worker.Interceptors;

namespace Claims.Temporal;

/// <summary>
/// DEV ONLY (does nothing unless a fault is on): the fault <c>worker.stall-once:&lt;activity type&gt;</c> demonstrates "a deploy restarted the worker in the middle of a step".
/// The FIRST execution of the named activity runs to the end (so it has done its work, for example sent its letters) and then hangs, past the activity's
/// StartToClose timeout, without reporting back, exactly what a worker killed after acting and before answering looks like from Temporal's side. Temporal times the attempt out and
/// runs the activity again (attempt 2, on this or another worker), which succeeds. Because every letter goes through <c>LetterService.SendOnceAsync</c> with an idempotency key,
/// the second attempt sends nothing twice. The fault is consumed atomically, so exactly one execution stalls, and the run record gets a note saying so.
/// </summary>
public sealed class WorkerFaultInterceptor(IFaultRegistry faults, WorkflowRunRepository runs, ClaimsOptions options, TimeProvider timers) : IWorkerInterceptor
{
    public WorkflowInboundInterceptor InterceptWorkflow(WorkflowInboundInterceptor nextInterceptor) => nextInterceptor;

    public ActivityInboundInterceptor InterceptActivity(ActivityInboundInterceptor nextInterceptor) => new Inbound(nextInterceptor, this);

    private sealed class Inbound(ActivityInboundInterceptor next, WorkerFaultInterceptor owner) : ActivityInboundInterceptor(next)
    {
        public override async Task<object?> ExecuteActivityAsync(ExecuteActivityInput input)
        {
            var result = await base.ExecuteActivityAsync(input);
            await owner.MaybeStallAsync(input.Activity.Name ?? "");
            return result;
        }
    }

    /// <summary>The activity has done its work: if a stall is armed for it, consume it (once, atomically) and hang.</summary>
    private async Task MaybeStallAsync(string activityType)
    {
        var fault = FaultCatalog.StallOnce(activityType);
        if (faults.TryConsume(fault)) await StallAsync(fault);
    }

    private async Task StallAsync(string fault)
    {
        var context = ActivityExecutionContext.Current;
        var info = context.Info;
        var stall = options.Dev.StallFor;
        var note = $"Fault {fault}: attempt {info.Attempt} did its work and then the worker stopped answering for {stall.TotalSeconds:0} s, past the {info.StartToCloseTimeout?.TotalSeconds ?? 30:0} s StartToClose timeout, " +
                   "like a worker killed by a deploy before it reported back. Temporal timed the attempt out and ran the step again; the letters carry idempotency keys, so nothing goes twice.";
        faults.Record(fault, $"{info.ActivityType} attempt {info.Attempt} in {info.WorkflowId}: worked, then stalled {stall.TotalSeconds:0} s");
        if (info.WorkflowId is { } wf && info.WorkflowRunId is { } run)
        {
            try { await runs.AppendNoteAsync(wf, run, note); }
            catch (Exception) { /* a note is a courtesy: never let it change what the activity did */ }
        }
        try { await Task.Delay(stall, timers, context.CancellationToken); }
        catch (OperationCanceledException) { /* the worker is shutting down, or Temporal cancelled the attempt: stop stalling */ }
    }
}
