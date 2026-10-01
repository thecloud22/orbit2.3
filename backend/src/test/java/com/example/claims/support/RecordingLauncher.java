package com.example.claims.support;

import com.example.claims.domain.DeadlineKind;
import com.example.claims.temporal.WorkflowLauncher;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.UUID;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.CopyOnWriteArrayList;

/** Stands in for Temporal in dispatcher and API tests: records every start, and can be told to fail or repeat. */
public class RecordingLauncher implements WorkflowLauncher {
    public final List<UUID> startedDeadlines = new CopyOnWriteArrayList<>();
    public final List<String> startedIntakes = new CopyOnWriteArrayList<>();
    public final Set<UUID> failFor = ConcurrentHashMap.newKeySet();
    public final Set<UUID> alreadyStarted = ConcurrentHashMap.newKeySet();
    public final Map<UUID, Integer> attempts = new ConcurrentHashMap<>();
    public volatile long startDelayMillis = 0;

    public void reset() {
        startedDeadlines.clear();
        startedIntakes.clear();
        failFor.clear();
        alreadyStarted.clear();
        attempts.clear();
        startDelayMillis = 0;
    }

    @Override
    public Set<DeadlineKind> supportedDeadlineKinds() {
        return Set.of(DeadlineKind.REQUIREMENT_FOLLOW_UP);
    }

    @Override
    public Started startDeadlineWorkflow(DeadlineKind kind, UUID deadlineId) {
        attempts.merge(deadlineId, 1, Integer::sum);
        if (startDelayMillis > 0) {
            try {
                Thread.sleep(startDelayMillis);
            } catch (InterruptedException e) {
                Thread.currentThread().interrupt();
            }
        }
        if (failFor.contains(deadlineId)) throw new IllegalStateException("Temporal unavailable");
        String id = WorkflowLauncher.deadlineWorkflowId(deadlineId);
        if (alreadyStarted.contains(deadlineId)) return new Started(id, Outcome.ALREADY_STARTED);
        startedDeadlines.add(deadlineId);
        return new Started(id, Outcome.STARTED);
    }

    @Override
    public Started startIntake(String claimNumber, UUID claimId, UUID eventId) {
        startedIntakes.add(claimNumber);
        return new Started(WorkflowLauncher.intakeWorkflowId(claimNumber), Outcome.STARTED);
    }
}
