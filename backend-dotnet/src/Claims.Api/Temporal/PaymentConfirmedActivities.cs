using Claims.Domain;
using Claims.Events;
using Temporalio.Activities;

namespace Claims.Temporal;

/// <summary>The short event workflow after a payment run paid a claim's items (<c>event-&lt;outboxEventId&gt;</c>). Every activity is safe to repeat.</summary>
public sealed class PaymentConfirmedActivities(PaymentEventService service)
{
    public sealed record Input(Guid ClaimId, Guid RunId, Guid EventId);

    private static ActivityInfo Info => ActivityExecutionContext.Current.Info;
    private static string WorkflowId => Info.WorkflowId ?? throw new InvalidOperationException("Not running inside a workflow");
    private static string RunId => Info.WorkflowRunId ?? throw new InvalidOperationException("Not running inside a workflow");

    [Activity("PaymentConfirmed_Begin")]
    public Task<PaymentEventService.Facts> BeginAsync(Input input) => service.BeginAsync(input.ClaimId, input.RunId, input.EventId, WorkflowId, RunId);

    [Activity("PaymentConfirmed_SendConfirmations")]
    public Task<int> SendConfirmationsAsync(Input input) => service.SendConfirmationsAsync(input.ClaimId, input.RunId, WorkflowId);

    [Activity("PaymentConfirmed_SendClosingLetter")]
    public Task<bool> SendClosingLetterAsync(Input input) => service.SendClosingLetterAsync(input.ClaimId, input.RunId, WorkflowId);

    [Activity("PaymentConfirmed_TellAgent")]
    public Task<bool> TellAgentAsync(Input input) => service.TellAgentAsync(input.ClaimId, input.RunId, WorkflowId);

    [Activity("PaymentConfirmed_Complete")]
    public Task CompleteAsync(Input input, List<RunStep> steps) => service.CompleteAsync(input.ClaimId, input.RunId, steps, WorkflowId, RunId);

    [Activity("PaymentConfirmed_RecordFailure")]
    public Task RecordFailureAsync(Input input, string error, List<RunStep> steps) => service.RecordFailureAsync(input.ClaimId, error, steps, WorkflowId, RunId);
}
