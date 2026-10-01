package com.example.claims.workflow;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import com.example.claims.domain.RunStep;
import com.example.claims.temporal.RequirementFollowUpActivities;
import com.example.claims.temporal.RequirementFollowUpActivities.Check;
import com.example.claims.temporal.RequirementFollowUpActivities.Result;
import com.example.claims.temporal.RequirementFollowUpWorkflow;
import com.example.claims.temporal.RequirementFollowUpWorkflowImpl;
import io.temporal.client.WorkflowException;
import java.util.ArrayList;
import java.util.Collections;
import java.util.List;
import java.util.UUID;
import java.util.concurrent.atomic.AtomicInteger;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;

class RequirementFollowUpWorkflowTest extends WorkflowTestBase {

    static class Fake implements RequirementFollowUpActivities {
        final List<String> calls = Collections.synchronizedList(new ArrayList<>());
        volatile Check check = new Check(true, null, "Claimant statement and W-9 · Mark", "Mark Castellano", "email");
        final AtomicInteger reminderFailuresLeft = new AtomicInteger();
        volatile boolean remindersAlwaysFail;
        volatile List<RunStep> completedSteps;
        volatile String skippedFor;
        volatile String failedWith;

        public Check begin(UUID deadlineId) { calls.add("begin"); return check; }

        public void sendReminder(UUID deadlineId) {
            calls.add("sendReminder");
            if (remindersAlwaysFail || reminderFailuresLeft.getAndDecrement() > 0) throw new IllegalStateException("email provider timed out");
        }

        public Result completeFollowUp(UUID deadlineId, List<RunStep> steps) {
            calls.add("completeFollowUp");
            completedSteps = steps;
            return new Result("reminded", UUID.randomUUID(), "Next follow-up due 2026-10-15");
        }

        public Result skip(UUID deadlineId, String reason, List<RunStep> steps) {
            calls.add("skip");
            skippedFor = reason;
            completedSteps = steps;
            return new Result("skipped", null, reason);
        }

        public void recordFailure(UUID deadlineId, String error, List<RunStep> steps) {
            calls.add("recordFailure");
            failedWith = error;
        }
    }

    Fake acts;

    @BeforeEach
    void register() {
        acts = new Fake();
        worker.registerWorkflowImplementationTypes(RequirementFollowUpWorkflowImpl.class);
        worker.registerActivitiesImplementations(acts);
        env.start();
    }

    private Result run(UUID deadline) {
        return stub(RequirementFollowUpWorkflow.class, "deadline-" + deadline).run(deadline);
    }

    @Test
    void stillMissingSoRemindsAndWritesTheNextRow() {
        Result r = run(id());

        assertThat(r.outcome()).isEqualTo("reminded");
        assertThat(r.nextDeadlineId()).isNotNull();
        assertThat(acts.calls).containsExactly("begin", "sendReminder", "completeFollowUp");
        assertThat(acts.completedSteps).extracting("label").containsExactly("Re-check: is it still missing?", "Send a reminder");
        assertThat(acts.completedSteps.get(1).detail()).isEqualTo("Mark Castellano by email");
    }

    @Test
    void stopsWithoutRemindingWhenTheRequirementIsAlreadyMet() {
        acts.check = new Check(false, "Requirement is already accepted", "Claimant statement and W-9 · Mark", "Mark Castellano", "email");

        Result r = run(id());

        assertThat(r.outcome()).isEqualTo("skipped");
        assertThat(acts.calls).containsExactly("begin", "skip");           // no reminder, no next row
        assertThat(acts.skippedFor).isEqualTo("Requirement is already accepted");
    }

    @Test
    void aFailedReminderIsRetriedBeforeAnythingIsSaved() {
        acts.reminderFailuresLeft.set(2);

        Result r = run(id());

        assertThat(r.outcome()).isEqualTo("reminded");
        assertThat(acts.calls.stream().filter("sendReminder"::equals)).hasSize(3);
        assertThat(acts.calls.stream().filter("completeFollowUp"::equals)).hasSize(1);   // saved once, after the retries
    }

    @Test
    void whenRetriesRunOutTheRunIsRecordedAsFailedAndNoNextRowIsWritten() {
        acts.remindersAlwaysFail = true;

        assertThatThrownBy(() -> run(id())).isInstanceOf(WorkflowException.class);

        assertThat(acts.calls).endsWith("recordFailure");
        assertThat(acts.calls).doesNotContain("completeFollowUp");
        assertThat(acts.failedWith).contains("email provider timed out");
    }
}
