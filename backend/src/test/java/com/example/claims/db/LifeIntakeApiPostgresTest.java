package com.example.claims.db;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.get;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.post;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.header;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.jsonPath;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.status;

import com.example.claims.common.Actor;
import com.example.claims.intake.LifeIntakeRequest;
import com.example.claims.intake.LifeIntakeRequest.Beneficiary;
import com.example.claims.intake.LifeIntakeRequest.Contact;
import com.example.claims.intake.LifeIntakeService;
import com.example.claims.support.PostgresTestSupport;
import com.example.claims.support.RecordingLauncher;
import com.example.claims.support.RequiresPostgres;
import com.example.claims.support.TestData;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.jayway.jsonpath.JsonPath;
import java.util.ArrayList;
import java.util.List;
import java.util.UUID;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.autoconfigure.web.servlet.AutoConfigureMockMvc;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.boot.test.context.TestConfiguration;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Primary;
import org.springframework.dao.DataAccessException;
import org.springframework.http.MediaType;
import org.springframework.jdbc.core.simple.JdbcClient;
import org.springframework.test.context.ActiveProfiles;
import org.springframework.test.context.DynamicPropertyRegistry;
import org.springframework.test.context.DynamicPropertySource;
import org.springframework.test.web.servlet.MockMvc;
import org.springframework.test.web.servlet.MvcResult;

/** REQUIRES POSTGRES. The intake endpoint end to end over HTTP: one transaction, returns before any workflow runs. */
@RequiresPostgres
@SpringBootTest
@AutoConfigureMockMvc(print = org.springframework.boot.test.autoconfigure.web.servlet.MockMvcPrint.NONE)
@ActiveProfiles("test")
class LifeIntakeApiPostgresTest {

    @TestConfiguration
    static class Config {
        @Bean @Primary RecordingLauncher launcher() { return new RecordingLauncher(); }
    }

    @DynamicPropertySource
    static void database(DynamicPropertyRegistry registry) {
        PostgresTestSupport.register(registry, "api");
    }

    @Autowired MockMvc mvc;
    @Autowired ObjectMapper json;
    @Autowired JdbcClient jdbc;
    @Autowired LifeIntakeService intake;
    @Autowired RecordingLauncher launcher;

    private static String policy() { return "WL-" + UUID.randomUUID().toString().substring(0, 8); }

    private MvcResult submit(LifeIntakeRequest r, String key) throws Exception {
        return mvc.perform(post("/claims/life-intake").header("Idempotency-Key", key).contentType(MediaType.APPLICATION_JSON)
                .content(json.writeValueAsString(r))).andReturn();
    }

    @Test
    void commitsClaimRequirementsAndFirstDeadlinesThenReturnsBeforeAnyWorkflowRuns() throws Exception {
        LifeIntakeRequest request = TestData.castellano("natural", policy(), "Robert Castellano", true);

        MvcResult res = mvc.perform(post("/claims/life-intake").header("Idempotency-Key", "intake-" + UUID.randomUUID())
                        .contentType(MediaType.APPLICATION_JSON).content(json.writeValueAsString(request)))
                .andExpect(status().isCreated())
                .andExpect(header().exists("Location"))
                .andExpect(header().string("ETag", "\"0\""))
                .andExpect(jsonPath("$.claimNumber").value(org.hamcrest.Matchers.matchesPattern("L-26-\\d{6}")))
                .andExpect(jsonPath("$.status").value("received"))          // set-up has NOT happened yet
                .andExpect(jsonPath("$.track").doesNotExist())
                .andExpect(jsonPath("$.benefitLines.length()").value(2))
                .andExpect(jsonPath("$.benefitLines[?(@.kind=='base')].amount.amount").value("200000.00"))
                .andExpect(jsonPath("$.benefitLines[?(@.kind=='rider')].status").value("not_payable"))
                .andExpect(jsonPath("$.details.dateOfDeath").value("2026-09-19"))
                .andReturn();
        String claimId = JsonPath.read(res.getResponse().getContentAsString(), "$.id");

        // Requirements: four, one already met from our own records (the primary beneficiary's death).
        mvc.perform(get("/claims/{id}/requirements", claimId))
                .andExpect(jsonPath("$.items.length()").value(4))
                .andExpect(jsonPath("$.items[?(@.state=='accepted')].key").value("primary_died_first"))
                .andExpect(jsonPath("$.items[?(@.state=='requested')]").value(org.hamcrest.Matchers.hasSize(3)));
        // Deadlines: the mock's D-701..D-707.
        mvc.perform(get("/claims/{id}/deadlines", claimId))
                .andExpect(jsonPath("$.items.length()").value(7))
                .andExpect(jsonPath("$.items[?(@.kind=='acknowledge_by')].dueAt").value("2026-10-10T13:00:00Z"))
                .andExpect(jsonPath("$.items[?(@.kind=='requirement_follow_up')]").value(org.hamcrest.Matchers.hasSize(3)))
                .andExpect(jsonPath("$.items[?(@.state!='open')]").value(org.hamcrest.Matchers.hasSize(0)));

        // The notice and an outbox event were saved with it; nothing has run.
        assertThat(jdbc.sql("SELECT count(*) FROM outbox_events WHERE claim_id = :c AND published_at IS NULL AND event_type = 'notice_of_death_received'")
                .param("c", UUID.fromString(claimId)).query(Integer.class).single()).isEqualTo(1);
        assertThat(jdbc.sql("SELECT count(*) FROM workflow_runs WHERE claim_id = :c").param("c", UUID.fromString(claimId)).query(Integer.class).single()).isZero();
        assertThat(jdbc.sql("SELECT count(*) FROM letters WHERE claim_id = :c").param("c", UUID.fromString(claimId)).query(Integer.class).single()).isZero();
        assertThat(launcher.startedIntakes).isEmpty();
        mvc.perform(get("/claims/{id}/history", claimId)).andExpect(jsonPath("$.items.length()").value(2));
    }

    @Test
    void repeatWithSameKeyReplaysTheSameClaimAndADifferentBodyIsRejected() throws Exception {
        String policy = policy();
        String key = "intake-" + UUID.randomUUID();
        LifeIntakeRequest request = TestData.castellano("natural", policy, "Repeat Person", true);

        MvcResult first = submit(request, key);
        MvcResult second = submit(request, key);

        assertThat(first.getResponse().getStatus()).isEqualTo(201);
        assertThat(second.getResponse().getStatus()).isEqualTo(200);
        assertThat(second.getResponse().getHeader("Idempotent-Replayed")).isEqualTo("true");
        assertThat((String) JsonPath.read(second.getResponse().getContentAsString(), "$.id"))
                .isEqualTo(JsonPath.read(first.getResponse().getContentAsString(), "$.id"));
        assertThat(jdbc.sql("SELECT count(*) FROM claims c JOIN benefit_lines b ON b.claim_id = c.id JOIN policies p ON p.id = b.policy_id WHERE p.policy_number = :n AND b.kind = 'base'")
                .param("n", policy).query(Integer.class).single()).isEqualTo(1);

        LifeIntakeRequest different = TestData.castellano("accident", policy, "Repeat Person", true);
        MvcResult clash = submit(different, key);
        assertThat(clash.getResponse().getStatus()).isEqualTo(409);
        assertThat((String) JsonPath.read(clash.getResponse().getContentAsString(), "$.code")).isEqualTo("idempotency_key_reuse");
        assertThat(clash.getResponse().getContentType()).startsWith("application/problem+json");
    }

    @Test
    void concurrentRequestsWithTheSameKeyCreateOneClaim() throws Exception {
        String key = "intake-" + UUID.randomUUID();
        LifeIntakeRequest request = TestData.castellano("natural", policy(), "Racing Person", true);
        List<Integer> statuses = java.util.Collections.synchronizedList(new ArrayList<>());
        List<Thread> threads = new ArrayList<>();
        for (int i = 0; i < 4; i++) {
            Thread t = new Thread(() -> {
                try { statuses.add(submit(request, key).getResponse().getStatus()); } catch (Exception e) { statuses.add(-1); }
            });
            threads.add(t);
            t.start();
        }
        for (Thread t : threads) t.join();

        assertThat(statuses).containsExactlyInAnyOrder(201, 200, 200, 200);
        assertThat(jdbc.sql("SELECT count(*) FROM parties WHERE full_name = 'Racing Person'").query(Integer.class).single()).isEqualTo(1);
    }

    @Test
    void ifAnythingFailsPartWayNothingIsSaved() {
        String policy = policy();
        LifeIntakeRequest ok = TestData.castellano("natural", policy, "Atomic Person", true);
        // A beneficiary packet channel the database rejects, at the point claim_parties are written (after parties, the
        // policy, the claim and its details are already inserted in the same transaction).
        List<Beneficiary> bad = new ArrayList<>(ok.designation().beneficiaries());
        Beneficiary diane = bad.get(1);
        bad.set(1, new Beneficiary(diane.ref(), diane.name(), diane.relationship(), diane.kind(), diane.sharePercent(), diane.dateOfBirth(),
                diane.diedOn(), diane.diedSource(), new Contact("1", "d@example.com", "x", "pigeon")));
        LifeIntakeRequest broken = new LifeIntakeRequest(ok.noticeReceivedAt(), ok.caller(), ok.insured(), ok.death(), ok.policies(),
                new LifeIntakeRequest.Designation(ok.designation().date(), ok.designation().source(), bad), ok.agent(), false);

        assertThatThrownBy(() -> intake.submit(broken, "atomic-" + UUID.randomUUID(), Actor.user("test"))).isInstanceOf(DataAccessException.class);

        assertThat(jdbc.sql("SELECT count(*) FROM parties WHERE full_name = 'Atomic Person'").query(Integer.class).single()).isZero();
        assertThat(jdbc.sql("SELECT count(*) FROM policies WHERE policy_number = :n").param("n", policy).query(Integer.class).single()).isZero();
        assertThat(jdbc.sql("SELECT count(*) FROM claims c JOIN parties p ON p.id = c.insured_party_id WHERE p.full_name = 'Atomic Person'").query(Integer.class).single()).isZero();
    }

    @Test
    void invalidRequestsGetProblemJsonWithStableCodes() throws Exception {
        LifeIntakeRequest ok = TestData.castellano("natural", policy(), "Invalid Person", true);
        String body = json.writeValueAsString(ok);

        mvc.perform(post("/claims/life-intake").contentType(MediaType.APPLICATION_JSON).content(body))          // no Idempotency-Key
                .andExpect(status().isBadRequest()).andExpect(jsonPath("$.code").value("missing_header"));
        mvc.perform(post("/claims/life-intake").header("Idempotency-Key", "k").contentType(MediaType.APPLICATION_JSON).content(body))
                .andExpect(status().isBadRequest()).andExpect(jsonPath("$.code").value("invalid_idempotency_key"));
        mvc.perform(post("/claims/life-intake").header("Idempotency-Key", "intake-" + UUID.randomUUID()).contentType(MediaType.APPLICATION_JSON).content("{nope"))
                .andExpect(status().isBadRequest()).andExpect(jsonPath("$.code").value("malformed_request"));
        // Shape errors: 422 with field-level details.
        mvc.perform(post("/claims/life-intake").header("Idempotency-Key", "intake-" + UUID.randomUUID()).contentType(MediaType.APPLICATION_JSON)
                        .content(body.replace("\"200000.00\"", "\"200000.001\"")))
                .andExpect(status().isUnprocessableEntity()).andExpect(jsonPath("$.code").value("validation_failed"))
                .andExpect(jsonPath("$.errors[0].field").exists());
        // Business rules: 422 with a specific code.
        mvc.perform(post("/claims/life-intake").header("Idempotency-Key", "intake-" + UUID.randomUUID()).contentType(MediaType.APPLICATION_JSON)
                        .content(body.replace("\"sharePercent\":50", "\"sharePercent\":40")))
                .andExpect(status().isUnprocessableEntity()).andExpect(jsonPath("$.code").value("payee_shares_invalid"));
        mvc.perform(post("/claims/life-intake").header("Idempotency-Key", "intake-" + UUID.randomUUID()).contentType(MediaType.APPLICATION_JSON)
                        .content(body.replace("\"verifiedDateOfBirth\":true", "\"verifiedDateOfBirth\":false")))
                .andExpect(status().isUnprocessableEntity()).andExpect(jsonPath("$.code").value("identity_not_verified"));
    }

    @Test
    void readsListClaimsWithKeysetPaginationAndReturn404ForUnknownIds() throws Exception {
        for (int i = 0; i < 3; i++) submit(TestData.castellano("natural", policy(), "Paged Person " + i, true), "intake-" + UUID.randomUUID());

        MvcResult page1 = mvc.perform(get("/claims").param("limit", "2")).andExpect(status().isOk())
                .andExpect(jsonPath("$.items.length()").value(2)).andExpect(jsonPath("$.nextCursor").isNotEmpty()).andReturn();
        String cursor = JsonPath.read(page1.getResponse().getContentAsString(), "$.nextCursor");
        String firstId = JsonPath.read(page1.getResponse().getContentAsString(), "$.items[0].id");
        MvcResult page2 = mvc.perform(get("/claims").param("limit", "2").param("cursor", cursor)).andExpect(status().isOk()).andReturn();
        List<String> ids2 = JsonPath.read(page2.getResponse().getContentAsString(), "$.items[*].id");
        assertThat(ids2).doesNotContain(firstId);

        String number = JsonPath.read(page1.getResponse().getContentAsString(), "$.items[0].claimNumber");
        mvc.perform(get("/claims").param("claimNumber", number)).andExpect(jsonPath("$.items.length()").value(1));
        mvc.perform(get("/claims").param("cursor", "garbage")).andExpect(status().isBadRequest()).andExpect(jsonPath("$.code").value("invalid_cursor"));

        mvc.perform(get("/claims/{id}", UUID.randomUUID())).andExpect(status().isNotFound()).andExpect(jsonPath("$.code").value("not_found"));
        mvc.perform(get("/claims/{id}/requirements", UUID.randomUUID())).andExpect(status().isNotFound());
        mvc.perform(get("/work-items").param("status", "open")).andExpect(status().isOk()).andExpect(jsonPath("$.items").isArray());
    }

    @Test
    void acceptingARequirementUsesOptimisticConcurrencyAndClosesItsFollowUpRow() throws Exception {
        MvcResult res = submit(TestData.castellano("natural", policy(), "Concurrency Person", true), "intake-" + UUID.randomUUID());
        String claimId = JsonPath.read(res.getResponse().getContentAsString(), "$.id");
        MvcResult reqs = mvc.perform(get("/claims/{id}/requirements", claimId)).andReturn();
        String reqId = ((List<String>) JsonPath.read(reqs.getResponse().getContentAsString(), "$.items[?(@.key=='certificate')].id")).get(0);

        mvc.perform(post("/requirements/{id}:accept", reqId)).andExpect(status().isPreconditionRequired())
                .andExpect(jsonPath("$.code").value("precondition_required"));
        mvc.perform(post("/requirements/{id}:accept", reqId).header("If-Match", "\"41\"")).andExpect(status().isPreconditionFailed())
                .andExpect(jsonPath("$.code").value("version_conflict"));
        MvcResult get = mvc.perform(get("/requirements/{id}", reqId)).andExpect(header().string("ETag", "\"0\"")).andReturn();
        assertThat(get.getResponse().getHeader("ETag")).isEqualTo("\"0\"");

        mvc.perform(post("/requirements/{id}:accept", reqId).header("If-Match", "\"0\"").contentType(MediaType.APPLICATION_JSON).content("{\"satisfiedBy\":\"Certificate received by mail\"}"))
                .andExpect(status().isOk()).andExpect(header().string("ETag", "\"1\""))
                .andExpect(jsonPath("$.state").value("accepted")).andExpect(jsonPath("$.satisfiedBy").value("Certificate received by mail"));
        mvc.perform(post("/requirements/{id}:accept", reqId).header("If-Match", "\"1\"")).andExpect(status().isConflict())
                .andExpect(jsonPath("$.code").value("invalid_state"));

        // Its follow-up row closed without ever firing.
        mvc.perform(get("/claims/{id}/deadlines", claimId))
                .andExpect(jsonPath("$.items[?(@.requirementId=='" + reqId + "')].state").value("done"))
                .andExpect(jsonPath("$.items[?(@.requirementId=='" + reqId + "')].closedBy").value("requirement"))
                .andExpect(jsonPath("$.items[?(@.requirementId=='" + reqId + "')].fired").value(false));

        String waiveId = ((List<String>) JsonPath.read(reqs.getResponse().getContentAsString(), "$.items[?(@.name=~/.*Mark/)].id")).get(0);
        mvc.perform(post("/requirements/{id}:waive", waiveId).header("If-Match", "\"0\"").contentType(MediaType.APPLICATION_JSON).content("{\"reason\":\" \"}"))
                .andExpect(status().isUnprocessableEntity()).andExpect(jsonPath("$.code").value("reason_required"));
    }

    @Test
    void lastRequirementCompletesProofOfLossAndStartsTheDecisionClock() throws Exception {
        MvcResult res = submit(TestData.castellano("natural", policy(), "Proof Person", true), "intake-" + UUID.randomUUID());
        String claimId = JsonPath.read(res.getResponse().getContentAsString(), "$.id");
        // Set-up has not run in this test (no worker), so put the claim where the intake workflow would leave it.
        jdbc.sql("UPDATE claims SET status = 'gathering_evidence', track = 'fast_track_life', route_rule = 'LF-01' WHERE id = :c").param("c", UUID.fromString(claimId)).update();

        MvcResult reqs = mvc.perform(get("/claims/{id}/requirements", claimId)).andReturn();
        List<String> open = JsonPath.read(reqs.getResponse().getContentAsString(), "$.items[?(@.state=='requested')].id");
        assertThat(open).hasSize(3);
        for (int i = 0; i < 3; i++) {
            mvc.perform(post("/requirements/{id}:accept", open.get(i)).header("If-Match", "\"0\"")).andExpect(status().isOk());
            String s = JsonPath.read(mvc.perform(get("/claims/{id}", claimId)).andReturn().getResponse().getContentAsString(), "$.status");
            assertThat(s).isEqualTo(i < 2 ? "gathering_evidence" : "in_review");
        }
        mvc.perform(get("/claims/{id}/deadlines", claimId))
                .andExpect(jsonPath("$.items[?(@.kind=='decision_due')]").value(org.hamcrest.Matchers.hasSize(1)))
                .andExpect(jsonPath("$.items[?(@.kind=='review_target')]").value(org.hamcrest.Matchers.hasSize(1)))
                .andExpect(jsonPath("$.items[?(@.kind=='decision_due')].sla").value("decide"));
        assertThat(jdbc.sql("SELECT count(*) FROM work_items WHERE claim_id = :c AND action = 'Record decision'").param("c", UUID.fromString(claimId)).query(Integer.class).single()).isEqualTo(1);
    }

    @Test
    void extendingADeadlineNeedsAReasonAKnownVersionAndKeepsTheOriginalDate() throws Exception {
        MvcResult res = submit(TestData.castellano("natural", policy(), "Extension Person", true), "intake-" + UUID.randomUUID());
        String claimId = JsonPath.read(res.getResponse().getContentAsString(), "$.id");
        MvcResult ds = mvc.perform(get("/claims/{id}/deadlines", claimId)).andReturn();
        List<String> ids = JsonPath.read(ds.getResponse().getContentAsString(), "$.items[?(@.kind=='acknowledge_by')].id");
        List<String> dues = JsonPath.read(ds.getResponse().getContentAsString(), "$.items[?(@.kind=='acknowledge_by')].dueAt");
        String id = ids.get(0);
        String due = dues.get(0);

        mvc.perform(post("/deadlines/{id}:extend", id).header("If-Match", "\"0\"").contentType(MediaType.APPLICATION_JSON)
                        .content("{\"newDueAt\":\"2026-10-20T13:00:00Z\"}"))
                .andExpect(status().isUnprocessableEntity()).andExpect(jsonPath("$.code").value("reason_required"));
        mvc.perform(post("/deadlines/{id}:extend", id).header("If-Match", "\"0\"").contentType(MediaType.APPLICATION_JSON)
                        .content("{\"newDueAt\":\"2026-10-01T13:00:00Z\",\"reason\":\"earlier\"}"))
                .andExpect(status().isUnprocessableEntity()).andExpect(jsonPath("$.code").value("not_an_extension"));
        mvc.perform(post("/deadlines/{id}:extend", id).header("If-Match", "\"0\"").contentType(MediaType.APPLICATION_JSON)
                        .content("{\"newDueAt\":\"2026-10-20T13:00:00Z\",\"reason\":\"Claimant asked for time\"}"))
                .andExpect(status().isOk()).andExpect(jsonPath("$.dueAt").value("2026-10-20T13:00:00Z"))
                .andExpect(jsonPath("$.originalDueAt").value(due)).andExpect(jsonPath("$.extensionReason").value("Claimant asked for time"));
        mvc.perform(post("/deadlines/{id}:extend", id).header("If-Match", "\"0\"").contentType(MediaType.APPLICATION_JSON)
                        .content("{\"newDueAt\":\"2026-10-25T13:00:00Z\",\"reason\":\"again\"}"))
                .andExpect(status().isPreconditionFailed());
    }
}
