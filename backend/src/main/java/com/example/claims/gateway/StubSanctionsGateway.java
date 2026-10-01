package com.example.claims.gateway;

import java.util.List;
import java.util.UUID;
import org.springframework.stereotype.Component;

/** STUB. Clear for everyone except a name containing "OFAC-HIT", which makes demos of the hold path possible. */
@Component
public class StubSanctionsGateway implements SanctionsGateway {
    @Override
    public Screening screen(List<String> names) {
        boolean hit = names.stream().anyMatch(n -> n.toUpperCase().contains("OFAC-HIT"));
        return new Screening(!hit, "stub-" + UUID.randomUUID());
    }
}
