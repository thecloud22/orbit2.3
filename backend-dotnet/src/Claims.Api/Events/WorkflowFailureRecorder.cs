using Claims.Clock;
using Claims.Common;
using Claims.Domain;
using Claims.Store;

namespace Claims.Events;

/// <summary>
/// What every short event workflow does when its retries run out, in one place: ONE transaction that opens (or, for a re-run that failed again, re-opens) an ops
/// work item, writes the history, and finishes the run record as `failed` with the steps so far and a "what Temporal did" note. The claim's own state is untouched: it
/// was saved before the workflow started, and only the outside-system work waited. The run stays visible until an operator starts it again
/// (<c>POST /workflow-runs/{id}:rerun</c>, under the same workflow id).
/// </summary>
public sealed class WorkflowFailureRecorder(Db db, IClock clock, BusinessCalendar calendar, WorkflowRunRepository runs, HistoryRepository history, WorkItemRepository workItems)
{
    public Task RecordAsync(Guid claimId, string workflowId, string runRecordId, string what, string error, IReadOnlyList<RunStep> steps, string? nextTry = null) =>
        db.InTransactionAsync(async () =>
        {
            var now = clock.UtcNow;
            var failed = steps.LastOrDefault(s => s.State == "failed");
            var attempts = failed?.Attempts ?? 5;
            await workItems.InsertOrReopenAsync("workflow-failed:" + workflowId, null, claimId, 1, $"Re-run {workflowId} once the cause is fixed",
                $"{what}: the workflow gave up after {attempts} attempts ({error}). The claim's state is saved; only the outside-system step is waiting. Re-run it: POST /workflow-runs/…:rerun.",
                calendar.LocalDate(now), "You", "workflow", "workflow", null);
            await history.AppendAsync(claimId, now, "task", $"{what}: the workflow failed after {attempts} attempts; ops task opened", Actor.Workflow(workflowId), error, null, workflowId);
            var note = $"Temporal ran the step {attempts} times, waiting 2, 4, 8 and 16 s between the attempts, then stopped as the retry policy says. The run is marked failed " +
                       $"and its last step opened an ops task. What the claim needed was saved in Postgres before this workflow started: nothing is lost, only \"{what}\" is waiting." +
                       (nextTry is null ? "" : " " + nextTry);
            await runs.FinishAsync(workflowId, runRecordId, "failed", steps, ["Failure recorded on the run", "Ops task: re-run once the cause is fixed"], error, now, note);
        });
}
