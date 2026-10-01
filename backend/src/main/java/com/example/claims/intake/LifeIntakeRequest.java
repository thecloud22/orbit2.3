package com.example.claims.intake;

import com.example.claims.view.Views.Money;
import jakarta.validation.Valid;
import jakarta.validation.constraints.NotBlank;
import jakarta.validation.constraints.NotEmpty;
import jakarta.validation.constraints.NotNull;
import jakarta.validation.constraints.Pattern;
import jakarta.validation.constraints.Size;
import java.math.BigDecimal;
import java.time.Instant;
import java.time.LocalDate;
import java.util.List;
import java.util.Set;

/**
 * POST /claims/life-intake — a phone notice of death, after the intake person has found the insured, the
 * policies being claimed and the beneficiary designation in policy administration (the mock's
 * getLifeIntakeContext + LifeDraft, flattened into one request). Everything here is what the intake
 * person knows at submit; anything that needs an outside system is checked later by the intake workflow.
 */
public record LifeIntakeRequest(
        /** When the call started. Defaults to the server clock. */
        Instant noticeReceivedAt,
        @NotNull @Valid Caller caller,
        @NotNull @Valid Insured insured,
        @NotNull @Valid Death death,
        @NotEmpty @Valid List<PolicyClaimed> policies,
        @NotNull @Valid Designation designation,
        @Valid Agent agent,
        boolean otherClaimantsPossible) {

    public record Caller(
            @NotBlank @Size(max = 200) String name,
            @Size(max = 100) String relationship,
            String phone,
            String email,
            /** email, text, phone, mail */
            @NotNull Set<@Pattern(regexp = "email|text|phone|mail") String> contactBy,
            boolean verifiedDateOfBirth,
            boolean verifiedPolicyNumber,
            boolean agentConsent,
            /** Set when the caller is one of the designated beneficiaries: the beneficiary's `ref`. */
            String beneficiaryRef) {}

    public record Insured(@NotBlank String name, @NotNull LocalDate dateOfBirth, @Pattern(regexp = "[0-9]{4}") String ssnLast4) {}

    public record Death(
            @NotNull LocalDate dateOfDeath,
            String placeOfDeath,
            @NotNull @Pattern(regexp = "natural|accident|pending") String manner,
            boolean outsideUs,
            String funeralHome) {}

    public record PolicyClaimed(
            @NotBlank String policyNumber,
            @NotBlank String productCode,
            @NotBlank String productName,
            @NotNull LocalDate issueDate,
            @NotNull LocalDate paidToDate,
            boolean inForce,
            LocalDate lapsedOn,
            @NotNull @Valid Money faceAmount,
            @Valid List<Rider> riders) {}

    public record Rider(@NotBlank String key, @NotBlank String name, @NotNull @Valid Money amount) {}

    public record Designation(@NotNull LocalDate date, String source, @NotEmpty @Valid List<Beneficiary> beneficiaries) {}

    public record Beneficiary(
            /** Client-chosen reference, unique in this request; links the caller and contacts. */
            @NotBlank String ref,
            @NotBlank String name,
            String relationship,
            @NotNull @Pattern(regexp = "primary|contingent") String kind,
            @NotNull BigDecimal sharePercent,
            LocalDate dateOfBirth,
            LocalDate diedOn,
            String diedSource,
            @Valid Contact contact) {}

    public record Contact(String phone, String email, String address, @Pattern(regexp = "portal|mail") String packet) {}

    public record Agent(@NotBlank String name, String agency) {}
}
