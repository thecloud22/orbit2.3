package com.example.claims.domain;

/** One step of a workflow run as the Workflow & SLA section shows it. state: done | retried | skipped. */
public record RunStep(String label, String detail, String system, String state) {
    public static RunStep done(String label, String detail, String system) { return new RunStep(label, detail, system, "done"); }
    public static RunStep skipped(String label, String detail, String system) { return new RunStep(label, detail, system, "skipped"); }
    public static RunStep retried(String label, String detail, String system) { return new RunStep(label, detail, system, "retried"); }
}
