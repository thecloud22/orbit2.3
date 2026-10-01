package com.example.claims.temporal;

import com.example.claims.deadline.DeadlineDispatcher;
import org.springframework.stereotype.Component;

@Component
public class DispatcherActivitiesImpl implements DispatcherActivities {
    private final DeadlineDispatcher dispatcher;

    public DispatcherActivitiesImpl(DeadlineDispatcher dispatcher) {
        this.dispatcher = dispatcher;
    }

    @Override
    public Summary dispatchDue() {
        DeadlineDispatcher.Result r = dispatcher.dispatchDue();
        return new Summary(r.claimed(), r.started(), r.alreadyStarted(), r.failed(), r.batchWasFull());
    }
}
