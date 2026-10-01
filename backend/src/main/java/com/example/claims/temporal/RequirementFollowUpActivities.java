package com.example.claims.temporal;

import com.example.claims.domain.RunStep;
import io.temporal.activity.ActivityInterface;
import java.util.List;
import java.util.UUID;

/** Activity type names are prefixed (RequirementFollowUp_...) because several interfaces share one worker and method names such as begin and recordFailure repeat. */
@ActivityInterface(namePrefix = "RequirementFollowUp_")
public interface RequirementFollowUpActivities {

    /** Does this deadline still apply? Also opens the run record. */
    record Check(boolean applies, String reason, String requirementName, String recipient, String channel) {}

    /** outcome: reminded | skipped | already_closed */
    record Result(String outcome, UUID nextDeadlineId, String note) {}

    Check begin(UUID deadlineId);

    /** Sends the reminder, once per deadline (dedupe key), however often this is retried. */
    void sendReminder(UUID deadlineId);

    /** One transaction: this deadline done, the next row written, the reminder in the history, the run saved. */
    Result completeFollowUp(UUID deadlineId, List<RunStep> steps);

    /** The deadline no longer applies: mark it skipped and record why. */
    Result skip(UUID deadlineId, String reason, List<RunStep> steps);

    /** Retries are exhausted: mark the run failed, leave the deadline dispatched, open an ops task. */
    void recordFailure(UUID deadlineId, String error, List<RunStep> steps);
}
