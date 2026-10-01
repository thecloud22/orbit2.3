using Claims.Deadline;
using Claims.Domain;
using Temporalio.Activities;

namespace Claims.Temporal;

/// <summary>
/// Activity type names are prefixed (RequirementFollowUp_...) because several activity classes share one worker and method names
/// such as Begin and RecordFailure repeat. Same names on the wire as the Java version.
/// </summary>
public sealed class RequirementFollowUpActivities(FollowUpService service)
{
    /// <summary>Does this deadline still apply? Also opens the run record.</summary>
    public sealed record Check(bool Applies, string? Reason, string RequirementName, string Recipient, string Channel);

    /// <param name="Outcome">reminded | skipped | already_closed</param>
    public sealed record Result(string Outcome, Guid? NextDeadlineId, string Note);

    private static ActivityInfo Info => ActivityExecutionContext.Current.Info;
    private static string WorkflowId => Info.WorkflowId ?? throw new InvalidOperationException("Not running inside a workflow");
    private static string RunId => Info.WorkflowRunId ?? throw new InvalidOperationException("Not running inside a workflow");

    [Activity("RequirementFollowUp_Begin")]
    public Task<Check> BeginAsync(Guid deadlineId) => service.BeginAsync(deadlineId, WorkflowId, RunId);

    /// <summary>Sends the reminder, once per deadline (dedupe key), however often this is retried.</summary>
    [Activity("RequirementFollowUp_SendReminder")]
    public Task SendReminderAsync(Guid deadlineId) => service.SendReminderAsync(deadlineId, WorkflowId);

    /// <summary>One transaction: this deadline done, the next row written, the reminder in the history, the run saved.</summary>
    [Activity("RequirementFollowUp_CompleteFollowUp")]
    public Task<Result> CompleteFollowUpAsync(Guid deadlineId, List<RunStep> steps) =>
        service.CompleteAsync(deadlineId, steps, WorkflowId, RunId);

    /// <summary>The deadline no longer applies: mark it skipped and record why.</summary>
    [Activity("RequirementFollowUp_Skip")]
    public Task<Result> SkipAsync(Guid deadlineId, string reason, List<RunStep> steps) =>
        service.SkipAsync(deadlineId, reason, steps, WorkflowId, RunId);

    /// <summary>Retries are exhausted: mark the run failed, leave the deadline dispatched, open an ops task.</summary>
    [Activity("RequirementFollowUp_RecordFailure")]
    public Task RecordFailureAsync(Guid deadlineId, string error, List<RunStep> steps) =>
        service.RecordFailureAsync(deadlineId, error, steps, WorkflowId, RunId);
}
