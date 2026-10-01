package com.example.claims.gateway;

import java.time.LocalDate;
import org.springframework.jdbc.core.simple.JdbcClient;
import org.springframework.stereotype.Component;

/**
 * STUB. Answers from the policy snapshot saved at intake instead of calling policy administration.
 * The rule is the mock's: in force on the date of death when premium is paid to within a 31-day grace period.
 * Replace with a real client (with its own timeouts and Temporal retry policy).
 */
@Component
public class SnapshotPolicyAdminGateway implements PolicyAdminGateway {
    private static final int GRACE_DAYS = 31;
    private final JdbcClient jdbc;

    public SnapshotPolicyAdminGateway(JdbcClient jdbc) {
        this.jdbc = jdbc;
    }

    @Override
    public PolicyStatus statusOn(String policyNumber, LocalDate dod) {
        record Snap(LocalDate paidTo, boolean inForce) {}
        Snap s = jdbc.sql("SELECT paid_to_date, in_force FROM policies WHERE policy_number = :n").param("n", policyNumber)
                .query((rs, i) -> new Snap(rs.getObject("paid_to_date", LocalDate.class), rs.getBoolean("in_force"))).single();
        boolean inForce = s.inForce() && !dod.isAfter(s.paidTo().plusDays(GRACE_DAYS));
        return new PolicyStatus(policyNumber, inForce, s.paidTo(),
                inForce ? "premium paid to " + s.paidTo() : s.inForce() ? "premium paid only to " + s.paidTo() + ", past the grace period" : "policy lapsed");
    }
}
