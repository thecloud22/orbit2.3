using Claims.Common;
using Claims.Outbox;
using Claims.Tests.Support;
using Npgsql;

namespace Claims.Tests.Postgres;

/// <summary>
/// REQUIRES POSTGRES. Recording and approving a decision, over the real HTTP pipeline and real SQL: the one transaction (and that it really is one),
/// the authority check, the approval, the immutability of what was recorded, and the guards. Business time is frozen at Thu 8 Oct 2026 11:30 Central,
/// the mock's day for the decision, so the money is the same whenever the suite runs.
/// </summary>
public class DecisionPostgresTests(DecisionPostgresTests.Fixture fixture) : IClassFixture<DecisionPostgresTests.Fixture>
{
    public sealed class Fixture : PostgresApiFixture
    {
        protected override string Hint => "decision";

        protected override DateTimeOffset? ClockStart => DateTimeOffset.Parse("2026-10-08T16:30:00Z", System.Globalization.CultureInfo.InvariantCulture);

        protected override IReadOnlyDictionary<string, string?> Settings { get; } = new Dictionary<string, string?> { ["Claims:Db:DevSeed"] = "true" };
    }

    private Db Sql => fixture.Db;

    private Task<T> One<T>(string sql, object? param = null) => Sql.SingleAsync<T>(sql, param);

    private Task<ApiResponse> DecideAsync(ReadyClaim c, string actor = "rachel", string? key = null, Guid? line = null, string? body = null) =>
        fixture.CreateClient().PostApiAsync($"/claims/{c.ClaimId}/decisions", body ?? LifeScenario.ApproveJson(line ?? c.BaseLineId), LifeScenario.Headers(actor, key));

    [PostgresFact]
    public async Task WithinAuthorityOneTransactionLocksTheDecisionClearsTheItemsAndWritesEverythingElse()
    {
        var c = await LifeScenario.InReviewAsync(fixture);
        var beforeOutbox = await One<int>("SELECT count(*) FROM outbox_events WHERE claim_id = @c", new { c = c.ClaimId });

        var r = await DecideAsync(c);

        Assert.Equal(201, r.StatusCode);
        Assert.Equal("recorded", r.Str("kind"));
        Assert.Equal("Approved · $200,000.00 + $383.56 interest", r.Str("decision.outcomeText"));
        Assert.Equal("in_effect", r.Str("decision.status"));
        Assert.Equal("within $250,000 authority", r.Str("decision.authorityNote"));
        Assert.Equal("200383.56", r.Str("decision.amount.amount"));
        Assert.Equal("/decisions/" + r.Str("decision.id"), r.Header("Location"));
        // The natural-causes rider is closed with its own decision (ADB-LIFE-03), decided together with the base line.
        Assert.Equal(["closed"], r.Json["relatedDecisions"]!.AsArray().Select(d => d!["outcome"]!.ToString()));
        // Two payment items, one per payee, cleared for the next business day: $100,000.00 + $191.78 each.
        var items = r.Json["paymentItems"]!.AsArray();
        Assert.Equal(["Diane Castellano", "Mark Castellano"], items.Select(i => i!["payeeName"]!.ToString()));
        Assert.All(items, i =>
        {
            Assert.Equal("cleared", i!["status"]!.ToString());
            Assert.Equal("100000.00", i["principal"]!["amount"]!.ToString());
            Assert.Equal("191.78", i["interest"]!["amount"]!.ToString());
            Assert.Equal("100191.78", i["amount"]!["amount"]!.ToString());
            Assert.Equal("2026-10-09", i["payOn"]!.ToString());
            Assert.Equal("eft", i["method"]!.ToString());
        });

        // The rest of what the one transaction wrote.
        Assert.Equal("approved", await One<string>("SELECT status FROM claims WHERE id = @c", new { c = c.ClaimId }));
        Assert.Equal("approved|closed", string.Join('|', await Sql.ListAsync<string>("SELECT status FROM benefit_lines WHERE claim_id = @c ORDER BY kind", new { c = c.ClaimId })));
        Assert.Equal(["decision_due:done:decision", "review_target:done:decision", "status_letter:skipped:decision"], await Sql.ListAsync<string>(
            "SELECT kind || ':' || state || ':' || closed_by FROM deadlines WHERE claim_id = @c AND kind IN ('decision_due', 'review_target', 'status_letter') ORDER BY kind", new { c = c.ClaimId }));
        Assert.Equal("Pay Diane and Mark", await One<string>("SELECT what FROM deadlines WHERE claim_id = @c AND kind = 'payment_due' AND state = 'open'", new { c = c.ClaimId }));
        Assert.Equal("2026-10-12 08:00:00", await One<string>(
            "SELECT to_char(due_at AT TIME ZONE 'America/Chicago', 'YYYY-MM-DD HH24:MI:SS') FROM deadlines WHERE claim_id = @c AND kind = 'payment_due'", new { c = c.ClaimId }));   // 2 business days: Mon 12 Oct
        Assert.Equal("done", await One<string>("SELECT status FROM work_items WHERE claim_id = @c AND dedupe_key = @k", new { c = c.ClaimId, k = "record-decision:" + c.ClaimId }));
        Assert.Equal(1, await One<int>("SELECT count(*) FROM history_events WHERE claim_id = @c AND type = 'decision' AND title LIKE 'Decision recorded%'", new { c = c.ClaimId }));
        Assert.Equal(1, await One<int>("SELECT count(*) FROM history_events WHERE claim_id = @c AND type = 'payment' AND title LIKE '2 payment items cleared%'", new { c = c.ClaimId }));
        Assert.Equal(beforeOutbox + 1, await One<int>("SELECT count(*) FROM outbox_events WHERE claim_id = @c", new { c = c.ClaimId }));
        Assert.Equal("decision_recorded", await One<string>("SELECT event_type FROM outbox_events WHERE claim_id = @c ORDER BY seq DESC LIMIT 1", new { c = c.ClaimId }));
        // Timestamps are business time, not the machine's.
        Assert.Equal("2026-10-08T16:30:00Z", (await One<DateTime>("SELECT recorded_at FROM decisions WHERE id = @d", new { d = Guid.Parse(r.Str("decision.id")!) })).ToString("yyyy-MM-dd'T'HH:mm:ss'Z'", System.Globalization.CultureInfo.InvariantCulture));
    }

    [PostgresFact]
    public async Task AboveAuthorityTheDecisionIsRecordedAwaitingApprovalAndNothingIsPaidUntilATeamLeadApproves()
    {
        var c = await LifeScenario.InReviewAsync(fixture, "accident");   // $400,000 with the rider, and interest: above Rachel's $250,000
        var beforeOutbox = await One<int>("SELECT count(*) FROM outbox_events WHERE claim_id = @c", new { c = c.ClaimId });

        var r = await DecideAsync(c);

        Assert.Equal(202, r.StatusCode);
        Assert.Equal("awaiting_approval", r.Str("kind"));
        Assert.Equal("awaiting_approval", r.Str("decision.status"));
        Assert.Equal("above $250,000 authority, awaiting approval", r.Str("decision.authorityNote"));
        Assert.Equal("400767.12", SumOfRecordedAmounts(r));
        Assert.Empty(r.Json["paymentItems"]!.AsArray());
        var decisionId = Guid.Parse(r.Str("decision.id")!);
        Assert.NotNull(r.Str("approvalWorkItemId"));

        Assert.Equal("awaiting_approval", await One<string>("SELECT status FROM claims WHERE id = @c", new { c = c.ClaimId }));
        Assert.Equal(0, await One<int>("SELECT count(*) FROM payment_items WHERE claim_id = @c", new { c = c.ClaimId }));
        Assert.Equal(beforeOutbox, await One<int>("SELECT count(*) FROM outbox_events WHERE claim_id = @c", new { c = c.ClaimId }));   // no letters until approved
        Assert.Equal("open", await One<string>("SELECT state FROM deadlines WHERE claim_id = @c AND kind = 'decision_due'", new { c = c.ClaimId }));
        Assert.Equal("ready_to_decide", await One<string>("SELECT status FROM benefit_lines WHERE id = @l", new { l = c.BaseLineId }));
        // The team lead's work item, and the examiner's is done.
        Assert.Equal("Approve payout above authority|You|monica", await One<string>(
            "SELECT w.action || '|' || w.waiting_on || '|' || s.handle FROM work_items w JOIN staff_users s ON s.id = w.owner_id WHERE w.id = @w", new { w = Guid.Parse(r.Str("approvalWorkItemId")!) }));
        Assert.Equal("done", await One<string>("SELECT status FROM work_items WHERE dedupe_key = @k", new { k = "record-decision:" + c.ClaimId }));
        // A second decision on the claim while one waits is refused.
        Assert.Equal("claim_not_ready_to_decide", (await DecideAsync(c)).Str("code"));

        var client = fixture.CreateClient();
        var listed = await client.GetApiAsync($"/claims/{c.ClaimId}/decisions");
        Assert.Equal(["awaiting_approval", "awaiting_approval"], listed.Items.Select(d => d["status"]!.ToString()));

        // Only a team lead, and not one who is short of the amount, can approve.
        var byRachel = await client.PostApiAsync($"/decisions/{decisionId}:approve", null, new Dictionary<string, string> { ["X-Actor"] = "rachel" });
        Assert.Equal((403, "approver_not_authorized"), (byRachel.StatusCode, byRachel.Str("code")));
        var stranger = await client.PostApiAsync($"/decisions/{decisionId}:approve", null, new Dictionary<string, string> { ["X-Actor"] = "nobody" });
        Assert.Equal((403, "unknown_actor"), (stranger.StatusCode, stranger.Str("code")));
        Assert.Equal(400, (await client.PostApiAsync($"/decisions/{decisionId}:approve")).StatusCode);   // X-Actor is required
        Assert.Equal("awaiting_approval", await One<string>("SELECT status FROM claims WHERE id = @c", new { c = c.ClaimId }));

        fixture.Clock.Advance(TimeSpan.FromHours(1));   // the approval comes later the same day
        var approved = await client.PostApiAsync($"/decisions/{decisionId}:approve", "{\"note\":\"Checked the accident report\"}", new Dictionary<string, string> { ["X-Actor"] = "monica" });

        Assert.Equal(200, approved.StatusCode);
        Assert.Equal("recorded", approved.Str("kind"));
        Assert.Equal("in_effect", approved.Str("decision.status"));
        Assert.Equal("Monica Reyes", approved.Str("decision.approvedByName"));
        Assert.Equal("approved by Monica Reyes above $250,000 authority", approved.Str("decision.authorityNote"));
        // Base line and rider both pay: two lines times two payees, $400,767.12 in all.
        var items = approved.Json["paymentItems"]!.AsArray();
        Assert.Equal(4, items.Count);
        Assert.Equal(400_767.12m, items.Sum(i => decimal.Parse(i!["amount"]!["amount"]!.ToString(), System.Globalization.CultureInfo.InvariantCulture)));
        Assert.All(items, i => Assert.Equal("cleared", i!["status"]!.ToString()));
        Assert.Equal("approved", await One<string>("SELECT status FROM claims WHERE id = @c", new { c = c.ClaimId }));
        Assert.Equal("done", await One<string>("SELECT status FROM work_items WHERE id = @w", new { w = Guid.Parse(r.Str("approvalWorkItemId")!) }));
        Assert.Equal("decision_recorded", await One<string>("SELECT event_type FROM outbox_events WHERE claim_id = @c ORDER BY seq DESC LIMIT 1", new { c = c.ClaimId }));
        Assert.Equal(beforeOutbox + 1, await One<int>("SELECT count(*) FROM outbox_events WHERE claim_id = @c", new { c = c.ClaimId }));
        // Approved twice is a conflict, not a second set of payments.
        var again = await client.PostApiAsync($"/decisions/{decisionId}:approve", null, new Dictionary<string, string> { ["X-Actor"] = "monica" });
        Assert.Equal((409, "not_awaiting_approval"), (again.StatusCode, again.Str("code")));
        Assert.Equal(4, await One<int>("SELECT count(*) FROM payment_items WHERE claim_id = @c", new { c = c.ClaimId }));
    }

    private static string SumOfRecordedAmounts(ApiResponse r)
    {
        // The recorded amounts of the two decisions (base line + payable rider) add up to the figure the authority check used.
        var sum = r.Json["decision"]!["amount"]!["amount"]!.ToString();
        var rider = r.Json["relatedDecisions"]![0]!["amount"]!["amount"]!.ToString();
        return (decimal.Parse(sum, System.Globalization.CultureInfo.InvariantCulture) + decimal.Parse(rider, System.Globalization.CultureInfo.InvariantCulture)).ToString("F2", System.Globalization.CultureInfo.InvariantCulture);
    }

    [PostgresFact]
    public async Task TheDecisionListTotalsTheClaimWhileEachDecisionsAmountCoversOnlyItsOwnLine()
    {
        var client = fixture.CreateClient();

        // Base line and a payable rider (accidental death): two decisions of $200,383.56 each; the claim total is their sum, in effect or awaiting approval alike.
        var accident = await LifeScenario.InReviewAsync(fixture, "accident");
        var awaiting = await DecideAsync(accident);   // Rachel: above her authority, so both wait for a team lead
        Assert.Equal("awaiting_approval", awaiting.Str("kind"));
        var beforeApproval = await client.GetApiAsync($"/claims/{accident.ClaimId}/decisions");
        Assert.Equal(["200383.56", "200383.56"], beforeApproval.Items.Select(d => d["amount"]!["amount"]!.ToString()));   // each decision: its own line only
        Assert.Equal(("400767.12", "USD"), (beforeApproval.Str("claimTotal.amount"), beforeApproval.Str("claimTotal.currency")));
        Assert.Null(beforeApproval.At("nextCursor"));
        Assert.Equal(200, (await client.PostApiAsync($"/decisions/{awaiting.Str("decision.id")}:approve", null, new Dictionary<string, string> { ["X-Actor"] = "monica" })).StatusCode);
        var approved = await client.GetApiAsync($"/claims/{accident.ClaimId}/decisions");
        Assert.Equal(["in_effect", "in_effect"], approved.Items.Select(d => d["status"]!.ToString()));
        Assert.Equal("400767.12", approved.Str("claimTotal.amount"));

        // Natural causes: the rider is closed with no amount, so the total is the base line's alone; before anything was recorded (asOf) there is no total.
        var natural = await LifeScenario.InReviewAsync(fixture);
        Assert.Equal(201, (await DecideAsync(natural)).StatusCode);
        var list = await client.GetApiAsync($"/claims/{natural.ClaimId}/decisions");
        Assert.Equal(2, list.Items.Count());
        Assert.Equal("200383.56", list.Str("claimTotal.amount"));
        var earlier = await client.GetApiAsync($"/claims/{natural.ClaimId}/decisions?asOf=2026-10-08T16:29:59Z");
        Assert.Empty(earlier.Items);
        Assert.Null(earlier.At("claimTotal"));
        Assert.Contains("\"claimTotal\"", earlier.Body, StringComparison.Ordinal);   // present (null), not missing
    }

    [PostgresFact]
    public async Task AFailureLateInTheTransactionRollsEverythingBackAndTheSameKeyCanBeRetried()
    {
        var c = await LifeScenario.InReviewAsync(fixture);
        // The last thing the transaction writes is the outbox event. Make that fail, as a real fault would.
        await Sql.ExecuteAsync("""
            CREATE FUNCTION test_fail_decision_event() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'injected failure'; END $$;
            CREATE TRIGGER test_fail_decision_event BEFORE INSERT ON outbox_events FOR EACH ROW WHEN (NEW.event_type = 'decision_recorded') EXECUTE FUNCTION test_fail_decision_event();
            """);
        var key = "atomic-" + Guid.NewGuid();
        try
        {
            var failed = await DecideAsync(c, key: key);
            Assert.Equal(500, failed.StatusCode);
        }
        finally
        {
            await Sql.ExecuteAsync("DROP TRIGGER test_fail_decision_event ON outbox_events; DROP FUNCTION test_fail_decision_event();");
        }

        // Nothing at all survived: not the decisions, not the items, not the deadline changes, not the work item change, not the history, not the key.
        Assert.Equal("in_review", await One<string>("SELECT status FROM claims WHERE id = @c", new { c = c.ClaimId }));
        Assert.Equal(0, await One<int>("SELECT count(*) FROM decisions WHERE claim_id = @c", new { c = c.ClaimId }));
        Assert.Equal(0, await One<int>("SELECT count(*) FROM payment_items WHERE claim_id = @c", new { c = c.ClaimId }));
        Assert.Equal("ready_to_decide", await One<string>("SELECT status FROM benefit_lines WHERE id = @l", new { l = c.BaseLineId }));
        Assert.Equal(0, await One<int>("SELECT count(*) FROM deadlines WHERE claim_id = @c AND kind = 'payment_due'", new { c = c.ClaimId }));
        Assert.Equal(2, await One<int>("SELECT count(*) FROM deadlines WHERE claim_id = @c AND kind IN ('decision_due', 'review_target') AND state = 'open'", new { c = c.ClaimId }));
        Assert.Equal("open", await One<string>("SELECT status FROM work_items WHERE dedupe_key = @k", new { k = "record-decision:" + c.ClaimId }));
        Assert.Equal(0, await One<int>("SELECT count(*) FROM history_events WHERE claim_id = @c AND type IN ('decision', 'payment')", new { c = c.ClaimId }));
        Assert.Equal(0, await One<int>("SELECT count(*) FROM idempotency_keys WHERE key = @k", new { k = key }));

        // The same key works once the fault is gone: the failed attempt left no trace to conflict with.
        Assert.Equal(201, (await DecideAsync(c, key: key)).StatusCode);
    }

    [PostgresFact]
    public async Task ARepeatWithTheSameKeyReturnsTheSameDecisionAndADifferentBodyIsAConflict()
    {
        var c = await LifeScenario.InReviewAsync(fixture);
        var key = "idem-" + Guid.NewGuid();

        var first = await DecideAsync(c, key: key);
        var repeat = await DecideAsync(c, key: key);

        Assert.Equal((201, 200), (first.StatusCode, repeat.StatusCode));
        Assert.Equal("true", repeat.Header("Idempotent-Replayed"));
        Assert.Equal(first.Str("decision.id"), repeat.Str("decision.id"));
        Assert.Equal(2, repeat.Json["paymentItems"]!.AsArray().Count);
        Assert.Equal(1, await One<int>("SELECT count(*) FROM decisions WHERE claim_id = @c AND outcome = 'approved'", new { c = c.ClaimId }));
        Assert.Equal(2, await One<int>("SELECT count(*) FROM payment_items WHERE claim_id = @c", new { c = c.ClaimId }));
        var other = await DecideAsync(c, key: key, body: LifeScenario.ApproveJson(c.BaseLineId, "A different basis"));
        Assert.Equal((409, "idempotency_key_reuse"), (other.StatusCode, other.Str("code")));
        // A new key on a claim that is already decided is refused as not ready, never a second decision.
        var second = await DecideAsync(c);
        Assert.Equal((409, "claim_not_ready_to_decide"), (second.StatusCode, second.Str("code")));
    }

    [PostgresFact]
    public async Task DecisionsAndTheirApprovalsCanNeverBeChangedOrDeleted()
    {
        var c = await LifeScenario.InReviewAsync(fixture, "accident");
        var r = await DecideAsync(c);
        var id = Guid.Parse(r.Str("decision.id")!);
        await fixture.CreateClient().PostApiAsync($"/decisions/{id}:approve", null, new Dictionary<string, string> { ["X-Actor"] = "monica" });

        foreach (var sql in new[]
                 {
                     "UPDATE decisions SET basis = 'edited' WHERE id = @id",
                     "UPDATE decisions SET outcome = 'denied', outcome_text = 'Denied' WHERE id = @id",
                     "DELETE FROM decisions WHERE id = @id",
                     "UPDATE decision_approvals SET note = 'edited' WHERE decision_id = @id",
                     "DELETE FROM decision_approvals WHERE decision_id = @id",
                 })
        {
            var e = await Assert.ThrowsAsync<PostgresException>(() => Sql.ExecuteAsync(sql, new { id }));
            Assert.Contains("append-only", e.Message, StringComparison.Ordinal);
        }
        Assert.Equal("approved", await One<string>("SELECT outcome FROM decisions WHERE id = @id", new { id }));
        // "Create the items for this decision" cannot pay twice: the same decision, line and payee already has its item.
        var line = c.BaseLineId;
        var payee = await One<Guid>("SELECT payee_party_id FROM payment_items WHERE decision_id = @id AND benefit_line_id = @l LIMIT 1", new { id, l = line });
        var dup = await Assert.ThrowsAsync<PostgresException>(() => Sql.ExecuteAsync("""
            INSERT INTO payment_items (claim_id, benefit_line_id, decision_id, payee_party_id, basis, principal_amount, interest_amount, method, pay_on, status)
            VALUES (@c, @l, @id, @p, 'again', 1, 0, 'eft', current_date, 'cleared')
            """, new { c = c.ClaimId, l = line, id, p = payee }));
        Assert.Contains("payment_items_once", dup.Message, StringComparison.Ordinal);
    }

    [PostgresFact]
    public async Task TheRequestIsCheckedBeforeAnythingIsWritten()
    {
        var ready = await LifeScenario.InReviewAsync(fixture);
        var client = fixture.CreateClient();
        string Url(ReadyClaim c) => $"/claims/{c.ClaimId}/decisions";

        // Who is asking.
        var noActor = await client.PostApiAsync(Url(ready), LifeScenario.ApproveJson(ready.BaseLineId), new Dictionary<string, string> { ["Idempotency-Key"] = "key-" + Guid.NewGuid() });
        Assert.Equal((400, "missing_header"), (noActor.StatusCode, noActor.Str("code")));
        var noKey = await client.PostApiAsync(Url(ready), LifeScenario.ApproveJson(ready.BaseLineId), new Dictionary<string, string> { ["X-Actor"] = "rachel" });
        Assert.Equal((400, "missing_header"), (noKey.StatusCode, noKey.Str("code")));
        var unknown = await DecideAsync(ready, "somebody.else");
        Assert.Equal((403, "unknown_actor"), (unknown.StatusCode, unknown.Str("code")));
        // What is asked.
        var deny = await DecideAsync(ready, body: System.Text.Json.JsonSerializer.Serialize(new { benefitLineId = ready.BaseLineId, outcome = "deny", basis = "x" }));
        Assert.Equal((422, "outcome_not_supported"), (deny.StatusCode, deny.Str("code")));
        var part = await DecideAsync(ready, body: System.Text.Json.JsonSerializer.Serialize(new { benefitLineId = ready.BaseLineId, outcome = "approve_in_part", basis = "x" }));
        Assert.Equal("outcome_not_supported", part.Str("code"));
        var correction = await DecideAsync(ready, body: System.Text.Json.JsonSerializer.Serialize(new { benefitLineId = ready.BaseLineId, outcome = "approve", basis = "x", supersedesId = Guid.NewGuid() }));
        Assert.Equal("correction_not_supported", correction.Str("code"));
        var blank = await DecideAsync(ready, body: System.Text.Json.JsonSerializer.Serialize(new { benefitLineId = ready.BaseLineId, outcome = "approve", basis = " " }));
        Assert.Equal((422, "validation_failed"), (blank.StatusCode, blank.Str("code")));
        Assert.Equal("basis", blank.Str("errors[0].field"));
        var rider = await DecideAsync(ready, line: ready.RiderLineId);
        Assert.Equal((422, "rider_follows_base"), (rider.StatusCode, rider.Str("code")));
        var noLine = await DecideAsync(ready, line: Guid.NewGuid());
        Assert.Equal(404, noLine.StatusCode);
        var noClaim = await client.PostApiAsync($"/claims/{Guid.NewGuid()}/decisions", LifeScenario.ApproveJson(ready.BaseLineId), LifeScenario.Headers("rachel"));
        Assert.Equal(404, noClaim.StatusCode);
        // Where the claim is: a claim that has not completed proof of loss cannot be decided.
        var early = (await fixture.Get<Claims.Intake.LifeIntakeService>().SubmitAsync(TestData.Castellano("natural", TestData.NewPolicy(), "Someone Else", false), "early-" + Guid.NewGuid(), Actor.User("t"))).Claim;
        var line = early.BenefitLines.First(l => l.Kind == "base").Id;
        var tooEarly = await client.PostApiAsync(Url(new ReadyClaim(early.Id, early.ClaimNumber, line, null)), LifeScenario.ApproveJson(line), LifeScenario.Headers("rachel"));
        Assert.Equal((409, "claim_not_ready_to_decide"), (tooEarly.StatusCode, tooEarly.Str("code")));
        // None of that wrote anything.
        Assert.Equal(0, await One<int>("SELECT count(*) FROM decisions WHERE claim_id = @c", new { c = ready.ClaimId }));
        Assert.Equal("in_review", await One<string>("SELECT status FROM claims WHERE id = @c", new { c = ready.ClaimId }));
        var badBody = await client.PostApiAsync(Url(ready), "{not json", LifeScenario.Headers("rachel"));
        Assert.Equal(400, badBody.StatusCode);
    }

    [PostgresFact]
    public async Task TheOutboxRelayStartsTheEventWorkflowForADecisionWithTheDecisionIdInItsName()
    {
        fixture.Launcher.Reset();
        var (c, result) = await LifeScenario.ApprovedAsync(fixture);
        var decisionId = Guid.Parse(result.Decision.Id.ToString());

        await fixture.Get<OutboxRelay>().PublishPendingAsync();

        var start = Assert.Single(fixture.Launcher.StartedEvents, e => e.ClaimId == c.ClaimId);
        Assert.Equal("decision_recorded", start.EventType);
        Assert.Contains(decisionId.ToString(), start.PayloadJson, StringComparison.Ordinal);
        Assert.Equal("event-" + decisionId, await One<string>("SELECT workflow_id FROM outbox_events WHERE id = @e", new { e = start.EventId }));
        Assert.NotNull(await One<DateTime?>("SELECT published_at FROM outbox_events WHERE id = @e", new { e = start.EventId }));
    }

    [PostgresFact]
    public async Task ACompletedWorkItemIsRefusedTheSecondTimeAndTheWelcomeCallMeetsFirstContact()
    {
        var c = await LifeScenario.InReviewAsync(fixture);
        var client = fixture.CreateClient();
        // The welcome-call item is written by the intake workflow's last step; write it as that step does.
        await Sql.ExecuteAsync("""
            INSERT INTO work_items (dedupe_key, owner_id, claim_id, priority, action, why, due_on, section, source_kind)
            VALUES (@k, (SELECT id FROM staff_users WHERE handle = 'rachel'), @c, 2, 'New life claim: welcome call to Diane', 'Phone intake', current_date, 'workflow', 'workflow')
            """, new { k = "welcome-call:" + c.ClaimId, c = c.ClaimId });
        var owner = await One<Guid>("SELECT id FROM staff_users WHERE handle = 'rachel'");
        var queue = await client.GetApiAsync($"/work-items?owner={owner}&status=open");
        var item = queue.Items.First(i => i["claimId"]!.ToString() == c.ClaimId.ToString() && i["action"]!.ToString().StartsWith("New life claim", StringComparison.Ordinal));
        var id = item["id"]!.ToString();

        Assert.Equal(428, (await client.PostApiAsync($"/work-items/{id}:complete")).StatusCode);
        var stale = await client.PostApiAsync($"/work-items/{id}:complete", null, new Dictionary<string, string> { ["If-Match"] = "\"99\"" });
        Assert.Equal((412, "version_conflict"), (stale.StatusCode, stale.Str("code")));
        var done = await client.PostApiAsync($"/work-items/{id}:complete", null, new Dictionary<string, string> { ["If-Match"] = $"\"{item["version"]}\"", ["X-Actor"] = "rachel" });
        Assert.Equal(200, done.StatusCode);
        Assert.Equal("done", done.Str("status"));
        Assert.Equal($"\"{(long)item["version"]! + 1}\"", done.Header("ETag"));
        var again = await client.PostApiAsync($"/work-items/{id}:complete", null, new Dictionary<string, string> { ["If-Match"] = done.Header("ETag")! });
        Assert.Equal((409, "invalid_state"), (again.StatusCode, again.Str("code")));
        Assert.Equal(404, (await client.PostApiAsync($"/work-items/{Guid.NewGuid()}:complete", null, new Dictionary<string, string> { ["If-Match"] = "\"0\"" })).StatusCode);
        // The first-contact row closed without firing, as the mock's "call logged, D-703 closed".
        Assert.Equal("done:user", await One<string>("SELECT state || ':' || closed_by FROM deadlines WHERE claim_id = @c AND kind = 'first_contact_by'", new { c = c.ClaimId }));
    }

    [PostgresFact]
    public async Task TheStaffListSaysWhoCanApproveHowMuch()
    {
        var staff = await fixture.CreateClient().GetApiAsync("/staff");

        Assert.Equal(200, staff.StatusCode);
        var rachel = staff.Items.Single(s => s["handle"]!.ToString() == "rachel");
        var monica = staff.Items.Single(s => s["handle"]!.ToString() == "monica");
        Assert.Equal(("Rachel Kim", "life_examiner", "250000.00"), (rachel["name"]!.ToString(), rachel["role"]!.ToString(), rachel["payoutLimit"]!["amount"]!.ToString()));
        Assert.Equal(("Monica Reyes", "team_lead", "1000000.00"), (monica["name"]!.ToString(), monica["role"]!.ToString(), monica["payoutLimit"]!["amount"]!.ToString()));
        Assert.Matches("^[0-9a-f-]{36}$", rachel["id"]!.ToString());
        var leads = await fixture.CreateClient().GetApiAsync("/staff?role=team_lead");
        Assert.Equal(["monica"], leads.Items.Select(s => s["handle"]!.ToString()));
        Assert.Equal(400, (await fixture.CreateClient().GetApiAsync("/staff?role=boss")).StatusCode);
    }

    [PostgresFact]
    public async Task DecisionsCanBeReadOneByOneAndAsOfAnInstant()
    {
        var c = await LifeScenario.InReviewAsync(fixture);
        var recorded = await DecideAsync(c);   // recorded at the frozen clock: 2026-10-08T16:30:00Z
        var client = fixture.CreateClient();
        var id = recorded.Str("decision.id");

        var one = await client.GetApiAsync($"/decisions/{id}");
        Assert.Equal((200, "approved", 1), (one.StatusCode, one.Str("outcome"), one.At("version")!.GetValue<int>()));
        Assert.Equal(404, (await client.GetApiAsync($"/decisions/{Guid.NewGuid()}")).StatusCode);

        var all = await client.GetApiAsync($"/claims/{c.ClaimId}/decisions");
        Assert.Equal(2, all.Items.Count());   // the base line's, and the rider's closed decision
        Assert.Empty((await client.GetApiAsync($"/claims/{c.ClaimId}/decisions?asOf=2026-10-08T16:29:59Z")).Items);
        Assert.Equal(2, (await client.GetApiAsync($"/claims/{c.ClaimId}/decisions?asOf=2026-10-08T16:30:00Z")).Items.Count());
        Assert.Equal(400, (await client.GetApiAsync($"/claims/{c.ClaimId}/decisions?asOf=yesterday")).StatusCode);
        Assert.Equal(404, (await client.GetApiAsync($"/claims/{Guid.NewGuid()}/decisions")).StatusCode);
    }
}
