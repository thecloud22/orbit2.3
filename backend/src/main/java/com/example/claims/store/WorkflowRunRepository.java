package com.example.claims.store;

import static com.example.claims.common.Db.arrayLiteral;
import static com.example.claims.common.Db.ts;

import com.example.claims.domain.RunStep;
import com.fasterxml.jackson.core.JsonProcessingException;
import com.fasterxml.jackson.databind.ObjectMapper;
import java.time.Instant;
import java.util.List;
import java.util.UUID;
import org.springframework.jdbc.core.simple.JdbcClient;
import org.springframework.stereotype.Repository;

/** The record of what each workflow run did. begin() and finish() are safe to repeat (activity retries). */
@Repository
public class WorkflowRunRepository {
    private final JdbcClient jdbc;
    private final ObjectMapper json;

    public WorkflowRunRepository(JdbcClient jdbc, ObjectMapper json) {
        this.jdbc = jdbc;
        this.json = json;
    }

    public void begin(String workflowId, String runId, String type, String name, UUID claimId, String startedBy,
                      String triggerKind, UUID triggerId, Instant now) {
        jdbc.sql("""
                INSERT INTO workflow_runs (workflow_id, run_id, type, name, claim_id, started_by, trigger_kind, trigger_id, started_at)
                VALUES (:wf, :run, :type, :name, :claim, :by, :tk, :tid, :now)
                ON CONFLICT (workflow_id, run_id) DO NOTHING""")
                .param("wf", workflowId).param("run", runId).param("type", type).param("name", name).param("claim", claimId)
                .param("by", startedBy).param("tk", triggerKind).param("tid", triggerId).param("now", ts(now)).update();
    }

    public void finish(String workflowId, String runId, String status, List<RunStep> steps, List<String> saved, String error, Instant now) {
        String stepsJson;
        try {
            stepsJson = json.writeValueAsString(steps);
        } catch (JsonProcessingException e) {
            throw new IllegalStateException(e);
        }
        jdbc.sql("""
                UPDATE workflow_runs SET status = :status, finished_at = :now, steps = cast(:steps as jsonb),
                       saved = cast(:saved as text[]), error = :error
                WHERE workflow_id = :wf AND run_id = :run AND status = 'running'""")
                .param("status", status).param("now", ts(now)).param("steps", stepsJson).param("saved", arrayLiteral(saved))
                .param("error", error).param("wf", workflowId).param("run", runId).update();
    }
}
