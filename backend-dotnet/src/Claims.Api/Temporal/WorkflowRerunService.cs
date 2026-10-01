using Claims.Clock;
using Claims.Common;
using Claims.Domain;
using Claims.Store;
using Claims.View;

namespace Claims.Temporal;

/// <summary>
/// The ops re-run of a FAILED workflow run (<c>POST /workflow-runs/{id}:rerun</c>). It starts the same workflow again under the SAME workflow id, through the launcher's normal entry
/// points: the id-reuse policy <c>ALLOW_DUPLICATE_FAILED_ONLY</c> lets a new run start because the last one failed, and would refuse it if that run had completed or were still
/// running (which is also what makes a duplicate outbox start a no-op). Nothing is copied from the failed run: the new run reads its facts from Postgres like the first did, and
/// everything it sends carries the same idempotency key, so a re-run can never send a letter twice. The run record links back to the failed one (<c>run_no</c>, <c>rerun_of_id</c>).
/// </summary>
public sealed class WorkflowRerunService(Db db, IClock clock, WorkflowRunRepository runs, IWorkflowLauncher launcher, OutboxRepository outbox, DeadlineRepository deadlines,
                                         HistoryRepository history)
{
    public async Task<RerunView> RerunAsync(Guid runRecordId, string actorName)
    {
        var run = await runs.FindAsync(runRecordId) ?? throw ApiException.NotFound("Workflow run", runRecordId);
        if (run.Status != "failed") throw ApiException.Conflict("run_not_failed", $"Only a failed run can be re-run; this one is {run.Status}");
        var latest = await runs.LatestAsync(run.WorkflowId);
        if (latest is not null && latest.Id != run.Id)
            throw ApiException.Conflict("run_not_latest", $"Run {latest.RunNo} of {run.WorkflowId} is newer than this one; re-run only the latest run");

        Started started;
        switch (run.Type)
        {
            case "event":
            {
                var e = (run.TriggerId is { } tid ? await outbox.FindAsync(tid) : null) ?? throw ApiException.Conflict("run_not_restartable", "The outbox event that started this run is gone");
                started = await launcher.StartEventAsync(new EventStart(e.Type, e.Id, e.ClaimId ?? run.ClaimId ?? Guid.Empty, e.Payload));
                break;
            }
            case "orchestration":
            {
                var claimId = run.ClaimId ?? throw ApiException.Conflict("run_not_restartable", "The run has no claim");
                var number = await db.SingleAsync<string>("SELECT claim_number FROM claims WHERE id = @c", new { c = claimId });
                started = await launcher.StartIntakeAsync(number, claimId, run.TriggerId ?? Guid.Empty);
                break;
            }
            case "deadline":
            {
                var d = (run.TriggerId is { } did ? await deadlines.FindAsync(did) : null) ?? throw ApiException.Conflict("run_not_restartable", "The deadline row that started this run is gone");
                started = await launcher.StartDeadlineWorkflowAsync(d.Kind, d.Id);
                break;
            }
            default:
                throw ApiException.Conflict("run_not_restartable", "This kind of run cannot be re-run");
        }
        if (run.ClaimId is { } claim)
            await history.AppendAsync(claim, clock.UtcNow, "task", "Ops re-run requested: " + run.WorkflowId, Actor.User(actorName),
                $"Run {run.RunNo} failed; run {run.RunNo + 1} starts under the same workflow id ({(started.Outcome == StartOutcome.Started ? "started" : "already running")})", run.WorkflowId, run.WorkflowId);
        return new RerunView(started.WorkflowId, started.Outcome == StartOutcome.Started ? "started" : "already_started", run.Id);
    }
}
