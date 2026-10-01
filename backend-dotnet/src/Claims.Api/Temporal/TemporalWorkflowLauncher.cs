using System.Text.Json;
using Claims.Config;
using Claims.Domain;
using Temporalio.Api.Enums.V1;
using Temporalio.Client;
using Temporalio.Exceptions;

namespace Claims.Temporal;

/// <summary>
/// Starts workflows on the org's Temporal namespace and task queue. Workflow ids are the idempotency key:
/// AllowDuplicateFailedOnly means a completed or running workflow with the same id makes the second start a no-op (reported as
/// AlreadyStarted), while a failed one can be started again.
/// </summary>
public sealed class TemporalWorkflowLauncher(ITemporalClient client, ClaimsOptions options) : IWorkflowLauncher
{
    private readonly string taskQueue = options.Temporal.TaskQueue;

    public IReadOnlySet<DeadlineKind> SupportedDeadlineKinds { get; } = new HashSet<DeadlineKind> { DeadlineKind.RequirementFollowUp };

    private WorkflowOptions Options(string workflowId, TimeSpan timeout) => new(workflowId, taskQueue)
    {
        ExecutionTimeout = timeout,
        IdReusePolicy = WorkflowIdReusePolicy.AllowDuplicateFailedOnly,
    };

    public async Task<Started> StartDeadlineWorkflowAsync(DeadlineKind kind, Guid deadlineId)
    {
        var id = WorkflowIds.Deadline(deadlineId);
        if (kind != DeadlineKind.RequirementFollowUp) throw new ArgumentException($"No workflow for deadline kind {kind}");
        try
        {
            await client.StartWorkflowAsync((RequirementFollowUpWorkflow wf) => wf.RunAsync(deadlineId), Options(id, TimeSpan.FromHours(1)));
            return new Started(id, StartOutcome.Started);
        }
        catch (WorkflowAlreadyStartedException)
        {
            return new Started(id, StartOutcome.AlreadyStarted);
        }
    }

    public async Task<Started> StartIntakeAsync(string claimNumber, Guid claimId, Guid eventId)
    {
        var id = WorkflowIds.Intake(claimNumber);
        try
        {
            await client.StartWorkflowAsync((LifeIntakeWorkflow wf) => wf.RunAsync(new LifeIntakeActivities.Input(claimId, eventId)),
                Options(id, TimeSpan.FromHours(6)));
            return new Started(id, StartOutcome.Started);
        }
        catch (WorkflowAlreadyStartedException)
        {
            return new Started(id, StartOutcome.AlreadyStarted);
        }
    }

    /// <summary>Event workflows share one execution timeout (1 hour) and the same id policy: a duplicate is a no-op, a failed run can be started again.</summary>
    public async Task<Started> StartEventAsync(EventStart start)
    {
        var id = EventWorkflows.WorkflowIdFor(start);
        using var payload = JsonDocument.Parse(start.PayloadJson);
        var root = payload.RootElement;
        try
        {
            switch (start.EventType)
            {
                case EventWorkflows.DecisionRecorded:
                {
                    var decisionId = Guid.Parse(root.GetProperty("decisionId").GetString()!);
                    await client.StartWorkflowAsync((DecisionRecordedWorkflow wf) => wf.RunAsync(new DecisionRecordedActivities.Input(start.ClaimId, decisionId, start.EventId)),
                        Options(id, TimeSpan.FromHours(1)));
                    break;
                }
                case EventWorkflows.ItemsPaid:
                {
                    var runId = Guid.Parse(root.GetProperty("runId").GetString()!);
                    await client.StartWorkflowAsync((PaymentConfirmedWorkflow wf) => wf.RunAsync(new PaymentConfirmedActivities.Input(start.ClaimId, runId, start.EventId)),
                        Options(id, TimeSpan.FromHours(1)));
                    break;
                }
                case EventWorkflows.DocumentReceived:
                {
                    var documentId = Guid.Parse(root.GetProperty("documentId").GetString()!);
                    await client.StartWorkflowAsync((DocumentReceivedWorkflow wf) => wf.RunAsync(new DocumentReceivedActivities.Input(start.ClaimId, documentId, start.EventId)),
                        Options(id, TimeSpan.FromHours(1)));
                    break;
                }
                case EventWorkflows.DocumentRejected:
                {
                    var documentId = Guid.Parse(root.GetProperty("documentId").GetString()!);
                    await client.StartWorkflowAsync((DocumentRejectedWorkflow wf) => wf.RunAsync(new DocumentRejectedActivities.Input(start.ClaimId, documentId, start.EventId)),
                        Options(id, TimeSpan.FromHours(1)));
                    break;
                }
                case EventWorkflows.PaymentReturned:
                {
                    var itemId = Guid.Parse(root.GetProperty("paymentItemId").GetString()!);
                    await client.StartWorkflowAsync((PaymentReturnedWorkflow wf) => wf.RunAsync(new PaymentReturnedActivities.Input(start.ClaimId, itemId, start.EventId)),
                        Options(id, TimeSpan.FromHours(1)));
                    break;
                }
                case EventWorkflows.PaymentMethodUpdated:
                {
                    var methodId = Guid.Parse(root.GetProperty("paymentMethodId").GetString()!);
                    await client.StartWorkflowAsync((PaymentMethodUpdatedWorkflow wf) => wf.RunAsync(new PaymentMethodUpdatedActivities.Input(start.ClaimId, methodId, start.EventId)),
                        Options(id, TimeSpan.FromHours(1)));
                    break;
                }
                default:
                    throw new ArgumentException($"No event workflow for {start.EventType}");
            }
            return new Started(id, StartOutcome.Started);
        }
        catch (WorkflowAlreadyStartedException)
        {
            return new Started(id, StartOutcome.AlreadyStarted);
        }
    }
}
