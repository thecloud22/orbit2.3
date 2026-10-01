using System.Text.Json.Nodes;
using Claims.Common;
using Claims.Intake;
using Claims.Tests.Support;
using Npgsql;

namespace Claims.Tests.Postgres;

/// <summary>REQUIRES POSTGRES. The intake endpoint end to end over HTTP: one transaction, returns before any workflow runs.</summary>
public class LifeIntakeApiPostgresTests(LifeIntakeApiPostgresTests.Fixture fixture) : IClassFixture<LifeIntakeApiPostgresTests.Fixture>
{
    public sealed class Fixture : PostgresApiFixture
    {
        protected override string Hint => "api";
    }

    private HttpClient Http => fixture.CreateClient();
    private Db Sql => fixture.Db;

    private static string Policy() => TestData.NewPolicy();

    private static string BodyOf(LifeIntakeRequest r) => Json.Serialize(r);

    private Task<ApiResponse> SubmitAsync(LifeIntakeRequest r, string key) =>
        Http.PostApiAsync("/claims/life-intake", BodyOf(r), new Dictionary<string, string> { ["Idempotency-Key"] = key });

    private Task<ApiResponse> SubmitBodyAsync(string body, string? key) =>
        Http.PostApiAsync("/claims/life-intake", body, key is null ? null : new Dictionary<string, string> { ["Idempotency-Key"] = key });

    private static string NewKey() => "intake-" + Guid.NewGuid();

    private static IReadOnlyDictionary<string, string> IfMatch(string etag) => new Dictionary<string, string> { ["If-Match"] = etag };

    [PostgresFact]
    public async Task CommitsClaimRequirementsAndFirstDeadlinesThenReturnsBeforeAnyWorkflowRuns()
    {
        var request = TestData.Castellano("natural", Policy(), "Robert Castellano", true);

        var res = await SubmitAsync(request, NewKey());

        Assert.Equal(201, res.StatusCode);
        Assert.NotNull(res.Header("Location"));
        Assert.Equal("\"0\"", res.Header("ETag"));
        Assert.Matches(@"^L-26-\d{6}$", res.Str("claimNumber"));
        Assert.Equal("received", res.Str("status"));                 // set-up has NOT happened yet
        Assert.Null(res.At("track"));
        Assert.Equal(2, res.At("benefitLines")!.AsArray().Count);
        Assert.Equal("200000.00", res.At("benefitLines")!.AsArray().Single(b => b!["kind"]!.ToString() == "base")!["amount"]!["amount"]!.ToString());
        Assert.Equal("not_payable", res.At("benefitLines")!.AsArray().Single(b => b!["kind"]!.ToString() == "rider")!["status"]!.ToString());
        Assert.Equal("2026-09-19", res.Str("details.dateOfDeath"));
        var claimId = Guid.Parse(res.Str("id")!);

        // Requirements: four, one already met from our own records (the primary beneficiary's death).
        var reqs = await Http.GetApiAsync($"/claims/{claimId}/requirements");
        Assert.Equal(4, reqs.Items.Count());
        Assert.Equal("primary_died_first", Assert.Single(reqs.ItemsWhere("state", "accepted"))["key"]!.ToString());
        Assert.Equal(3, reqs.ItemsWhere("state", "requested").Count());
        // Deadlines: the mock's D-701..D-707.
        var deadlines = await Http.GetApiAsync($"/claims/{claimId}/deadlines");
        Assert.Equal(7, deadlines.Items.Count());
        Assert.Equal("2026-10-10T13:00:00Z", Assert.Single(deadlines.ItemsWhere("kind", "acknowledge_by"))["dueAt"]!.ToString());
        Assert.Equal(3, deadlines.ItemsWhere("kind", "requirement_follow_up").Count());
        Assert.DoesNotContain(deadlines.Items, d => d["state"]!.ToString() != "open");

        // The notice and an outbox event were saved with it; nothing has run.
        Assert.Equal(1, await Sql.SingleAsync<int>("SELECT count(*) FROM outbox_events WHERE claim_id = @c AND published_at IS NULL AND event_type = 'notice_of_death_received'", new { c = claimId }));
        Assert.Equal(0, await Sql.SingleAsync<int>("SELECT count(*) FROM workflow_runs WHERE claim_id = @c", new { c = claimId }));
        Assert.Equal(0, await Sql.SingleAsync<int>("SELECT count(*) FROM letters WHERE claim_id = @c", new { c = claimId }));
        Assert.Empty(fixture.Launcher.StartedIntakes);
        Assert.Equal(2, (await Http.GetApiAsync($"/claims/{claimId}/history")).Items.Count());
    }

    [PostgresFact]
    public async Task RepeatWithSameKeyReplaysTheSameClaimAndADifferentBodyIsRejected()
    {
        var policy = Policy();
        var key = NewKey();
        var request = TestData.Castellano("natural", policy, "Repeat Person", true);

        var first = await SubmitAsync(request, key);
        var second = await SubmitAsync(request, key);

        Assert.Equal(201, first.StatusCode);
        Assert.Equal(200, second.StatusCode);
        Assert.Equal("true", second.Header("Idempotent-Replayed"));
        Assert.Equal(first.Str("id"), second.Str("id"));
        Assert.Equal(1, await Sql.SingleAsync<int>(
            "SELECT count(*) FROM claims c JOIN benefit_lines b ON b.claim_id = c.id JOIN policies p ON p.id = b.policy_id WHERE p.policy_number = @n AND b.kind = 'base'", new { n = policy }));

        var clash = await SubmitAsync(TestData.Castellano("accident", policy, "Repeat Person", true), key);
        Assert.Equal(409, clash.StatusCode);
        Assert.Equal("idempotency_key_reuse", clash.Str("code"));
        Assert.StartsWith("application/problem+json", clash.ContentType);
    }

    [PostgresFact]
    public async Task ConcurrentRequestsWithTheSameKeyCreateOneClaim()
    {
        var key = NewKey();
        var request = TestData.Castellano("natural", Policy(), "Racing Person", true);

        var statuses = await Task.WhenAll(Enumerable.Range(0, 4).Select(_ => Task.Run(async () => (await SubmitAsync(request, key)).StatusCode)));

        Assert.Equal([200, 200, 200, 201], statuses.Order());
        Assert.Equal(1, await Sql.SingleAsync<int>("SELECT count(*) FROM parties WHERE full_name = 'Racing Person'"));
    }

    [PostgresFact]
    public async Task IfAnythingFailsPartWayNothingIsSaved()
    {
        var policy = Policy();
        var ok = TestData.Castellano("natural", policy, "Atomic Person", true);
        // A beneficiary packet channel the database rejects, at the point claim_parties are written (after parties, the policy, the
        // claim and its details are already inserted in the same transaction). The API's shape check allows only portal|mail, so this goes
        // to the service directly, as the Java test did.
        var bad = ok.Designation.Beneficiaries.ToList();
        var diane = bad[1];
        bad[1] = diane with { Contact = new Contact("1", "d@example.com", "x", "pigeon") };
        var broken = ok with { Designation = ok.Designation with { Beneficiaries = bad } };

        await Assert.ThrowsAsync<PostgresException>(() => fixture.Get<LifeIntakeService>().SubmitAsync(broken, "atomic-" + Guid.NewGuid(), Actor.User("test")));

        Assert.Equal(0, await Sql.SingleAsync<int>("SELECT count(*) FROM parties WHERE full_name = 'Atomic Person'"));
        Assert.Equal(0, await Sql.SingleAsync<int>("SELECT count(*) FROM policies WHERE policy_number = @n", new { n = policy }));
        Assert.Equal(0, await Sql.SingleAsync<int>("SELECT count(*) FROM claims c JOIN parties p ON p.id = c.insured_party_id WHERE p.full_name = 'Atomic Person'"));
    }

    [PostgresFact]
    public async Task InvalidRequestsGetProblemJsonWithStableCodes()
    {
        var body = BodyOf(TestData.Castellano("natural", Policy(), "Invalid Person", true));

        var noKey = await SubmitBodyAsync(body, null);
        Assert.Equal(400, noKey.StatusCode);
        Assert.Equal("missing_header", noKey.Str("code"));
        var shortKey = await SubmitBodyAsync(body, "k");
        Assert.Equal(400, shortKey.StatusCode);
        Assert.Equal("invalid_idempotency_key", shortKey.Str("code"));
        var malformed = await SubmitBodyAsync("{nope", NewKey());
        Assert.Equal(400, malformed.StatusCode);
        Assert.Equal("malformed_request", malformed.Str("code"));
        // Shape errors: 422 with field-level details.
        var shape = await SubmitBodyAsync(body.Replace("\"200000.00\"", "\"200000.001\"", StringComparison.Ordinal), NewKey());
        Assert.Equal(422, shape.StatusCode);
        Assert.Equal("validation_failed", shape.Str("code"));
        Assert.NotNull(shape.At("errors[0].field"));
        Assert.Contains(shape.Json["errors"]!.AsArray(), e => e!["field"]!.ToString() == "policies[0].faceAmount.amount");
        // Business rules: 422 with a specific code.
        var shares = await SubmitBodyAsync(body.Replace("\"sharePercent\":50", "\"sharePercent\":40", StringComparison.Ordinal), NewKey());
        Assert.Equal(422, shares.StatusCode);
        Assert.Equal("payee_shares_invalid", shares.Str("code"));
        var identity = await SubmitBodyAsync(body.Replace("\"verifiedDateOfBirth\":true", "\"verifiedDateOfBirth\":false", StringComparison.Ordinal), NewKey());
        Assert.Equal(422, identity.StatusCode);
        Assert.Equal("identity_not_verified", identity.Str("code"));
    }

    [PostgresFact]
    public async Task ReadsListClaimsWithKeysetPaginationAndReturn404ForUnknownIds()
    {
        for (var i = 0; i < 3; i++) await SubmitAsync(TestData.Castellano("natural", Policy(), "Paged Person " + i, true), NewKey());

        var page1 = await Http.GetApiAsync("/claims?limit=2");
        Assert.Equal(200, page1.StatusCode);
        Assert.Equal(2, page1.Items.Count());
        var cursor = page1.Str("nextCursor");
        Assert.False(string.IsNullOrEmpty(cursor));
        var firstId = page1.Str("items[0].id");
        var page2 = await Http.GetApiAsync($"/claims?limit=2&cursor={Uri.EscapeDataString(cursor!)}");
        Assert.Equal(200, page2.StatusCode);
        Assert.DoesNotContain(page2.Items, i => i["id"]!.ToString() == firstId);

        var number = page1.Str("items[0].claimNumber");
        Assert.Single((await Http.GetApiAsync($"/claims?claimNumber={number}")).Items);
        var garbage = await Http.GetApiAsync("/claims?cursor=garbage");
        Assert.Equal(400, garbage.StatusCode);
        Assert.Equal("invalid_cursor", garbage.Str("code"));

        var missing = await Http.GetApiAsync($"/claims/{Guid.NewGuid()}");
        Assert.Equal(404, missing.StatusCode);
        Assert.Equal("not_found", missing.Str("code"));
        Assert.Equal(404, (await Http.GetApiAsync($"/claims/{Guid.NewGuid()}/requirements")).StatusCode);
        var queue = await Http.GetApiAsync("/work-items?status=open");
        Assert.Equal(200, queue.StatusCode);
        Assert.IsType<JsonArray>(queue.Json["items"]);
    }

    [PostgresFact]
    public async Task AcceptingARequirementUsesOptimisticConcurrencyAndClosesItsFollowUpRow()
    {
        var res = await SubmitAsync(TestData.Castellano("natural", Policy(), "Concurrency Person", true), NewKey());
        var claimId = res.Str("id");
        var reqs = await Http.GetApiAsync($"/claims/{claimId}/requirements");
        var reqId = reqs.ItemsWhere("key", "certificate").Single()["id"]!.ToString();

        var noHeader = await Http.PostApiAsync($"/requirements/{reqId}:accept");
        Assert.Equal(428, noHeader.StatusCode);
        Assert.Equal("precondition_required", noHeader.Str("code"));
        var stale = await Http.PostApiAsync($"/requirements/{reqId}:accept", null, IfMatch("\"41\""));
        Assert.Equal(412, stale.StatusCode);
        Assert.Equal("version_conflict", stale.Str("code"));
        var got = await Http.GetApiAsync($"/requirements/{reqId}");
        Assert.Equal("\"0\"", got.Header("ETag"));

        var accepted = await Http.PostApiAsync($"/requirements/{reqId}:accept", "{\"satisfiedBy\":\"Certificate received by mail\"}", IfMatch("\"0\""));
        Assert.Equal(200, accepted.StatusCode);
        Assert.Equal("\"1\"", accepted.Header("ETag"));
        Assert.Equal("accepted", accepted.Str("state"));
        Assert.Equal("Certificate received by mail", accepted.Str("satisfiedBy"));
        var again = await Http.PostApiAsync($"/requirements/{reqId}:accept", null, IfMatch("\"1\""));
        Assert.Equal(409, again.StatusCode);
        Assert.Equal("invalid_state", again.Str("code"));

        // Its follow-up row closed without ever firing.
        var row = Assert.Single((await Http.GetApiAsync($"/claims/{claimId}/deadlines")).ItemsWhere("requirementId", reqId));
        Assert.Equal("done", row["state"]!.ToString());
        Assert.Equal("requirement", row["closedBy"]!.ToString());
        Assert.False(row["fired"]!.GetValue<bool>());

        var waiveId = reqs.Items.First(i => i["name"]!.ToString().EndsWith("Mark", StringComparison.Ordinal))["id"]!.ToString();
        var blank = await Http.PostApiAsync($"/requirements/{waiveId}:waive", "{\"reason\":\" \"}", IfMatch("\"0\""));
        Assert.Equal(422, blank.StatusCode);
        Assert.Equal("reason_required", blank.Str("code"));
    }

    [PostgresFact]
    public async Task LastRequirementCompletesProofOfLossAndStartsTheDecisionClock()
    {
        var res = await SubmitAsync(TestData.Castellano("natural", Policy(), "Proof Person", true), NewKey());
        var claimId = Guid.Parse(res.Str("id")!);
        // Set-up has not run in this test (no worker), so put the claim where the intake workflow would leave it.
        await Sql.ExecuteAsync("UPDATE claims SET status = 'gathering_evidence', track = 'fast_track_life', route_rule = 'LF-01' WHERE id = @c", new { c = claimId });

        var reqs = await Http.GetApiAsync($"/claims/{claimId}/requirements");
        var open = reqs.ItemsWhere("state", "requested").Select(i => i["id"]!.ToString()).ToList();
        Assert.Equal(3, open.Count);
        for (var i = 0; i < 3; i++)
        {
            Assert.Equal(200, (await Http.PostApiAsync($"/requirements/{open[i]}:accept", null, IfMatch("\"0\""))).StatusCode);
            var status = (await Http.GetApiAsync($"/claims/{claimId}")).Str("status");
            Assert.Equal(i < 2 ? "gathering_evidence" : "in_review", status);
        }
        var deadlines = await Http.GetApiAsync($"/claims/{claimId}/deadlines");
        Assert.Single(deadlines.ItemsWhere("kind", "decision_due"));
        Assert.Single(deadlines.ItemsWhere("kind", "review_target"));
        Assert.Equal("decide", deadlines.ItemsWhere("kind", "decision_due").Single()["sla"]!.ToString());
        Assert.Equal(1, await Sql.SingleAsync<int>("SELECT count(*) FROM work_items WHERE claim_id = @c AND action LIKE 'Record decision%'", new { c = claimId }));
    }

    [PostgresFact]
    public async Task ExtendingADeadlineNeedsAReasonAKnownVersionAndKeepsTheOriginalDate()
    {
        var res = await SubmitAsync(TestData.Castellano("natural", Policy(), "Extension Person", true), NewKey());
        var claimId = res.Str("id");
        var ack = Assert.Single((await Http.GetApiAsync($"/claims/{claimId}/deadlines")).ItemsWhere("kind", "acknowledge_by"));
        var id = ack["id"]!.ToString();
        var due = ack["dueAt"]!.ToString();

        var noReason = await Http.PostApiAsync($"/deadlines/{id}:extend", "{\"newDueAt\":\"2026-10-20T13:00:00Z\"}", IfMatch("\"0\""));
        Assert.Equal(422, noReason.StatusCode);
        Assert.Equal("reason_required", noReason.Str("code"));
        var earlier = await Http.PostApiAsync($"/deadlines/{id}:extend", "{\"newDueAt\":\"2026-10-01T13:00:00Z\",\"reason\":\"earlier\"}", IfMatch("\"0\""));
        Assert.Equal(422, earlier.StatusCode);
        Assert.Equal("not_an_extension", earlier.Str("code"));
        var extended = await Http.PostApiAsync($"/deadlines/{id}:extend", "{\"newDueAt\":\"2026-10-20T13:00:00Z\",\"reason\":\"Claimant asked for time\"}", IfMatch("\"0\""));
        Assert.Equal(200, extended.StatusCode);
        Assert.Equal("2026-10-20T13:00:00Z", extended.Str("dueAt"));
        Assert.Equal(due, extended.Str("originalDueAt"));
        Assert.Equal("Claimant asked for time", extended.Str("extensionReason"));
        var stale = await Http.PostApiAsync($"/deadlines/{id}:extend", "{\"newDueAt\":\"2026-10-25T13:00:00Z\",\"reason\":\"again\"}", IfMatch("\"0\""));
        Assert.Equal(412, stale.StatusCode);
    }

    /// <summary>Not a port of a Java test: Spring answered a matching If-None-Match with 304 on its own, so this backend does too.</summary>
    [PostgresFact]
    public async Task AGetWithAMatchingIfNoneMatchIs304WithNoBody()
    {
        var res = await SubmitAsync(TestData.Castellano("natural", Policy(), "Conditional Person", true), NewKey());
        var path = $"/claims/{res.Str("id")}";

        var same = await Http.SendJsonAsync(HttpMethod.Get, path, null, new Dictionary<string, string> { ["If-None-Match"] = "\"0\"" });
        Assert.Equal(304, same.StatusCode);
        Assert.Equal("\"0\"", same.Header("ETag"));
        Assert.Equal("", same.Body);
        var other = await Http.SendJsonAsync(HttpMethod.Get, path, null, new Dictionary<string, string> { ["If-None-Match"] = "\"7\"" });
        Assert.Equal(200, other.StatusCode);
    }
}
