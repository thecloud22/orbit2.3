package com.example.claims.gateway;

import java.util.List;

public interface SanctionsGateway {

    record Screening(boolean clear, String reference) {}

    /** Screens payees before anything is sent. Throws on timeout; Temporal retries the activity. */
    Screening screen(List<String> names);
}
