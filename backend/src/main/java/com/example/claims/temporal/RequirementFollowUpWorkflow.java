package com.example.claims.temporal;

import io.temporal.workflow.WorkflowInterface;
import io.temporal.workflow.WorkflowMethod;
import java.util.UUID;

/** Deadline workflow deadline-&lt;id&gt; for kind requirement_follow_up: re-check, remind, write the next row. */
@WorkflowInterface
public interface RequirementFollowUpWorkflow {

    @WorkflowMethod
    RequirementFollowUpActivities.Result run(UUID deadlineId);
}
