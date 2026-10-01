package com.example.claims.temporal;

import com.example.claims.domain.RunStep;
import com.example.claims.gateway.PolicyAdminGateway;
import com.example.claims.gateway.SanctionsGateway;
import com.example.claims.intake.IntakeSetupService;
import io.temporal.activity.Activity;
import io.temporal.activity.ActivityExecutionContext;
import java.time.LocalDate;
import java.util.ArrayList;
import java.util.List;
import java.util.UUID;
import org.springframework.stereotype.Component;

@Component
public class LifeIntakeActivitiesImpl implements LifeIntakeActivities {
    private final IntakeSetupService setup;
    private final PolicyAdminGateway policyAdmin;
    private final SanctionsGateway sanctions;

    public LifeIntakeActivitiesImpl(IntakeSetupService setup, PolicyAdminGateway policyAdmin, SanctionsGateway sanctions) {
        this.setup = setup;
        this.policyAdmin = policyAdmin;
        this.sanctions = sanctions;
    }

    private static ActivityExecutionContext ctx() {
        return Activity.getExecutionContext();
    }

    private static String workflowId() { return ctx().getInfo().getWorkflowId(); }

    private static String runId() { return ctx().getInfo().getRunId(); }

    @Override
    public Facts begin(Input input) {
        setup.beginRun(input.claimId(), input.eventId(), workflowId(), runId());
        return setup.loadFacts(input.claimId());
    }

    @Override
    public List<PolicyFinding> checkPolicies(UUID claimId) {
        Facts f = setup.loadFacts(claimId);
        LocalDate dod = LocalDate.parse(f.dateOfDeath());
        List<PolicyFinding> out = new ArrayList<>();
        for (String number : f.policyNumbers()) {
            PolicyAdminGateway.PolicyStatus s = policyAdmin.statusOn(number, dod);
            out.add(new PolicyFinding(number, s.inForceOnDateOfDeath(), s.note()));
        }
        return out;
    }

    @Override
    public ScreenOutcome screenParties(UUID claimId) {
        Facts f = setup.loadFacts(claimId);
        List<String> names = new ArrayList<>(f.payees().stream().map(Payee::name).toList());
        names.add(f.callerName());
        SanctionsGateway.Screening s = sanctions.screen(names);
        return new ScreenOutcome(s.clear(), ctx().getInfo().getAttempt(), s.reference());
    }

    @Override
    public List<String> findDuplicateClaims(UUID claimId) {
        return setup.duplicateClaims(claimId);
    }

    @Override
    public RouteDecision route(UUID claimId) {
        return setup.route(claimId);
    }

    @Override
    public int sendAcknowledgementAndPackets(UUID claimId) {
        return setup.sendAcknowledgementAndPackets(claimId, workflowId());
    }

    @Override
    public boolean tellAgent(UUID claimId) {
        return setup.tellAgent(claimId, workflowId());
    }

    @Override
    public void completeSetup(UUID claimId, RouteDecision route, List<RunStep> steps) {
        setup.completeSetup(claimId, route, steps, workflowId(), runId());
    }

    @Override
    public void holdForReview(UUID claimId, List<String> reasons, List<RunStep> steps) {
        setup.holdForReview(claimId, reasons, steps, workflowId(), runId());
    }

    @Override
    public void recordFailure(UUID claimId, String error, List<RunStep> steps) {
        setup.recordFailure(claimId, error, steps, workflowId(), runId());
    }
}
