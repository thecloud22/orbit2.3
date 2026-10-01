using Claims.Clock;
using System.Text.Json;
using Claims.Common;
using Claims.Config;
using Claims.Store;
using Claims.Temporal;

namespace Claims.Outbox;

/// <summary>
/// Reads outbox rows saved with a change and starts the workflow for each. Same shape as the dispatcher: lock with SKIP LOCKED,
/// start (the workflow id makes a repeat a no-op), stamp published_at, commit. If the API crashed after saving, the relay still
/// starts the workflow; if the relay retries, the second start does nothing.
/// Events with a workflow: notice_of_death_received (the intake orchestration) and, through the launcher's one event entry point, decision_recorded
/// and items_paid. Other event types stay unpublished until they have a workflow.
/// </summary>
public sealed partial class OutboxRelay(OutboxRepository outbox, IWorkflowLauncher launcher, Db db, ClaimsOptions options, IClock clock,
                                        ILogger<OutboxRelay> log)
{
    internal const string Notice = "notice_of_death_received";

    /// <summary>One pass. Returns how many events were published.</summary>
    public Task<int> PublishPendingAsync() => db.InTransactionAsync(async () =>
    {
        var now = clock.UtcNow;
        var events = await outbox.LockUnpublishedAsync(now, options.Outbox.BatchSize);
        var published = 0;
        foreach (var e in events)
        {
            if (e.Type != Notice && !EventWorkflows.Handles(e.Type)) continue;    // no workflow for this type yet: leave it for later
            try
            {
                Started s;
                if (e.Type == Notice)
                {
                    using var payload = JsonDocument.Parse(e.Payload);
                    var claimNumber = payload.RootElement.GetProperty("claimNumber").GetString()!;
                    s = await launcher.StartIntakeAsync(claimNumber, e.ClaimId!.Value, e.Id);
                }
                else
                {
                    s = await launcher.StartEventAsync(new EventStart(e.Type, e.Id, e.ClaimId!.Value, e.Payload));
                }
                await outbox.MarkPublishedAsync(e.Id, s.WorkflowId, now);
                published++;
            }
            catch (Exception ex) when (ex is not OperationCanceledException)
            {
                LogFailed(e.Id, ex.ToString());
                await outbox.MarkFailedAsync(e.Id, ex.ToString(), now + options.Outbox.RetryBase * Math.Min(e.Attempts + 1, 12));
            }
        }
        return published;
    });

    [LoggerMessage(Level = LogLevel.Warning, Message = "Could not publish outbox event {Id}: {Error}")]
    private partial void LogFailed(Guid id, string error);
}
