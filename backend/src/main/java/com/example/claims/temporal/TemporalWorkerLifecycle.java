package com.example.claims.temporal;

import io.temporal.worker.WorkerFactory;
import org.springframework.context.SmartLifecycle;

/** Starts the worker with the application and shuts it down first, letting running activities finish. */
public class TemporalWorkerLifecycle implements SmartLifecycle {
    private final WorkerFactory factory;
    private volatile boolean running;

    public TemporalWorkerLifecycle(WorkerFactory factory) {
        this.factory = factory;
    }

    @Override
    public void start() {
        factory.start();
        running = true;
    }

    @Override
    public void stop() {
        factory.shutdown();
        running = false;
    }

    @Override
    public boolean isRunning() {
        return running;
    }
}
