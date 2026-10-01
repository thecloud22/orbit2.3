package com.example.claims.domain;

import java.util.Locale;

/** requested -> received -> accepted; not_enough goes back to being chased; waived needs a reason; expired. */
public enum RequirementState {
    REQUESTED, RECEIVED, ACCEPTED, NOT_ENOUGH, WAIVED, EXPIRED;

    public String db() { return name().toLowerCase(Locale.ROOT); }
    public static RequirementState of(String db) { return valueOf(db.toUpperCase(Locale.ROOT)); }
    /** Met = accepted or waived; proof of loss is complete when every requirement is met. */
    public boolean met() { return this == ACCEPTED || this == WAIVED; }
    /** Still worth chasing: nothing has arrived, or what arrived was not enough. */
    public boolean chasing() { return this == REQUESTED || this == NOT_ENOUGH; }
    @Override public String toString() { return db(); }
}
