package com.example.claims.support;

import com.example.claims.intake.LifeIntakeRequest;
import com.example.claims.intake.LifeIntakeRequest.*;
import com.example.claims.view.Views.Money;
import java.math.BigDecimal;
import java.time.Instant;
import java.time.LocalDate;
import java.util.List;
import java.util.Set;

/** The mock's story: Robert Castellano, 71, died Sat 19 Sep 2026; Diane calls Fri 25 Sep 10:03 (Central). */
public final class TestData {
    private TestData() {}

    public static final Instant NOTICE_AT = Instant.parse("2026-09-25T15:03:00Z");

    public static LifeIntakeRequest castellano(String manner) {
        return castellano(manner, "WL-0804419", "Robert Castellano", true);
    }

    public static LifeIntakeRequest castellano(String manner, String policyNumber, String insuredName, boolean agentConsent) {
        return new LifeIntakeRequest(
                NOTICE_AT,
                new Caller("Diane Castellano", "Child", "612-555-0117", "diane@example.com", Set.of("email", "text"), true, true, agentConsent, "diane"),
                new Insured(insuredName, LocalDate.of(1955, 3, 2), "4419"),
                new Death(LocalDate.of(2026, 9, 19), "At home, Two Harbors, MN", manner, false, "Lakeshore Funeral Chapel, Two Harbors"),
                List.of(new PolicyClaimed(policyNumber, "WL", "Whole life", LocalDate.of(2008, 5, 1), LocalDate.of(2026, 9, 1), true, null,
                        new Money("200000.00", "USD"), List.of(new Rider("adb", "Accidental death rider", new Money("200000.00", "USD"))))),
                new Designation(LocalDate.of(2015, 3, 3), "Designation on file", List.of(
                        new Beneficiary("linda", "Linda Castellano", "Spouse", "primary", new BigDecimal("100"), null,
                                LocalDate.of(2021, 6, 12), "Death certificate on file from her own claim", null),
                        new Beneficiary("diane", "Diane Castellano", "Child", "contingent", new BigDecimal("50"), LocalDate.of(1984, 7, 9), null, null,
                                new Contact("612-555-0117", "diane@example.com", "1 Lake Rd, Two Harbors, MN", "portal")),
                        new Beneficiary("mark", "Mark Castellano", "Child", "contingent", new BigDecimal("50"), LocalDate.of(1987, 1, 21), null, null,
                                new Contact("612-555-0142", "mark@example.com", "9 Pine St, Duluth, MN", "portal")))),
                new Agent("Tom Bright", "Northwoods Agency"),
                false);
    }
}
