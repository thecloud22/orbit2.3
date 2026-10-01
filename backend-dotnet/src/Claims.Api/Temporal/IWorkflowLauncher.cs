using Claims.Domain;

namespace Claims.Temporal;

public enum StartOutcome { Started, AlreadyStarted }

public sealed record Started(string WorkflowId, StartOutcome Outcome);

/// <summary>An outbox event that has an event workflow. <c>PayloadJson</c> is the payload saved with the event.</summary>
public sealed record EventStart(string EventType, Guid EventId, Guid ClaimId, string PayloadJson);

/// <summary>Which outbox event types have an event workflow (<c>event-&lt;id&gt;</c>). The launcher maps a type to its workflow; add a type here and there.</summary>
public static class EventWorkflows
{
    public const string DecisionRecorded = "decision_recorded";
    public const string ItemsPaid = "items_paid";
    public const string DocumentReceived = "document_received";
    public const string DocumentRejected = "document_rejected";
    public const string PaymentReturned = "payment_returned";
    public const string PaymentMethodUpdated = "payment_method_updated";

    public static bool Handles(string eventType) =>
        eventType is DecisionRecorded or ItemsPaid or DocumentReceived or DocumentRejected or PaymentReturned or PaymentMethodUpdated;

    /// <summary>The workflow id: <c>event-&lt;decisionId&gt;</c> for a decision, <c>event-&lt;outbox event id&gt;</c> for the rest. A second start with the same id is a no-op.</summary>
    public static string WorkflowIdFor(EventStart start)
    {
        if (start.EventType == DecisionRecorded)
        {
            using var payload = System.Text.Json.JsonDocument.Parse(start.PayloadJson);
            return WorkflowIds.Event(Guid.Parse(payload.RootElement.GetProperty("decisionId").GetString()!));
        }
        return Handles(start.EventType) ? WorkflowIds.Event(start.EventId) : throw new ArgumentException($"No event workflow for {start.EventType}");
    }
}

/// <summary>
/// The one seam between our code and Temporal for STARTING workflows. The dispatcher and the outbox relay only know this interface,
/// which is what lets them be tested (and run) without a Temporal server.
/// </summary>
public interface IWorkflowLauncher
{
    /// <summary>Deadline kinds that have a workflow. The dispatcher leaves rows of other kinds alone.</summary>
    IReadOnlySet<DeadlineKind> SupportedDeadlineKinds { get; }

    /// <summary>Starts deadline-&lt;id&gt;. A second start with the same id must not start a second workflow.</summary>
    Task<Started> StartDeadlineWorkflowAsync(DeadlineKind kind, Guid deadlineId);

    /// <summary>Starts orch-&lt;claim number&gt;-intake.</summary>
    Task<Started> StartIntakeAsync(string claimNumber, Guid claimId, Guid eventId);

    /// <summary>
    /// Starts the event workflow for an outbox event (<c>event-&lt;id&gt;</c>): the letters after a decision, the confirmations after a payment run.
    /// One entry point for every event workflow, so a new event type (a document arriving, a bank return) is one more case, not a new seam.
    /// </summary>
    Task<Started> StartEventAsync(EventStart start);
}

public static class WorkflowIds
{
    public static string Deadline(Guid deadlineId) => "deadline-" + deadlineId;

    public static string Intake(string claimNumber) => "orch-" + claimNumber + "-intake";

    /// <summary><c>event-&lt;id&gt;</c>: the id is the decision's for a decision event, the outbox event's for the others.</summary>
    public static string Event(Guid id) => "event-" + id;
}
