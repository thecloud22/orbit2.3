using System.Collections.Concurrent;
using Claims.Domain;
using Claims.Temporal;

namespace Claims.Tests.Support;

/// <summary>Stands in for Temporal in dispatcher and API tests: records every start, and can be told to fail or repeat.</summary>
public sealed class RecordingLauncher : IWorkflowLauncher
{
    public ConcurrentQueue<Guid> StartedDeadlines { get; } = new();
    public ConcurrentQueue<string> StartedIntakes { get; } = new();
    public ConcurrentQueue<EventStart> StartedEvents { get; } = new();
    public ConcurrentDictionary<Guid, bool> FailFor { get; } = new();
    public ConcurrentDictionary<Guid, bool> AlreadyStarted { get; } = new();
    public ConcurrentDictionary<Guid, int> Attempts { get; } = new();
    public volatile int StartDelayMillis;

    public IReadOnlySet<DeadlineKind> SupportedDeadlineKinds { get; } = new HashSet<DeadlineKind> { DeadlineKind.RequirementFollowUp };

    public void Reset()
    {
        StartedDeadlines.Clear();
        StartedIntakes.Clear();
        StartedEvents.Clear();
        FailFor.Clear();
        AlreadyStarted.Clear();
        Attempts.Clear();
        StartDelayMillis = 0;
    }

    public async Task<Started> StartDeadlineWorkflowAsync(DeadlineKind kind, Guid deadlineId)
    {
        Attempts.AddOrUpdate(deadlineId, 1, (_, n) => n + 1);
        if (StartDelayMillis > 0) await Task.Delay(StartDelayMillis);
        if (FailFor.ContainsKey(deadlineId)) throw new InvalidOperationException("Temporal unavailable");
        var id = WorkflowIds.Deadline(deadlineId);
        if (AlreadyStarted.ContainsKey(deadlineId)) return new Started(id, StartOutcome.AlreadyStarted);
        StartedDeadlines.Enqueue(deadlineId);
        return new Started(id, StartOutcome.Started);
    }

    public Task<Started> StartIntakeAsync(string claimNumber, Guid claimId, Guid eventId)
    {
        StartedIntakes.Enqueue(claimNumber);
        return Task.FromResult(new Started(WorkflowIds.Intake(claimNumber), StartOutcome.Started));
    }

    public Task<Started> StartEventAsync(EventStart start)
    {
        StartedEvents.Enqueue(start);
        return Task.FromResult(new Started(EventWorkflows.WorkflowIdFor(start), StartOutcome.Started));
    }
}
