package com.example.claims.view;

import com.example.claims.domain.RunStep;
import java.math.BigDecimal;
import java.time.Instant;
import java.time.LocalDate;
import java.util.List;
import java.util.UUID;

/**
 * The JSON resources the API returns. Field names are camelCase; enum values are snake_case (the same
 * strings the database stores); money is {amount: "200000.00", currency: "USD"}; timestamps are UTC
 * instants (RFC 3339); business dates are plain dates.
 */
public final class Views {
    private Views() {}

    public record Money(
            @jakarta.validation.constraints.NotNull @jakarta.validation.constraints.Pattern(regexp = "^[0-9]{1,13}(\\.[0-9]{1,2})?$", message = "must be a decimal string with at most 2 decimals, e.g. \"200000.00\"") String amount,
            @jakarta.validation.constraints.NotNull @jakarta.validation.constraints.Pattern(regexp = "^[A-Z]{3}$", message = "must be a 3-letter ISO 4217 code") String currency) {
        public static Money of(BigDecimal amount, String currency) {
            return new Money(amount.setScale(2, java.math.RoundingMode.UNNECESSARY).toPlainString(), currency.trim());
        }
    }

    public record Page<T>(List<T> items, String nextCursor) {
        public static <T> Page<T> of(List<T> items) { return new Page<>(items, null); }
    }

    public record PartyRef(UUID id, String name) {}

    public record ClaimPartyView(UUID partyId, String name, String role, String relationship, String beneficiaryKind,
                                 String sharePercent, boolean payee, String packetChannel, String accessNote, LocalDate diedOn) {}

    public record LifeDetails(String kind, LocalDate dateOfDeath, String placeOfDeath, String mannerOfDeath, boolean deathOutsideUs,
                              String funeralHome, UUID callerPartyId, String callerRelationship, List<String> contactBy,
                              boolean agentConsent, boolean otherClaimantsPossible, String intakeChannel) {}

    public record BenefitLineView(UUID id, String policyNumber, String kind, UUID parentLineId, String riderKey, String name,
                                  Money amount, String status, String waitingOn, String productConfigVersion, long version) {}

    public record ClaimView(UUID id, String claimNumber, String family, String productCode, String status, String track,
                            String routeRule, List<String> routeReasons, UUID ownerId, String team, Instant noticedAt,
                            Instant proofCompleteAt, Instant closedAt, PartyRef insured, LifeDetails details,
                            List<BenefitLineView> benefitLines, List<ClaimPartyView> parties,
                            long version, Instant createdAt, Instant updatedAt) {}

    public record ClaimSummary(UUID id, String claimNumber, String family, String productCode, String status, String track,
                               UUID ownerId, String insuredName, Instant noticedAt, long version) {}

    public record RequirementSource(UUID partyId, String label, String detail) {}

    public record RequirementView(UUID id, UUID claimId, UUID benefitLineId, String key, String name, String purpose,
                                  RequirementSource from, String state, Instant requestedAt, int followUpDays, int followUpCount,
                                  Instant lastReminderAt, Instant receivedAt, Instant acceptedAt, String satisfiedBy,
                                  Instant waivedAt, String waiveReason, long version) {}

    public record DeadlineView(UUID id, UUID claimId, String kind, UUID requirementId, String what, String sla, Instant dueAt,
                               Instant originalDueAt, String extensionReason, String state, int attempt, Instant dispatchedAt,
                               boolean fired, String lastOutcome, String lastError, String workflowId, Instant closedAt,
                               String closedBy, String result, long version) {}

    public record LetterView(UUID id, UUID claimId, UUID benefitLineId, String templateCode, String channel, UUID recipientPartyId,
                             String recipientLabel, String subject, String summary, String status, Instant sentAt,
                             String workflowId, Instant createdAt) {}

    public record HistoryEventView(UUID id, UUID claimId, Instant occurredAt, Instant recordedAt, String type, String title,
                                   String actorKind, String actor, String detail, String ref, String workflowId) {}

    public record WorkItemView(UUID id, UUID ownerId, UUID claimId, int priority, String action, String why, LocalDate dueOn,
                               String waitingOn, String flag, String section, String status, long version) {}

    public record WorkflowRunView(UUID id, String workflowId, String runId, String type, String name, UUID claimId,
                                  String startedBy, String triggerKind, UUID triggerId, String status, Instant startedAt,
                                  Instant finishedAt, List<RunStep> steps, List<String> saved, String error) {}
}
