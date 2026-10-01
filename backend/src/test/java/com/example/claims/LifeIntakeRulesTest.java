package com.example.claims;

import static org.assertj.core.api.Assertions.assertThat;

import com.example.claims.common.BusinessCalendar;
import com.example.claims.domain.DeadlineKind;
import com.example.claims.domain.RequirementKey;
import com.example.claims.intake.LifeIntakeRules;
import com.example.claims.intake.LifeIntakeRules.PlannedDeadline;
import com.example.claims.intake.LifeIntakeRules.PlannedRequirement;
import com.example.claims.intake.LifeIntakeRules.RouteFacts;
import com.example.claims.support.TestData;
import java.math.BigDecimal;
import java.time.Instant;
import java.time.LocalTime;
import java.time.ZoneId;
import java.util.List;
import org.junit.jupiter.api.Test;

class LifeIntakeRulesTest {
    BusinessCalendar calendar = new BusinessCalendar(ZoneId.of("America/Chicago"), LocalTime.of(8, 0));

    @Test
    void naturalDeathWithPrimaryGoneRequestsFourAndMeetsOneFromOurRecords() {
        List<PlannedRequirement> set = LifeIntakeRules.requirementSet(TestData.castellano("natural"));

        assertThat(set).extracting(PlannedRequirement::key).containsExactly(
                RequirementKey.CERTIFICATE, RequirementKey.STATEMENT, RequirementKey.STATEMENT, RequirementKey.PRIMARY_DIED_FIRST);
        assertThat(set.get(3).isOnFile()).isTrue();
        assertThat(set.stream().filter(PlannedRequirement::isOnFile)).hasSize(1);
    }

    @Test
    void accidentAddsTheReportAndPendingAddsTheAmendedCertificateWithAThirtyDayFollowUp() {
        assertThat(LifeIntakeRules.requirementSet(TestData.castellano("accident")))
                .extracting(PlannedRequirement::key).contains(RequirementKey.REPORT).hasSize(5);
        List<PlannedRequirement> pending = LifeIntakeRules.requirementSet(TestData.castellano("pending"));
        assertThat(pending).filteredOn(p -> p.key() == RequirementKey.AMENDED_CERTIFICATE).singleElement()
                .satisfies(p -> assertThat(p.followUpDays()).isEqualTo(30));
    }

    @Test
    void firstDeadlinesMatchTheMockStorySevenRowsDueAtEightLocal() {
        var request = TestData.castellano("natural");
        var set = LifeIntakeRules.requirementSet(request);

        List<PlannedDeadline> rows = LifeIntakeRules.firstDeadlines(request, set, TestData.NOTICE_AT, calendar);

        assertThat(rows).hasSize(7);   // D-701..D-707 in the doc: ack, forms, first contact, status letter, 3 follow-ups
        assertThat(rows).extracting(PlannedDeadline::kind).containsExactly(DeadlineKind.ACKNOWLEDGE_BY, DeadlineKind.FORMS_BY,
                DeadlineKind.FIRST_CONTACT_BY, DeadlineKind.STATUS_LETTER, DeadlineKind.REQUIREMENT_FOLLOW_UP,
                DeadlineKind.REQUIREMENT_FOLLOW_UP, DeadlineKind.REQUIREMENT_FOLLOW_UP);
        // Notice Fri 25 Sep 10:03 CDT. Acknowledge: +15 days = Sat 10 Oct. First contact: next business day = Mon 28 Sep.
        assertThat(rows.get(0).dueAt()).isEqualTo(Instant.parse("2026-10-10T13:00:00Z"));
        assertThat(rows.get(2).dueAt()).isEqualTo(Instant.parse("2026-09-28T13:00:00Z"));
        assertThat(rows.get(3).dueAt()).isEqualTo(Instant.parse("2026-10-25T13:00:00Z"));
        assertThat(rows.get(4).dueAt()).isEqualTo(Instant.parse("2026-10-05T13:00:00Z"));   // follow-up +10 days = Mon 5 Oct
    }

    @Test
    void businessDaysSkipWeekendsOnly() {
        assertThat(calendar.addBusinessDays(java.time.LocalDate.of(2026, 9, 25), 1)).isEqualTo(java.time.LocalDate.of(2026, 9, 28));
        assertThat(calendar.addBusinessDays(java.time.LocalDate.of(2026, 10, 7), 5)).isEqualTo(java.time.LocalDate.of(2026, 10, 14));
    }

    @Test
    void routingFollowsLf01AndLf02() {
        var fast = LifeIntakeRules.route(new RouteFacts("natural", true, new BigDecimal("200000.00"), true, false, false));
        assertThat(fast.rule()).isEqualTo("LF-01");
        assertThat(fast.reasons()).contains("Natural causes", "Past the contestable period", "$200,000 is within the $500,000 fast-track limit");

        var std = LifeIntakeRules.route(new RouteFacts("accident", true, new BigDecimal("400000.00"), true, true, false));
        assertThat(std.rule()).isEqualTo("LF-02");
        assertThat(std.track()).isEqualTo("standard_life");
        assertThat(std.reasons()).containsExactly("Accidental death: the rider needs a report", "Someone else may claim");

        assertThat(LifeIntakeRules.route(new RouteFacts("natural", false, new BigDecimal("600000"), false, false, true)).reasons())
                .containsExactly("Contestable policy", "$600,000 is above the $500,000 fast-track limit", "A beneficiary is a minor", "Death outside the US");
    }
}
