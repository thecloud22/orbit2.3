using Claims.Domain;
using Claims.Events;
using Temporalio.Activities;

namespace Claims.Temporal;

/// <summary>What a step that sends a letter reports: it went, and on which attempt (Temporal's, 1 = the first).</summary>
public sealed record SendResult(bool Sent, int Attempts);

/// <summary>
/// What the short event workflow after a document arrives does (<c>event-&lt;outboxEventId&gt;</c>, <see cref="DocumentReceivedWorkflow"/>). Prefixed activity names
/// (DocumentReceived_...) like the other activity classes. Every activity is safe to repeat.
/// </summary>
public sealed class DocumentReceivedActivities(DocumentEventService service)
{
    public sealed record Input(Guid ClaimId, Guid DocumentId, Guid EventId);

    private static ActivityInfo Info => ActivityExecutionContext.Current.Info;
    private static string WorkflowId => Info.WorkflowId ?? throw new InvalidOperationException("Not running inside a workflow");
    private static string RunId => Info.WorkflowRunId ?? throw new InvalidOperationException("Not running inside a workflow");

    /// <summary>Opens the run record and applies the rules: which route this document takes.</summary>
    [Activity("DocumentReceived_Begin")]
    public Task<DocumentEventService.Facts> BeginAsync(Input input) => service.BeginReceivedAsync(input.ClaimId, input.DocumentId, input.EventId, WorkflowId, RunId);

    /// <summary>The IRS check. "No match" comes back as data; only a failure to reach the service throws (and is retried).</summary>
    [Activity("DocumentReceived_CheckTin")]
    public Task<DocumentEventService.TinCheck> CheckTinAsync(Input input) => service.CheckTinAsync(input.DocumentId, Info.Attempt);

    [Activity("DocumentReceived_Accept")]
    public Task<bool> AcceptAsync(Input input, List<RunStep> steps, string note) => service.AcceptAsync(input.DocumentId, steps, note, WorkflowId, RunId);

    [Activity("DocumentReceived_MarkNotEnough")]
    public Task<DocumentEventService.NotEnough> MarkNotEnoughAsync(Input input, string reason) => service.MarkNotEnoughAsync(input.DocumentId, reason, WorkflowId);

    [Activity("DocumentReceived_AskForCorrection")]
    public async Task<SendResult> AskForCorrectionAsync(Input input) => new(await service.AskForCorrectionAsync(input.DocumentId, WorkflowId), Info.Attempt);

    [Activity("DocumentReceived_CompleteNotEnough")]
    public Task CompleteNotEnoughAsync(Input input, List<RunStep> steps, string note) => service.CompleteNotEnoughAsync(input.DocumentId, steps, note, WorkflowId, RunId);

    [Activity("DocumentReceived_HandToPerson")]
    public Task HandToPersonAsync(Input input, string reason, List<RunStep> steps, string note) => service.HandToPersonAsync(input.DocumentId, reason, steps, note, WorkflowId, RunId);

    [Activity("DocumentReceived_RecordFailure")]
    public Task RecordFailureAsync(Input input, string error, List<RunStep> steps) => service.RecordReceivedFailureAsync(input.ClaimId, error, steps, WorkflowId, RunId);
}

/// <summary>What the short event workflow after the examiner rejects a document does (<see cref="DocumentRejectedWorkflow"/>): the "certified copy needed" letter.</summary>
public sealed class DocumentRejectedActivities(DocumentEventService service)
{
    public sealed record Input(Guid ClaimId, Guid DocumentId, Guid EventId);

    private static ActivityInfo Info => ActivityExecutionContext.Current.Info;
    private static string WorkflowId => Info.WorkflowId ?? throw new InvalidOperationException("Not running inside a workflow");
    private static string RunId => Info.WorkflowRunId ?? throw new InvalidOperationException("Not running inside a workflow");

    [Activity("DocumentRejected_Begin")]
    public Task<DocumentEventService.RejectedFacts> BeginAsync(Input input) => service.BeginRejectedAsync(input.ClaimId, input.DocumentId, input.EventId, WorkflowId, RunId);

    /// <summary>REQ-LIFE-03, once per document however often this runs (dedupe key). Fails while the letters service is down: Temporal retries it.</summary>
    [Activity("DocumentRejected_SendLetter")]
    public async Task<SendResult> SendLetterAsync(Input input) => new(await service.SendCertifiedCopyLetterAsync(input.DocumentId, WorkflowId), Info.Attempt);

    [Activity("DocumentRejected_Complete")]
    public Task CompleteAsync(Input input, List<RunStep> steps) => service.CompleteRejectedAsync(input.DocumentId, steps, WorkflowId, RunId);

    /// <summary>Retries exhausted: the run is failed, an ops task is opened (last step), the run stays visible until it is re-run.</summary>
    [Activity("DocumentRejected_RecordFailure")]
    public Task RecordFailureAsync(Input input, string error, List<RunStep> steps) => service.RecordRejectedFailureAsync(input.ClaimId, error, steps, WorkflowId, RunId);
}
