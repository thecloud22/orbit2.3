package com.example.claims.gateway;

import java.time.LocalDate;

/** Policy administration is the system of record for the policy. The intake workflow re-checks it. */
public interface PolicyAdminGateway {

    record PolicyStatus(String policyNumber, boolean inForceOnDateOfDeath, LocalDate paidTo, String note) {}

    PolicyStatus statusOn(String policyNumber, LocalDate dateOfDeath);
}
