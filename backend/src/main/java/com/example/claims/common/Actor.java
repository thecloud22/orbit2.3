package com.example.claims.common;

/** Who made a change, recorded on history events. Authentication is not built; see README. */
public record Actor(String kind, String name) {
    public static Actor user(String name) { return new Actor("user", name); }
    public static Actor system(String name) { return new Actor("system", name); }
    public static Actor workflow(String workflowId) { return new Actor("workflow", workflowId); }
    public static Actor batch(String name) { return new Actor("batch", name); }
}
