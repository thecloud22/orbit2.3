package com.example.claims.domain;

import java.util.Locale;

public enum DeadlineState {
    OPEN, DISPATCHED, DONE, SKIPPED;

    public String db() { return name().toLowerCase(Locale.ROOT); }
    public static DeadlineState of(String db) { return valueOf(db.toUpperCase(Locale.ROOT)); }
    public boolean live() { return this == OPEN || this == DISPATCHED; }
    @Override public String toString() { return db(); }
}
