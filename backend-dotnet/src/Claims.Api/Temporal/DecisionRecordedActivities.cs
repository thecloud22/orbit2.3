using Claims.Domain;
using Claims.Events;
using Temporalio.Activities;

namespace Claims.Temporal;

/// <summary>
/// What the short event workflow after a decision does (<c>event-&lt;decisionId&gt;</c>). Prefixed activity names (DecisionRecorded_...) for the same
/// reason as the other activity classes. Every activity is safe to repeat.
/// </summary>
public sealed class DecisionRecordedActivities(DecisionEventService service)
{
    public sealed record Input(Guid ClaimId, Guid DecisionId, Guid EventId);

    private static ActivityInfo Info => ActivityExecutionContext.Current.Info;
    private static string WorkflowId => Info.WorkflowId ?? throw new InvalidOperationException("Not running inside a workflow");
    private static string RunId => Info.WorkflowRunId ?? throw new InvalidOperationException("Not running inside a workflow");

    /// <summary>Opens the run record and loads what the workflow needs to describe its steps.</summary>
    [Activity("DecisionRecorded_Begin")]
    public Task<DecisionEventService.Facts> BeginAsync(Input input) => service.BeginAsync(input.DecisionId, input.EventId, WorkflowId, RunId);

    /// <summary>APR-LIFE-01 to each payee (idempotency key per letter). Returns the letters sent.</summary>
    [Activity("DecisionRecorded_SendApprovalLetters")]
    public Task<int> SendApprovalLettersAsync(Guid decisionId) => service.SendApprovalLettersAsync(decisionId, WorkflowId);

    [Activity("DecisionRecorded_TellAgent")]
    public Task<bool> TellAgentAsync(Guid decisionId) => service.TellAgentAsync(decisionId, WorkflowId);

    [Activity("DecisionRecorded_Complete")]
    public Task CompleteAsync(Guid decisionId, List<RunStep> steps) => service.CompleteAsync(decisionId, steps, WorkflowId, RunId);

    [Activity("DecisionRecorded_RecordFailure")]
    public Task RecordFailureAsync(Guid decisionId, string error, List<RunStep> steps) => service.RecordFailureAsync(decisionId, error, steps, WorkflowId, RunId);
}
