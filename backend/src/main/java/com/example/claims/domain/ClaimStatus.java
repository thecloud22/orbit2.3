package com.example.claims.domain;

import java.util.Locale;

/** The claim state machine. `received` = notice saved, intake run has not finished set-up. */
public enum ClaimStatus {
    RECEIVED, GATHERING_EVIDENCE, IN_REVIEW, AWAITING_APPROVAL, APPROVED, CLOSED;

    public String db() { return name().toLowerCase(Locale.ROOT); }
    public static ClaimStatus of(String db) { return valueOf(db.toUpperCase(Locale.ROOT)); }
    /** No more evidence chasing once the claim is decided. */
    public boolean decidedOrClosed() { return this == APPROVED || this == CLOSED; }
    @Override public String toString() { return db(); }
}
