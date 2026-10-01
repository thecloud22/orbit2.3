using System.Globalization;
using System.Text.Json;
using Claims.Common;
using Claims.Config;
using Claims.Deadline;
using Claims.Outbox;
using Claims.Temporal;
using Claims.Tests.Support;
using Microsoft.Extensions.DependencyInjection;
using Temporalio.Client;
using Temporalio.Exceptions;
using Temporalio.Testing;
using Temporalio.Worker;

namespace Claims.Tests.Postgres;

/// <summary>
/// THE COMPLEX END-TO-END TEST: "things bounce back", played on the real stack. Real Postgres, the real services and SQL, the real Temporal workflows, activities, interceptor and
/// launcher on Temporal's in-process (time-skipping) test server, the outbox relay, the HTTP pipeline. It drives ONLY public HTTP calls, the virtual clock (a hand-set business clock at the mock's
/// own dates) and the fault switches (`POST /dev/faults`): no scripted "play next". Each bounce is real:
///
///   1  Fri 25 Sep   the worker stalls in the middle of intake step 9 (fault worker.stall-once): Temporal times the attempt out and runs it again; no letter goes twice
///   2  Tue 29 Sep   Diane's W-9 fails the IRS check (fault tin.no-match): an answer, not an error; a correction is asked for; the corrected W-9 (Fri 2 Oct) is another event, another workflow
///   3  Thu 1 Oct    a photocopied certificate goes to Rachel; she rejects it while the letters service is down (fault letters.down): the letter workflow FAILS after 5 attempts, an ops task
///                   opens, and ops re-runs it as run 2 under the same workflow id; the letter goes exactly once
///   4  Mon 5 Oct    Mark is late: the dispatcher fires his follow-up (the only row that fires)
///   5  Tue 13 Oct   the payment run pays and closes the claim; Thu 15 Oct the bank returns Mark's EFT (R02): the returns batch marks the item returned, a workflow reopens the claim; Mon 19 Oct
///                   Mark gives a new account: a replacement item, paid Tue 20 Oct, and the claim closes a second time
///
/// Expected (the docs page prints the same): 14 workflow runs (13 completed, 1 failed then run 2), 16 deadline rows (1 fired, 1 skipped, 14 closed without firing), 2 closes, $460.27 of
/// interest for 24 days (Diane $100,230.13, Mark $100,230.14), $200,460.27 paid in the end.
/// </summary>
public class ComplexLifeScenarioPostgresTests(ComplexLifeScenarioPostgresTests.Fixture fixture) : IClassFixture<ComplexLifeScenarioPostgresTests.Fixture>
{
    private static DateTimeOffset At(string iso) => DateTimeOffset.Parse(iso, CultureInfo.InvariantCulture);

    public sealed class Fixture : PostgresApiFixture
    {
        private CancellationTokenSource? stop;
        private Task? workerTask;

        public WorkflowEnvironment Env { get; private set; } = null!;

        protected override string Hint => "complex";

        protected override DateTimeOffset? ClockStart => At("2026-09-25T15:03:00Z");

        protected override IReadOnlyDictionary<string, string?> Settings { get; } = new Dictionary<string, string?>
        {
            ["Claims:Db:DevSeed"] = "true",
            ["Claims:Dev:Controls"] = "true",   // /dev/faults and /dev/bank/returns
        };

        protected override async Task BeforeStartAsync() =>
            Env = await WorkflowEnvironment.StartTimeSkippingAsync(new WorkflowEnvironmentStartTimeSkippingOptions { DataConverter = TemporalSetup.DataConverterFor() });

        protected override void ConfigureServices(IServiceCollection services) =>
            services.AddSingleton<IWorkflowLauncher>(sp => new TemporalWorkflowLauncher(Env.Client, sp.GetRequiredService<ClaimsOptions>()));   // the production launcher

        protected override Task StartedAsync()
        {
            var worker = new TemporalWorker(Env.Client, TemporalWorkerService.WorkerOptions("claims", Get<LifeIntakeActivities>(), Get<RequirementFollowUpActivities>(), null,
                Get<DecisionRecordedActivities>(), Get<PaymentConfirmedActivities>(), Get<DocumentReceivedActivities>(), Get<DocumentRejectedActivities>(),
                Get<PaymentReturnedActivities>(), Get<PaymentMethodUpdatedActivities>(), Get<WorkerFaultInterceptor>()));   // the production worker options, interceptor included
            stop = new CancellationTokenSource();
            workerTask = worker.ExecuteAsync(stop.Token);
            return Task.CompletedTask;
        }

        public override async ValueTask DisposeAsync()
        {
            if (stop is not null)
            {
                await stop.CancelAsync();
                try { await workerTask!; } catch (OperationCanceledException) { }
            }
            await base.DisposeAsync();
            if (Env is not null) await Env.ShutdownAsync();
        }
    }

    private Db Sql => fixture.Db;
    private HttpClient Client => fixture.CreateClient();
    private OutboxRelay Relay => fixture.Get<OutboxRelay>();

    private Task<T> One<T>(string sql, object? param = null) => Sql.SingleAsync<T>(sql, param);

    private async Task<T> ResultAsync<T>(string workflowId) => await fixture.Env.Client.GetWorkflowHandle(workflowId).GetResultAsync<T>();

    private static Dictionary<string, string> Idem(string actor) => new() { ["Idempotency-Key"] = "e2e-" + Guid.NewGuid(), ["X-Actor"] = actor };

    private async Task FaultAsync(string body) => Assert.Equal(200, (await Client.PostApiAsync("/dev/faults", body)).StatusCode);

    /// <summary>Publishes the outbox (one event expected) and returns the workflow id it started.</summary>
    private async Task<string> PublishOneAsync(string eventType, string? payloadContains = null)
    {
        Assert.Equal(1, await Relay.PublishPendingAsync());
        return await One<string>("SELECT workflow_id FROM outbox_events WHERE event_type = @t AND (cast(@p as text) IS NULL OR payload::text LIKE '%' || @p || '%') ORDER BY seq DESC LIMIT 1",
            new { t = eventType, p = payloadContains });
    }

    private async Task<Guid> ReqAsync(Guid claim, string part) => await One<Guid>("SELECT id FROM requirements WHERE claim_id = @c AND name LIKE @n", new { c = claim, n = "%" + part + "%" });

    private async Task<Guid> PartyAsync(Guid claim, string first) =>
        await One<Guid>("SELECT p.id FROM claim_parties cp JOIN parties p ON p.id = cp.party_id WHERE cp.claim_id = @c AND cp.role = 'beneficiary' AND p.full_name LIKE @n", new { c = claim, n = first + "%" });

    private async Task<(Guid Id, string Workflow)> PostDocumentAsync(Guid claim, object body, string actor)
    {
        var r = await Client.PostApiAsync($"/claims/{claim}/documents", JsonSerializer.Serialize(body), Idem(actor));
        Assert.Equal(201, r.StatusCode);
        var id = Guid.Parse(r.Str("id")!);
        var wf = await PublishOneAsync("document_received", id.ToString());
        return (id, wf);
    }

    private async Task<string> StatusOfAsync(string sql, object p) => await One<string>(sql, p);

    [PostgresFact]
    public async Task ThingsBounceBackOnTheRealStack()
    {
        var client = Client;
        var clock = fixture.Clock;

        // ================= Bounce 1 · Fri 25 Sep 10:03 · a worker stalls in the middle of the intake run
        clock.Set(At("2026-09-25T15:03:00Z"));
        await FaultAsync("{\"name\":\"worker.stall-once:LifeIntake_SendAcknowledgementAndPackets\",\"count\":1}");
        var intake = await client.PostApiAsync("/claims/life-intake", Json.Serialize(TestData.Castellano("natural")), Idem("diane.intake"));
        Assert.Equal(201, intake.StatusCode);
        var claimId = Guid.Parse(intake.Str("id")!);
        var claimNumber = intake.Str("claimNumber")!;
        Assert.Equal(1, await Relay.PublishPendingAsync());
        Assert.Equal("set_up", (await ResultAsync<LifeIntakeWorkflow.Result>("orch-" + claimNumber + "-intake")).Outcome);   // it completed, late: Temporal ran the stalled step again
        Assert.Equal("gathering_evidence", (await client.GetApiAsync($"/claims/{claimId}")).Str("status"));

        var runs0 = (await client.GetApiAsync($"/claims/{claimId}/workflow-runs")).Items.ToList();
        var intakeRun = runs0.Single();
        Assert.Equal(("orchestration", "completed", 1), (intakeRun["type"]!.ToString(), intakeRun["status"]!.ToString(), intakeRun["runNo"]!.GetValue<int>()));
        var step9 = intakeRun["steps"]!.AsArray().Single(s => s!["label"]!.ToString() == "Send the acknowledgement and claim packets")!;
        Assert.Equal(("retried", 2), (step9["state"]!.ToString(), step9["attempts"]!.GetValue<int>()));   // the retried step is visible, with its attempt count
        Assert.Contains("idempotency keys", step9["detail"]!.ToString(), StringComparison.Ordinal);
        var note = intakeRun["note"]!.ToString();
        Assert.Contains("Fault worker.stall-once:LifeIntake_SendAcknowledgementAndPackets: attempt 1 did its work and then the worker stopped answering", note, StringComparison.Ordinal);
        Assert.Contains("\"Send the acknowledgement and claim packets\" ran 2 times", note, StringComparison.Ordinal);
        Assert.True(intakeRun["elapsedMs"]!.GetValue<int>() > 0);
        // No letter went twice: the first attempt sent the four letters, the second found them sent (same idempotency keys).
        Assert.Equal(["ACK-LIFE-01", "AGT-NOTE-01", "PKT-LIFE-02", "PKT-LIFE-02"], await Sql.ListAsync<string>("SELECT template_code FROM letters WHERE claim_id = @c ORDER BY template_code", new { c = claimId }));
        Assert.Empty((await client.GetApiAsync("/dev/faults")).Json["active"]!.AsArray());   // the stall was used up: exactly one execution stalled

        // ================= Mon 28 Sep 09:40 · Rachel's welcome call (a work item ticked off): first contact met
        clock.Set(At("2026-09-28T14:40:00Z"));
        var rachel = await One<Guid>("SELECT id FROM staff_users WHERE handle = 'rachel'");
        var welcome = (await client.GetApiAsync($"/work-items?owner={rachel}&status=open")).Items.Single(w => w["claimId"]!.ToString() == claimId.ToString() && w["action"]!.ToString().StartsWith("New life claim", StringComparison.Ordinal));
        Assert.Equal(200, (await client.PostApiAsync($"/work-items/{welcome["id"]}:complete", null, new Dictionary<string, string> { ["If-Match"] = $"\"{welcome["version"]}\"", ["X-Actor"] = "rachel" })).StatusCode);

        // ================= Bounce 2 · Tue 29 Sep 14:10 · Diane's W-9 fails the IRS check: an answer, not an error
        clock.Set(At("2026-09-29T19:10:00Z"));
        var diane = await PartyAsync(claimId, "Diane");
        var mark = await PartyAsync(claimId, "Mark");
        var dianeReq = await ReqAsync(claimId, "Diane");
        var dianeRow = await One<Guid>("SELECT id FROM deadlines WHERE requirement_id = @r AND state = 'open'", new { r = dianeReq });
        await FaultAsync("{\"name\":\"tin.no-match\",\"count\":1}");
        var (doc1, wf1) = await PostDocumentAsync(claimId, new { kind = "claimant_statement_w9", source = "portal", partyId = diane, attributes = new { tin = "123-45-6879" } }, "diane.portal");
        Assert.Equal("not_enough", (await ResultAsync<DocumentReceivedWorkflow.Result>(wf1)).Outcome);
        Assert.Equal(("not_enough", "TIN mismatch"), (await StatusOfAsync("SELECT status FROM documents WHERE id = @d", new { d = doc1 }), await One<string>("SELECT status_note FROM documents WHERE id = @d", new { d = doc1 })));
        Assert.Equal(("not_enough", "TIN mismatch"), (await StatusOfAsync("SELECT state FROM requirements WHERE id = @r", new { r = dianeReq }), await One<string>("SELECT state_note FROM requirements WHERE id = @r", new { r = dianeReq })));
        Assert.Equal("done", await One<string>("SELECT state FROM deadlines WHERE id = @d", new { d = dianeRow }));   // her follow-up row closed without firing
        var chase = await One<Guid>("SELECT id FROM deadlines WHERE requirement_id = @r AND state = 'open'", new { r = dianeReq });   // the 7-day correction chase (due Tue 6 Oct)
        Assert.Equal("2026-10-06", await One<string>("SELECT to_char(due_at AT TIME ZONE 'America/Chicago', 'YYYY-MM-DD') FROM deadlines WHERE id = @d", new { d = chase }));
        var run2 = (await client.GetApiAsync($"/claims/{claimId}/workflow-runs")).Items.Single(r => r["workflowId"]!.ToString() == wf1);
        Assert.Equal("completed", run2["status"]!.ToString());
        Assert.Contains("answer, not an error", run2["note"]!.ToString(), StringComparison.Ordinal);
        Assert.DoesNotContain(run2["steps"]!.AsArray(), s => s!["attempts"]!.GetValue<int>() > 1);   // no retry: one check

        // ================= Bounce 3 · Thu 1 Oct 11:25 · a photocopied certificate goes to Rachel
        clock.Set(At("2026-10-01T16:25:00Z"));
        var certReq = await ReqAsync(claimId, "Certified death");
        var (doc2, wf2) = await PostDocumentAsync(claimId, new { kind = "death_certificate", source = "mail_room", attributes = new { photocopy = true, sealPresent = false } }, "mailroom");
        Assert.Equal("needs_review", (await ResultAsync<DocumentReceivedWorkflow.Result>(wf2)).Outcome);
        Assert.Equal(("under_review", "received"), (await StatusOfAsync("SELECT status FROM documents WHERE id = @d", new { d = doc2 }), await One<string>("SELECT state FROM requirements WHERE id = @r", new { r = certReq })));
        var reviewRow = await One<Guid>("SELECT id FROM deadlines WHERE claim_id = @c AND kind = 'document_review_by' AND state = 'open'", new { c = claimId });
        Assert.Equal("2026-10-02", await One<string>("SELECT to_char(due_at AT TIME ZONE 'America/Chicago', 'YYYY-MM-DD') FROM deadlines WHERE id = @d", new { d = reviewRow }));
        var certRow = await One<Guid>("SELECT id FROM deadlines WHERE requirement_id = @r AND state = 'open'", new { r = certReq });   // D-705 waits until the photocopy is rejected
        Assert.Equal(1, await One<int>("SELECT count(*) FROM work_items WHERE claim_id = @c AND action = 'Review the death certificate' AND owner_id = @o AND status = 'open'", new { c = claimId, o = rachel }));

        // ---- Thu 1 Oct 15:20 · Rachel rejects it, and the letters service is down: the letter workflow fails after 5 attempts
        clock.Set(At("2026-10-01T20:20:00Z"));
        await FaultAsync("{\"name\":\"letters.down\",\"enabled\":true}");
        var docVersion = (await client.GetApiAsync("/documents/" + doc2)).Header("ETag")!;
        var reject = await client.PostApiAsync($"/documents/{doc2}:review", "{\"decision\":\"reject\",\"reason\":\"Photocopy: no raised seal\"}", new Dictionary<string, string> { ["X-Actor"] = "rachel", ["If-Match"] = docVersion });
        Assert.Equal(200, reject.StatusCode);
        // Her decision is saved before any workflow: requirement requested again, D-705 and the review row closed, the new follow-up row written (Sun 11 Oct).
        Assert.Equal("requested", await One<string>("SELECT state FROM requirements WHERE id = @r", new { r = certReq }));
        Assert.Equal(("done", "done"), (await StatusOfAsync("SELECT state FROM deadlines WHERE id = @d", new { d = certRow }), await One<string>("SELECT state FROM deadlines WHERE id = @d", new { d = reviewRow })));
        Assert.Equal("2026-10-11", await One<string>("SELECT to_char(due_at AT TIME ZONE 'America/Chicago', 'YYYY-MM-DD') FROM deadlines WHERE requirement_id = @r AND state = 'open'", new { r = certReq }));
        var wf3 = await PublishOneAsync("document_rejected", doc2.ToString());
        var failure = await Assert.ThrowsAsync<WorkflowFailedException>(() => ResultAsync<DocumentRejectedWorkflow.Result>(wf3));
        Assert.IsType<ActivityFailureException>(failure.InnerException);
        var failedRun = (await client.GetApiAsync($"/claims/{claimId}/workflow-runs")).Items.Single(r => r["workflowId"]!.ToString() == wf3);
        Assert.Equal(("failed", 1, true), (failedRun["status"]!.ToString(), failedRun["runNo"]!.GetValue<int>(), failedRun["canRerun"]!.GetValue<bool>()));   // the run stays visible, and says it can be re-run
        var sendStep = failedRun["steps"]!.AsArray().Single(s => s!["label"]!.ToString() == "Send it")!;
        Assert.Equal(("failed", 5), (sendStep["state"]!.ToString(), sendStep["attempts"]!.GetValue<int>()));
        Assert.Contains("5 attempts, waiting 2, 4, 8 and 16 s", sendStep["detail"]!.ToString(), StringComparison.Ordinal);
        Assert.Contains("fault letters.down", failedRun["error"]!.ToString(), StringComparison.Ordinal);
        Assert.Contains("stopped as the retry policy says", failedRun["note"]!.ToString(), StringComparison.Ordinal);
        Assert.Equal(1, await One<int>("SELECT count(*) FROM work_items WHERE dedupe_key = 'workflow-failed:' || @w AND status = 'open' AND owner_id IS NULL", new { w = wf3 }));   // the last step opened an ops task
        Assert.Equal("queued", await One<string>("SELECT status FROM letters WHERE dedupe_key = 'document:' || @d || ':rejected'", new { d = doc2.ToString() }));   // never sent

        // ---- Thu 1 Oct 16:05 · the letters service is back; ops re-runs it under the SAME workflow id: run 2
        clock.Set(At("2026-10-01T21:05:00Z"));
        await FaultAsync("{\"name\":\"letters.down\",\"enabled\":false}");
        var rerun = await client.PostApiAsync($"/workflow-runs/{failedRun["id"]}:rerun", null, new Dictionary<string, string> { ["X-Actor"] = "ops.on-call" });
        Assert.Equal((202, wf3, "started"), (rerun.StatusCode, rerun.Str("workflowId"), rerun.Str("outcome")));
        Assert.Equal("letter_sent", (await ResultAsync<DocumentRejectedWorkflow.Result>(wf3)).Outcome);
        var again = await client.PostApiAsync($"/workflow-runs/{failedRun["id"]}:rerun", null, new Dictionary<string, string> { ["X-Actor"] = "ops.on-call" });
        Assert.Equal((409, "run_not_latest"), (again.StatusCode, again.Str("code")));   // run 1 is not the latest any more
        var both = (await client.GetApiAsync($"/claims/{claimId}/workflow-runs")).Items.Where(r => r["workflowId"]!.ToString() == wf3).ToList();
        Assert.Equal([("failed", 1), ("completed", 2)], both.Select(r => (r["status"]!.ToString(), r["runNo"]!.GetValue<int>())));
        Assert.Equal(failedRun["id"]!.ToString(), both[1]["rerunOfId"]!.ToString());
        Assert.Contains("ALLOW_DUPLICATE_FAILED_ONLY", both[1]["note"]!.ToString(), StringComparison.Ordinal);
        Assert.Equal("done", await One<string>("SELECT status FROM work_items WHERE dedupe_key = 'workflow-failed:' || @w", new { w = wf3 }));   // the ops task closed
        Assert.Equal(("sent", 1), (await StatusOfAsync("SELECT status FROM letters WHERE dedupe_key = 'document:' || @d || ':rejected'", new { d = doc2.ToString() }),
            await One<int>("SELECT count(*) FROM letters WHERE claim_id = @c AND template_code = 'REQ-LIFE-03'", new { c = claimId })));   // Diane got one letter

        // ---- Fri 2 Oct 18:05 · the corrected W-9 is another document, another event, another workflow
        clock.Set(At("2026-10-02T23:05:00Z"));
        var (doc3, wf4) = await PostDocumentAsync(claimId, new { kind = "claimant_statement_w9", source = "portal", partyId = diane, attributes = new { tin = "123-45-6789" } }, "diane.portal");
        Assert.NotEqual(wf1, wf4);
        Assert.Equal("accepted", (await ResultAsync<DocumentReceivedWorkflow.Result>(wf4)).Outcome);
        Assert.Equal(("accepted", "done"), (await StatusOfAsync("SELECT state FROM requirements WHERE id = @r", new { r = dianeReq }), await One<string>("SELECT state FROM deadlines WHERE id = @d", new { d = chase })));

        // ================= Bounce 4 · Mon 5 Oct 08:00 · Mark is late: the dispatcher fires his follow-up (the only row that fires)
        clock.Set(At("2026-10-05T13:00:01Z"));
        var markReq = await ReqAsync(claimId, "Mark");
        var markRow = await One<Guid>("SELECT id FROM deadlines WHERE requirement_id = @r AND state = 'open'", new { r = markReq });
        Assert.Equal(1, (await fixture.Get<DeadlineDispatcher>().DispatchDueAsync()).Started);
        Assert.Equal("reminded", (await ResultAsync<RequirementFollowUpActivities.Result>("deadline-" + markRow)).Outcome);

        // ---- Wed 7 Oct 19:40 · Mark signs: accepted; his second follow-up row closes without firing
        clock.Set(At("2026-10-08T00:40:00Z"));
        var (_, wf5) = await PostDocumentAsync(claimId, new { kind = "claimant_statement_w9", source = "portal", partyId = mark, attributes = new { tin = "987-65-4321" } }, "mark.portal");
        Assert.Equal("accepted", (await ResultAsync<DocumentReceivedWorkflow.Result>(wf5)).Outcome);

        // ---- Fri 9 Oct 12:10 · the certified copy arrives: accepted, and that completes proof of loss
        clock.Set(At("2026-10-09T17:10:00Z"));
        var (_, wf6) = await PostDocumentAsync(claimId, new { kind = "death_certificate", source = "mail_room", attributes = new { photocopy = false, sealPresent = true } }, "mailroom");
        Assert.Equal("accepted", (await ResultAsync<DocumentReceivedWorkflow.Result>(wf6)).Outcome);
        Assert.Equal("in_review", (await client.GetApiAsync($"/claims/{claimId}")).Str("status"));
        Assert.Equal(["2026-10-16", "2026-11-08"], await Sql.ListAsync<string>(   // review_target (5 business days), decision_due (30 days), from Fri 9 Oct
            "SELECT to_char(due_at AT TIME ZONE 'America/Chicago', 'YYYY-MM-DD') FROM deadlines WHERE claim_id = @c AND kind IN ('decision_due', 'review_target') ORDER BY kind DESC", new { c = claimId }));

        // ================= Mon 12 Oct 11:30 · the decision; Tue 13 Oct 02:00 · the payment run pays and closes the claim (close 1)
        clock.Set(At("2026-10-12T16:30:00Z"));
        var line = Guid.Parse((await client.GetApiAsync($"/claims/{claimId}")).Json["benefitLines"]!.AsArray().Single(l => l!["kind"]!.ToString() == "base")!["id"]!.ToString());
        var decided = await client.PostApiAsync($"/claims/{claimId}/decisions", LifeScenario.ApproveJson(line), LifeScenario.Headers("rachel"));
        Assert.Equal(201, decided.StatusCode);
        Assert.Equal("letters_sent", (await ResultAsync<DecisionRecordedWorkflow.Result>(await PublishOneAsync("decision_recorded"))).Outcome);
        clock.Set(At("2026-10-13T07:00:00Z"));
        var run1 = await client.PostApiAsync("/payment-runs", "{\"runDate\":\"2026-10-13\"}");
        Assert.Equal(("reconciled", 2, "200460.27"), (run1.Str("status"), run1.At("paidCount")!.GetValue<int>(), run1.Str("total.amount")));   // 24 days of interest: $460.27
        Assert.Equal("closed", (await client.GetApiAsync($"/claims/{claimId}")).Str("status"));
        Assert.Equal("confirmed_and_closed", (await ResultAsync<PaymentConfirmedWorkflow.Result>(await PublishOneAsync("items_paid"))).Outcome);
        var markItem = Guid.Parse((await client.GetApiAsync($"/claims/{claimId}/payment-items")).Items.Single(i => i["payeeName"]!.ToString().StartsWith("Mark", StringComparison.Ordinal))["id"]!.ToString());
        Assert.Equal(("100230.13", "100230.14"), (await One<string>("SELECT amount::text FROM payment_items WHERE claim_id = @c AND payee_party_id = @p", new { c = claimId, p = diane }),
            await One<string>("SELECT amount::text FROM payment_items WHERE id = @i", new { i = markItem })));

        // ================= Bounce 5 · Thu 15 Oct 06:30 · the bank returns Mark's EFT (R02): the returns batch, then a workflow reopens the claim
        clock.Set(At("2026-10-15T11:30:00Z"));
        var queued = await client.PostApiAsync("/dev/bank/returns", $"{{\"paymentItemId\":\"{markItem}\",\"reasonCode\":\"R02\",\"reasonText\":\"Account closed\"}}");
        Assert.Equal(201, queued.StatusCode);
        var batch = await client.PostApiAsync("/payment-runs/returns:process");
        Assert.Equal(200, batch.StatusCode);
        Assert.Equal((1, 1, "100230.14"), (batch.At("read")!.GetValue<int>(), batch.Json["processed"]!.AsArray().Count, batch.Str("processed[0].amount.amount")));
        Assert.Equal("closed", (await client.GetApiAsync($"/claims/{claimId}")).Str("status"));   // the batch changed the item and wrote an event; it did not touch the claim
        clock.Set(At("2026-10-15T13:10:00Z"));   // 08:10: the workflow follows
        var wf7 = await PublishOneAsync("payment_returned");
        Assert.Equal("reopened", (await ResultAsync<PaymentReturnedWorkflow.Result>(wf7)).Outcome);
        var reopened = await client.GetApiAsync($"/claims/{claimId}");
        Assert.Equal("reopened", reopened.Str("status"));
        Assert.Null(reopened.At("closedAt")?.GetValue<string>());
        Assert.Equal("2026-10-25", await One<string>("SELECT to_char(due_at AT TIME ZONE 'America/Chicago', 'YYYY-MM-DD') FROM deadlines WHERE claim_id = @c AND kind = 'bank_details_by'", new { c = claimId }));   // 10 days: Sun 25 Oct, the mock's D-715
        Assert.Equal(1, await One<int>("SELECT count(*) FROM work_items WHERE dedupe_key = 'payment-returned:' || @i AND owner_id = @o AND status = 'open'", new { i = markItem.ToString(), o = rachel }));

        // ---- Mon 19 Oct 20:15 · Mark gives a new account: the replacement item (same amount), verified by a short workflow
        clock.Set(At("2026-10-20T01:15:00Z"));
        var updated = await client.PostApiAsync($"/claims/{claimId}/payees/{mark}:update-payment-method", "{\"kind\":\"eft\",\"routingNumber\":\"021000021\",\"accountNumber\":\"000123441\"}", Idem("mark.portal"));
        Assert.Equal(201, updated.StatusCode);
        var replacement = updated.Json["replacementItems"]![0]!;
        Assert.Equal(("cleared", "100230.14", "2026-10-20", markItem.ToString()), (replacement["status"]!.ToString(), replacement["amount"]!["amount"]!.ToString(), replacement["payOn"]!.ToString(), replacement["replacementOfId"]!.ToString()));
        var wf8 = await PublishOneAsync("payment_method_updated");
        Assert.Equal("verified", (await ResultAsync<PaymentMethodUpdatedWorkflow.Result>(wf8)).Outcome);

        // ---- Tue 20 Oct 02:00 · the next payment run pays the replacement; the claim closes again (close 2)
        clock.Set(At("2026-10-20T07:00:00Z"));
        var run2b = await client.PostApiAsync("/payment-runs", "{\"runDate\":\"2026-10-20\"}");
        Assert.Equal(("reconciled", 1, "100230.14"), (run2b.Str("status"), run2b.At("paidCount")!.GetValue<int>(), run2b.Str("total.amount")));
        Assert.Equal("confirmed_and_closed", (await ResultAsync<PaymentConfirmedWorkflow.Result>(await PublishOneAsync("items_paid"))).Outcome);

        // ================= What is left in the database.
        var claim = await client.GetApiAsync($"/claims/{claimId}");
        Assert.Equal("closed", claim.Str("status"));
        Assert.Equal("2026-10-20T07:00:00Z", claim.Str("closedAt"));
        Assert.Equal(["paid", "closed"], claim.Json["benefitLines"]!.AsArray().OrderBy(l => l!["kind"]!.ToString()).Select(l => l!["status"]!.ToString()));

        // Money: Diane $100,230.13 and Mark's replacement $100,230.14 are paid, Mark's first payment is returned and kept: $200,460.27 in the end, $460.27 of it interest (24 days).
        var items = (await client.GetApiAsync($"/claims/{claimId}/payment-items")).Items.ToList();
        Assert.Equal([("Diane Castellano", "paid"), ("Mark Castellano", "returned"), ("Mark Castellano", "paid")], items.Select(i => (i["payeeName"]!.ToString(), i["status"]!.ToString())));
        Assert.Equal(200_460.27m, items.Where(i => i["status"]!.ToString() == "paid").Sum(i => decimal.Parse(i["amount"]!["amount"]!.ToString(), CultureInfo.InvariantCulture)));
        Assert.Equal(460.27m, items.Where(i => i["status"]!.ToString() == "paid").Sum(i => decimal.Parse(i["interest"]!["amount"]!.ToString(), CultureInfo.InvariantCulture)));
        var days = new DateOnly(2026, 10, 13).DayNumber - new DateOnly(2026, 9, 19).DayNumber;
        Assert.Equal(24, days);
        Assert.Equal(460.27m, (decimal)Math.Round(200_000.0 * 0.035 * days / 365 * 100, MidpointRounding.AwayFromZero) / 100);   // the mock's interestFor
        Assert.Equal(("R02", "Account closed", "returned"), (items[1]["returnCode"]!.ToString(), items[1]["returnReason"]!.ToString(), items[1]["status"]!.ToString()));
        Assert.Equal(items[1]["id"]!.ToString(), items[2]["replacementOfId"]!.ToString());
        Assert.Equal("100230.14", items[1]["amount"]!["amount"]!.ToString());   // the returned original was never edited

        // Workflow runs: the mock's 14. One failed (the certificate letter) and was re-run as run 2 under the same workflow id.
        var runs = (await client.GetApiAsync($"/claims/{claimId}/workflow-runs")).Items.ToList();
        Assert.Equal(14, runs.Count);
        Assert.Equal(13, runs.Count(r => r["status"]!.ToString() == "completed"));
        Assert.Equal(["failed"], runs.Where(r => r["status"]!.ToString() != "completed").Select(r => r["status"]!.ToString()));
        Assert.Equal(12, runs.Count(r => r["type"]!.ToString() == "event"));   // twelve event-workflow runs (eleven workflow ids: one has two runs)
        Assert.Equal(11, runs.Where(r => r["type"]!.ToString() == "event").Select(r => r["workflowId"]!.ToString()).Distinct().Count());
        Assert.Equal((1, 1), (runs.Count(r => r["type"]!.ToString() == "orchestration"), runs.Count(r => r["type"]!.ToString() == "deadline")));
        Assert.Equal(["Document received", "Document received", "Certificate rejected", "Certificate rejected", "Document received", "Document received", "Document received", "Decision recorded",
                      "Payment confirmed", "Payment returned", "New bank account", "Payment confirmed"], runs.Where(r => r["type"]!.ToString() == "event").Select(r => r["name"]!.ToString()));
        Assert.All(runs.Where(r => r["status"]!.ToString() == "completed"), r => Assert.NotNull(r["elapsedMs"]));

        // Deadline rows: the mock's 16. Only Mark's follow-up fired; the status letter was skipped; the other 14 closed early; nothing is left waiting.
        var rows = await Sql.ListAsync<string>("SELECT kind || ':' || state || ':' || fired || ':' || COALESCE(closed_by, '-') FROM deadlines WHERE claim_id = @c ORDER BY created_at, id", new { c = claimId });
        Assert.Equal(16, rows.Count);
        Assert.Equal(1, rows.Count(r => r.Contains(":true:", StringComparison.Ordinal)));
        Assert.Equal(["requirement_follow_up:done:true:workflow"], rows.Where(r => r.Contains(":true:", StringComparison.Ordinal)));
        Assert.Equal(["status_letter:skipped:false:decision"], rows.Where(r => r.Contains(":skipped:", StringComparison.Ordinal)));
        Assert.Equal(14, rows.Count(r => r.Contains(":done:false:", StringComparison.Ordinal)));
        Assert.DoesNotContain(rows, r => r.Contains(":open:", StringComparison.Ordinal) || r.Contains(":dispatched:", StringComparison.Ordinal));
        Assert.Contains("first_contact_by:done:false:user", rows);
        Assert.Contains("document_review_by:done:false:user", rows);
        Assert.Contains("bank_details_by:done:false:user", rows);
        Assert.Equal(2, rows.Count(r => r.StartsWith("payment_due:", StringComparison.Ordinal)));   // pay after approval (13 Oct) and the reissue target (20 Oct)
        Assert.Equal(6, rows.Count(r => r.StartsWith("requirement_follow_up:", StringComparison.Ordinal)));   // three at intake, the correction chase, the certified-copy row, Mark's second row

        // Two closes, one reopening.
        Assert.Equal(2, await One<int>("SELECT count(*) FROM history_events WHERE claim_id = @c AND title = 'Claim closed: every benefit line paid or closed'", new { c = claimId }));
        Assert.Equal(1, await One<int>("SELECT count(*) FROM history_events WHERE claim_id = @c AND title = 'Claim reopened: payment returned'", new { c = claimId }));

        // No letter went twice: every idempotency key exists once and every letter that was asked for was sent; nothing is left queued or failed.
        Assert.Equal(await One<int>("SELECT count(*) FROM letters WHERE claim_id = @c", new { c = claimId }), await One<int>("SELECT count(DISTINCT dedupe_key) FROM letters WHERE claim_id = @c", new { c = claimId }));
        Assert.Equal(0, await One<int>("SELECT count(*) FROM letters WHERE claim_id = @c AND status <> 'sent'", new { c = claimId }));
        Assert.Equal(
            ["ACK-LIFE-01", "AGT-NOTE-01", "AGT-NOTE-02", "AGT-NOTE-03", "AGT-NOTE-03", "APR-LIFE-01", "APR-LIFE-01", "CLS-LIFE-01", "CLS-LIFE-01", "PAY-LIFE-01", "PAY-LIFE-01", "PAY-LIFE-01",
             "PKT-LIFE-02", "PKT-LIFE-02", "REM-LIFE-01", "REQ-LIFE-03", "RTN-LIFE-01", "RTN-LIFE-02", "W9-LIFE-01"],
            await Sql.ListAsync<string>("SELECT template_code FROM letters WHERE claim_id = @c ORDER BY template_code", new { c = claimId }));
        Assert.Equal(1, await One<int>("SELECT count(*) FROM letters WHERE claim_id = @c AND template_code = 'REQ-LIFE-03'", new { c = claimId }));   // the letter that failed and was re-run
        Assert.Equal(0, await One<int>("SELECT count(*) FROM outbox_events WHERE claim_id = @c AND published_at IS NULL", new { c = claimId }));
        Assert.Equal(0, await One<int>("SELECT count(*) FROM work_items WHERE claim_id = @c AND status = 'open'", new { c = claimId }));   // closing the claim closed its queue

        // Faults: every switch that fired is in the log, for the UI's "what Temporal did".
        var faults = await client.GetApiAsync("/dev/faults");
        Assert.Empty(faults.Json["active"]!.AsArray());
        var logged = faults.Json["log"]!.AsArray().Select(e => e!["name"]!.ToString()).ToHashSet();
        Assert.Contains("worker.stall-once:LifeIntake_SendAcknowledgementAndPackets", logged);
        Assert.Contains("tin.no-match", logged);
        Assert.Contains("letters.down", logged);
    }
}
