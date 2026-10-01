using Claims.Clock;
using Claims.Common;
using Claims.Config;
using Claims.Store;
using Claims.Temporal;

namespace Claims.Deadline;

/// <summary>
/// Fires deadlines that have come due. Every minute a Temporal Schedule runs the dispatcher workflow, which calls DispatchDueAsync()
/// until a batch comes back short. (Or, in dev, an in-process timer calls it: same code path.)
///
/// One poll is ONE transaction:
///   1. SELECT due rows FOR UPDATE SKIP LOCKED. Concurrent dispatchers skip each other's rows, so no row is fired twice.
///   2. For each row, start workflow deadline-&lt;id&gt;. The id makes a repeat start a no-op, so a crash after a start
///      but before the commit only costs a harmless AlreadyStarted next time.
///   3. Mark the row dispatched (attempt+1, workflow id, outcome) and append a deadline_attempts line.
///      If the start itself fails, the row stays open with a backoff (retry_after) and the error is recorded.
///
/// The workflow's own writes to the row wait for this transaction's row lock, then see the committed state.
/// Trade-off: locks are held while the (fast, batch-limited) starts are made; the alternative, commit-then-start,
/// can strand a row as dispatched with no workflow.
/// </summary>
public sealed partial class DeadlineDispatcher(DeadlineRepository deadlines, IWorkflowLauncher launcher, Db db, ClaimsOptions options,
                                               IClock clock, ILogger<DeadlineDispatcher> log)
{
    public sealed record Result(int Claimed, int Started, int AlreadyStarted, int Failed, bool BatchWasFull);

    public Task<Result> DispatchDueAsync() => db.InTransactionAsync(PollAsync);

    private async Task<Result> PollAsync()
    {
        var now = clock.UtcNow;
        var limit = options.Dispatcher.BatchSize;
        var due = await deadlines.LockDueAsync(now, launcher.SupportedDeadlineKinds, limit);
        int started = 0, already = 0, failed = 0;
        foreach (var row in due)
        {
            var attempt = row.Attempt + 1;
            Started result;
            try
            {
                result = await launcher.StartDeadlineWorkflowAsync(row.Kind, row.Id);
            }
            catch (Exception e) when (e is not OperationCanceledException)
            {
                failed++;
                var retry = now + Backoff(attempt);
                LogStartFailed(row.Id, attempt, e.ToString());
                await deadlines.MarkStartFailedAsync(row.Id, e.ToString(), retry);
                await deadlines.AddAttemptAsync(row.Id, attempt, "start_failed", null, e.ToString());
                continue;
            }
            var outcome = result.Outcome == StartOutcome.Started ? "started" : "already_started";
            if (result.Outcome == StartOutcome.Started) started++; else already++;
            await deadlines.MarkDispatchedAsync(row.Id, result.WorkflowId, outcome, now);
            await deadlines.AddAttemptAsync(row.Id, attempt, outcome, result.WorkflowId, null);
        }
        return new Result(due.Count, started, already, failed, due.Count >= limit);
    }

    private TimeSpan Backoff(int attempt)
    {
        var d = options.Dispatcher.RetryBase * attempt;
        return d > options.Dispatcher.RetryMax ? options.Dispatcher.RetryMax : d;
    }

    [LoggerMessage(Level = LogLevel.Warning, Message = "Could not start workflow for deadline {Id} (attempt {Attempt}): {Error}")]
    private partial void LogStartFailed(Guid id, int attempt, string error);
}
