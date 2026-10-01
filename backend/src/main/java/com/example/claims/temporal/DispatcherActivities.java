package com.example.claims.temporal;

import io.temporal.activity.ActivityInterface;

/** Activity type names are prefixed (Dispatcher_...) because several interfaces share one worker and method names such as begin and recordFailure repeat. */
@ActivityInterface(namePrefix = "Dispatcher_")
public interface DispatcherActivities {

    record Summary(int claimed, int started, int alreadyStarted, int failed, boolean more) {}

    /** One poll of the deadlines table. */
    Summary dispatchDue();
}
