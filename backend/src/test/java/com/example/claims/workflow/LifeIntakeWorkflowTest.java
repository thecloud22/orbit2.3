package com.example.claims.workflow;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import com.example.claims.temporal.LifeIntakeActivities;
import com.example.claims.temporal.LifeIntakeWorkflow;
import com.example.claims.temporal.LifeIntakeWorkflowImpl;
import io.temporal.client.WorkflowException;
import java.util.List;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;

class LifeIntakeWorkflowTest extends WorkflowTestBase {
    FakeLifeIntakeActivities acts;

    @BeforeEach
    void register() {
        acts = new FakeLifeIntakeActivities();
        worker.registerWorkflowImplementationTypes(LifeIntakeWorkflowImpl.class);
        worker.registerActivitiesImplementations(acts);
        env.start();
    }

    private LifeIntakeWorkflow.Result run() {
        return stub(LifeIntakeWorkflow.class, "orch-L-26-043310-intake")
                .run(new LifeIntakeActivities.Input(id(), id()));
    }

    @Test
    void cleanClaimIsCheckedRoutedLettersSentAndSetUpInOneFinalStep() {
        LifeIntakeWorkflow.Result r = run();

        assertThat(r.outcome()).isEqualTo("set_up");
        assertThat(acts.calls).containsExactly("begin", "checkPolicies", "screenParties", "findDuplicateClaims", "route",
                "sendAcknowledgementAndPackets", "tellAgent", "completeSetup");
        // The run record the final transaction saves lists every step, in order.
        assertThat(acts.completedSteps).extracting("label").containsExactly(
                "Confirm in force on the date of death", "Screen the beneficiaries", "Look for an existing claim", "Route the claim",
                "Send the acknowledgement and claim packets", "Tell the agent of record");
        assertThat(acts.completedSteps).extracting("state").containsOnly("done");
    }

    @Test
    void sanctionsTimeoutIsRetriedByTemporalAndShowsAsRetriedInTheRun() {
        acts.sanctionsFailuresLeft.set(1);
        long before = env.currentTimeMillis();

        LifeIntakeWorkflow.Result r = run();

        assertThat(r.outcome()).isEqualTo("set_up");
        assertThat(acts.calls.stream().filter("screenParties"::equals)).hasSize(2);
        assertThat(acts.completedSteps).filteredOn(s -> s.label().equals("Screen the beneficiaries"))
                .singleElement().satisfies(s -> {
                    assertThat(s.state()).isEqualTo("retried");
                    assertThat(s.detail()).contains("attempt 2");
                });
        // Time skipping: the 2 s back-off elapsed in workflow time, not in the test's.
        assertThat(env.currentTimeMillis() - before).isGreaterThanOrEqualTo(2_000);
    }

    @Test
    void anythingDoubtfulStopsTheChecksAndOpensATaskForAPerson() {
        acts.policyInForce = false;
        acts.duplicates = List.of("L-26-041111");

        LifeIntakeWorkflow.Result r = run();

        assertThat(r.outcome()).isEqualTo("needs_review");
        assertThat(acts.heldReasons).hasSize(2);
        assertThat(acts.heldReasons.get(0)).contains("WL-0804419");
        assertThat(acts.heldReasons.get(1)).contains("L-26-041111");
        // Nothing is sent and the claim is not set up.
        assertThat(acts.calls).doesNotContain("route", "sendAcknowledgementAndPackets", "tellAgent", "completeSetup");
        assertThat(acts.calls).contains("holdForReview");
    }

    @Test
    void sanctionsHitHoldsTheClaim() {
        acts.sanctionsClear = false;
        assertThat(run().outcome()).isEqualTo("needs_review");
        assertThat(acts.heldReasons).singleElement().asString().contains("Sanctions");
    }

    @Test
    void noAgentConsentSkipsTheAgentStepButStillSetsUp() {
        acts.consent = false;
        assertThat(run().outcome()).isEqualTo("set_up");
        assertThat(acts.completedSteps).filteredOn(s -> s.label().equals("Tell the agent of record")).singleElement()
                .extracting("state").isEqualTo("skipped");
    }

    @Test
    void aClaimThatIsAlreadySetUpIsLeftAlone() {
        acts.status = "gathering_evidence";
        assertThat(run().outcome()).isEqualTo("already_set_up");
        assertThat(acts.calls).containsExactly("begin");
    }

    @Test
    void whenRetriesAreExhaustedTheRunIsRecordedAsFailedAndTheWorkflowFails() {
        acts.lettersAlwaysFail = true;

        assertThatThrownBy(this::run).isInstanceOf(WorkflowException.class);

        assertThat(acts.calls.stream().filter("sendAcknowledgementAndPackets"::equals)).hasSize(5);   // maximum attempts
        assertThat(acts.calls).endsWith("recordFailure");
        assertThat(acts.calls).doesNotContain("completeSetup");
        assertThat(acts.failedWith).contains("notification provider is down");
        assertThat(acts.stepsAtFailure).extracting("label").contains("Route the claim");   // what it got through is kept
    }
}
