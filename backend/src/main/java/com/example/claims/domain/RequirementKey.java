package com.example.claims.domain;

import java.util.Locale;

public enum RequirementKey {
    CERTIFICATE, STATEMENT, PRIMARY_DIED_FIRST, REPORT, AMENDED_CERTIFICATE;

    public String db() { return name().toLowerCase(Locale.ROOT); }
    public static RequirementKey of(String db) { return valueOf(db.toUpperCase(Locale.ROOT)); }
    @Override public String toString() { return db(); }
}
