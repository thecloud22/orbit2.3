using Claims.Domain;
using Claims.Events;
using Temporalio.Activities;

namespace Claims.Temporal;

/// <summary>What the short event workflow after a returned payment does (<see cref="PaymentReturnedWorkflow"/>): the claim side of what the returns batch saved.</summary>
public sealed class PaymentReturnedActivities(PaymentReturnEventService service)
{
    public sealed record Input(Guid ClaimId, Guid PaymentItemId, Guid EventId);

    private static ActivityInfo Info => ActivityExecutionContext.Current.Info;
    private static string WorkflowId => Info.WorkflowId ?? throw new InvalidOperationException("Not running inside a workflow");
    private static string RunId => Info.WorkflowRunId ?? throw new InvalidOperationException("Not running inside a workflow");

    [Activity("PaymentReturned_Begin")]
    public Task<PaymentReturnEventService.ReturnFacts> BeginAsync(Input input) => service.BeginReturnedAsync(input.ClaimId, input.PaymentItemId, input.EventId, WorkflowId, RunId);

    /// <summary>One transaction: closed → reopened, the payee's details row, the examiner's work item. Postgres only.</summary>
    [Activity("PaymentReturned_Reopen")]
    public Task<PaymentReturnEventService.ReopenResult> ReopenAsync(Input input) => service.ReopenAsync(input.PaymentItemId, WorkflowId);

    [Activity("PaymentReturned_AskForNewAccount")]
    public async Task<SendResult> AskForNewAccountAsync(Input input) => new(await service.AskForNewAccountAsync(input.PaymentItemId, WorkflowId), Info.Attempt);

    [Activity("PaymentReturned_Complete")]
    public Task CompleteAsync(Input input, List<RunStep> steps, string note) => service.CompleteReturnedAsync(input.ClaimId, input.PaymentItemId, steps, note, WorkflowId, RunId);

    [Activity("PaymentReturned_RecordFailure")]
    public Task RecordFailureAsync(Input input, string error, List<RunStep> steps) => service.RecordReturnedFailureAsync(input.ClaimId, error, steps, WorkflowId, RunId);
}

/// <summary>What the short event workflow after a payee's new account does (<see cref="PaymentMethodUpdatedWorkflow"/>): verify it with the bank and tell the payee.</summary>
public sealed class PaymentMethodUpdatedActivities(PaymentReturnEventService service)
{
    public sealed record Input(Guid ClaimId, Guid PaymentMethodId, Guid EventId);

    private static ActivityInfo Info => ActivityExecutionContext.Current.Info;
    private static string WorkflowId => Info.WorkflowId ?? throw new InvalidOperationException("Not running inside a workflow");
    private static string RunId => Info.WorkflowRunId ?? throw new InvalidOperationException("Not running inside a workflow");

    [Activity("PaymentMethodUpdated_Begin")]
    public Task<PaymentReturnEventService.MethodFacts> BeginAsync(Input input) => service.BeginMethodAsync(input.ClaimId, input.PaymentMethodId, input.EventId, WorkflowId, RunId);

    /// <summary>The bank's answer ("not verified" is data, not an error); an unreachable bank throws and is retried.</summary>
    [Activity("PaymentMethodUpdated_VerifyAccount")]
    public Task<PaymentReturnEventService.Verified> VerifyAccountAsync(Input input) => service.VerifyAccountAsync(input.PaymentMethodId, Info.Attempt);

    [Activity("PaymentMethodUpdated_Confirm")]
    public async Task<SendResult> ConfirmAsync(Input input) => new(await service.ConfirmAsync(input.PaymentMethodId, WorkflowId), Info.Attempt);

    [Activity("PaymentMethodUpdated_Reject")]
    public Task<int> RejectAsync(Input input, string detail) => service.RejectAsync(input.PaymentMethodId, detail, WorkflowId);

    [Activity("PaymentMethodUpdated_Complete")]
    public Task CompleteAsync(Input input, string status, List<RunStep> steps, string note) => service.CompleteMethodAsync(input.ClaimId, input.PaymentMethodId, status, steps, note, WorkflowId, RunId);

    [Activity("PaymentMethodUpdated_RecordFailure")]
    public Task RecordFailureAsync(Input input, string error, List<RunStep> steps) => service.RecordMethodFailureAsync(input.ClaimId, error, steps, WorkflowId, RunId);
}
