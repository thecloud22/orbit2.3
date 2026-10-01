package com.example.claims.domain;

import java.util.Locale;

public enum DeadlineKind {
    ACKNOWLEDGE_BY, FORMS_BY, FIRST_CONTACT_BY, STATUS_LETTER, REQUIREMENT_FOLLOW_UP, DECISION_DUE, REVIEW_TARGET, PAYMENT_DUE;

    public String db() { return name().toLowerCase(Locale.ROOT); }
    public static DeadlineKind of(String db) { return valueOf(db.toUpperCase(Locale.ROOT)); }
    @Override public String toString() { return db(); }
}
