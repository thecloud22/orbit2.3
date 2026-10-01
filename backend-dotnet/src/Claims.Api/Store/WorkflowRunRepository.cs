using Claims.Common;
using Claims.Domain;

namespace Claims.Store;

/// <summary>The record of what each workflow run did. Begin and Finish are safe to repeat (activity retries).</summary>
public sealed class WorkflowRunRepository(Db db)
{
    public sealed record Row(Guid Id, string WorkflowId, string RunId, string Status, int RunNo, Guid? ClaimId, string Type, string? TriggerKind, Guid? TriggerId, Guid? RerunOfId);

    /// <summary>
    /// Opens the record of this run. A workflow id that already has an earlier run (a run that FAILED and was started again under the same id) gets the next
    /// <c>run_no</c> and points at the run it re-runs, so "run 2" is linked to "run 1". A repeat of Begin for the same Temporal run id does nothing.
    /// </summary>
    public Task<int> BeginAsync(string workflowId, string runId, string type, string name, Guid claimId, string startedBy,
                                string triggerKind, Guid triggerId, DateTimeOffset now) => db.ExecuteAsync("""
        INSERT INTO workflow_runs (workflow_id, run_id, type, name, claim_id, started_by, trigger_kind, trigger_id, started_at, run_no, rerun_of_id)
        SELECT @wf, @run, @type, @name, @claim, @by, @tk, @tid, @now,
               COALESCE((SELECT max(p.run_no) FROM workflow_runs p WHERE p.workflow_id = @wf AND p.run_id <> @run), 0) + 1,
               (SELECT p.id FROM workflow_runs p WHERE p.workflow_id = @wf AND p.run_id <> @run ORDER BY p.run_no DESC, p.started_at DESC LIMIT 1)
        ON CONFLICT (workflow_id, run_id) DO NOTHING
        """, new { wf = workflowId, run = runId, type, name, claim = claimId, by = startedBy, tk = triggerKind, tid = triggerId, now = now.ToUniversalTime() });

    /// <summary>The run number Begin gave this run (1 for the first run of a workflow id).</summary>
    public Task<Row?> FindAsync(string workflowId, string runId) => db.QueryOptionalAsync(
        "SELECT id, workflow_id, run_id, status, run_no, claim_id, type, trigger_kind, trigger_id, rerun_of_id FROM workflow_runs WHERE workflow_id = @wf AND run_id = @run",
        new { wf = workflowId, run = runId }, Map);

    public Task<Row?> FindAsync(Guid id) => db.QueryOptionalAsync(
        "SELECT id, workflow_id, run_id, status, run_no, claim_id, type, trigger_kind, trigger_id, rerun_of_id FROM workflow_runs WHERE id = @id", new { id }, Map);

    /// <summary>The latest run (highest run number) of a workflow id.</summary>
    public Task<Row?> LatestAsync(string workflowId) => db.QueryOptionalAsync(
        "SELECT id, workflow_id, run_id, status, run_no, claim_id, type, trigger_kind, trigger_id, rerun_of_id FROM workflow_runs WHERE workflow_id = @wf ORDER BY run_no DESC, started_at DESC LIMIT 1",
        new { wf = workflowId }, Map);

    private static readonly Func<DbRow, Row> Map = r => new Row(r.Guid("id"), r.Text("workflow_id"), r.Text("run_id"), r.Text("status"), r.Int("run_no"), r.GuidOrNull("claim_id"),
        r.Text("type"), r.Str("trigger_kind"), r.GuidOrNull("trigger_id"), r.GuidOrNull("rerun_of_id"));

    /// <summary>Ends the run. <paramref name="note"/> ("what Temporal did") is added to any note the run already has; the time the run took is stamped from real time.</summary>
    public Task<int> FinishAsync(string workflowId, string runId, string status, IReadOnlyList<RunStep> steps, IReadOnlyList<string> saved,
                                 string? error, DateTimeOffset now, string? note = null) => db.ExecuteAsync("""
        UPDATE workflow_runs SET status = @status, finished_at = @now, steps = cast(@steps as jsonb),
               saved = cast(@saved as text[]), error = @error,
               note = CASE WHEN cast(@note as text) IS NULL THEN note WHEN note IS NULL THEN cast(@note as text) ELSE note || E'\n' || cast(@note as text) END,
               elapsed_ms = greatest(0, round(extract(epoch FROM (clock_timestamp() - opened_real_at)) * 1000))::int
        WHERE workflow_id = @wf AND run_id = @run AND status = 'running'
        """, new
    {
        status,
        now = now.ToUniversalTime(),
        steps = Json.Serialize(steps),
        saved = Db.ArrayLiteral(saved),
        error,
        note,
        wf = workflowId,
        run = runId,
    });

    /// <summary>Adds a line to the run's note while it runs (a fault that fired, a retry Temporal made). Ignored when the run has no record yet.</summary>
    public Task<int> AppendNoteAsync(string workflowId, string runId, string note) => db.ExecuteAsync("""
        UPDATE workflow_runs SET note = CASE WHEN note IS NULL THEN @note ELSE note || E'\n' || @note END
        WHERE workflow_id = @wf AND run_id = @run
        """, new { note, wf = workflowId, run = runId });
}
