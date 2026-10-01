using System.Globalization;
using Claims.Common;
using Claims.Config;
using Claims.Deadline;
using Claims.Outbox;
using Claims.Temporal;
using Claims.Tests.Support;
using Microsoft.Extensions.DependencyInjection;
using Temporalio.Testing;
using Temporalio.Worker;

namespace Claims.Tests.Postgres;

/// <summary>
/// THE END-TO-END TEST. The mock's simple story, played on the real stack: real Postgres, the real services and SQL, the real Temporal workflows and
/// activities on Temporal's in-process (time-skipping) test server, the production launcher and outbox relay, the HTTP pipeline. Only the outside
/// systems (bank, letters, policy admin, sanctions) are the stubs, and business time is set by hand to the mock's own dates, so the figures do not depend
/// on the day the suite runs:
///
///   Fri 25 Sep 10:03  Diane phones the notice          -> intake workflow sets the claim up
///   Mon 28 Sep, Thu 1 Oct  Diane's statement and the certificate are accepted
///   Mon 5 Oct 08:00   Mark's follow-up comes due       -> dispatcher -> deadline workflow sends the reminder
///   Wed 7 Oct 19:40   Mark's statement is accepted     -> proof of loss complete, in review
///   Thu 8 Oct 11:30   Rachel records the decision      -> items cleared, event workflow sends the approval letters
///   Fri 9 Oct 02:00   the daily payment run pays       -> claim closed, event workflow sends confirmations and the closing letter
///
/// Expected money (the docs page prints the same): 20 days of interest at 3.5% on $200,000.00 is $383.56, so Diane and Mark each get $100,000.00 + $191.78.
/// </summary>
public class SimpleLifeScenarioPostgresTests(SimpleLifeScenarioPostgresTests.Fixture fixture) : IClassFixture<SimpleLifeScenarioPostgresTests.Fixture>
{
    private static DateTimeOffset At(string iso) => DateTimeOffset.Parse(iso, CultureInfo.InvariantCulture);

    public sealed class Fixture : PostgresApiFixture
    {
        private CancellationTokenSource? stop;
        private Task? workerTask;

        public WorkflowEnvironment Env { get; private set; } = null!;

        protected override string Hint => "simple";

        protected override DateTimeOffset? ClockStart => At("2026-09-25T15:03:00Z");

        protected override IReadOnlyDictionary<string, string?> Settings { get; } = new Dictionary<string, string?> { ["Claims:Db:DevSeed"] = "true" };

        protected override async Task BeforeStartAsync() =>
            Env = await WorkflowEnvironment.StartTimeSkippingAsync(new WorkflowEnvironmentStartTimeSkippingOptions { DataConverter = TemporalSetup.DataConverterFor() });

        protected override void ConfigureServices(IServiceCollection services) =>
            services.AddSingleton<IWorkflowLauncher>(sp => new TemporalWorkflowLauncher(Env.Client, sp.GetRequiredService<ClaimsOptions>()));   // the production launcher

        protected override Task StartedAsync()
        {
            var worker = new TemporalWorker(Env.Client, TemporalWorkerService.WorkerOptions("claims", Get<LifeIntakeActivities>(), Get<RequirementFollowUpActivities>(),
                null, Get<DecisionRecordedActivities>(), Get<PaymentConfirmedActivities>()));
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

    private Task<T> One<T>(string sql, object? param = null) => Sql.SingleAsync<T>(sql, param);

    private async Task<T> ResultAsync<T>(string workflowId) => await fixture.Env.Client.GetWorkflowHandle(workflowId).GetResultAsync<T>();

    [PostgresFact]
    public async Task IntakeToClosedOnTheRealStack()
    {
        var client = fixture.CreateClient();
        var clock = fixture.Clock;
        var relay = fixture.Get<OutboxRelay>();

        // ---- Fri 25 Sep: the notice. One transaction, no workflow yet; then the outbox relay starts the intake orchestration.
        clock.Set(At("2026-09-25T15:03:00Z"));
        var intake = await client.PostApiAsync("/claims/life-intake", Json.Serialize(TestData.Castellano("natural")), new Dictionary<string, string> { ["Idempotency-Key"] = "e2e-" + Guid.NewGuid(), ["X-Actor"] = "diane.intake" });
        Assert.Equal(201, intake.StatusCode);
        Assert.Equal("received", intake.Str("status"));
        var claimId = Guid.Parse(intake.Str("id")!);
        var claimNumber = intake.Str("claimNumber")!;
        Assert.Equal(1, await relay.PublishPendingAsync());
        Assert.Equal("set_up", (await ResultAsync<LifeIntakeWorkflow.Result>("orch-" + claimNumber + "-intake")).Outcome);
        var claim = await client.GetApiAsync($"/claims/{claimId}");
        Assert.Equal(("gathering_evidence", "fast_track_life"), (claim.Str("status"), claim.Str("track")));

        // ---- Evidence arrives: three requirements are still open (the fourth was met from our records at intake).
        async Task AcceptAsync(string namePart)
        {
            var list = await client.GetApiAsync($"/claims/{claimId}/requirements");
            var r = list.Items.Single(x => x["name"]!.ToString().Contains(namePart, StringComparison.Ordinal));
            var accepted = await client.PostApiAsync($"/requirements/{r["id"]}:accept", null, new Dictionary<string, string> { ["If-Match"] = $"\"{r["version"]}\"", ["X-Actor"] = "rachel" });
            Assert.Equal(200, accepted.StatusCode);
        }
        Assert.Equal(4, (await client.GetApiAsync($"/claims/{claimId}/requirements")).Items.Count());
        clock.Set(At("2026-09-28T14:40:00Z"));
        // Mon 28 Sep 09:40: Rachel makes the welcome call and ticks it off; that meets the first-contact row (D-703 in the mock).
        var rachel = await One<Guid>("SELECT id FROM staff_users WHERE handle = 'rachel'");
        var welcome = (await client.GetApiAsync($"/work-items?owner={rachel}&status=open")).Items.Single(w => w["claimId"]!.ToString() == claimId.ToString() && w["action"]!.ToString().StartsWith("New life claim", StringComparison.Ordinal));
        Assert.Equal(200, (await client.PostApiAsync($"/work-items/{welcome["id"]}:complete", null, new Dictionary<string, string> { ["If-Match"] = $"\"{welcome["version"]}\"", ["X-Actor"] = "rachel" })).StatusCode);
        await AcceptAsync("Diane");
        clock.Set(At("2026-10-01T16:25:00Z"));
        await AcceptAsync("death certificate");

        // ---- Mon 5 Oct 08:00: Mark's statement is still missing, so its follow-up row comes due. The dispatcher (as the Schedule would) starts deadline-<id>.
        clock.Set(At("2026-10-05T13:00:01Z"));
        var markRow = await One<Guid>("SELECT d.id FROM deadlines d JOIN requirements r ON r.id = d.requirement_id WHERE d.claim_id = @c AND r.name LIKE '%Mark' AND d.state = 'open'", new { c = claimId });
        var dispatched = await fixture.Get<DeadlineDispatcher>().DispatchDueAsync();
        Assert.Equal(1, dispatched.Started);
        Assert.Equal("reminded", (await ResultAsync<RequirementFollowUpActivities.Result>("deadline-" + markRow)).Outcome);

        // ---- Wed 7 Oct 19:40: Mark's statement is accepted, the last requirement: proof of loss complete in the same transaction.
        clock.Set(At("2026-10-08T00:40:00Z"));
        await AcceptAsync("Mark");
        claim = await client.GetApiAsync($"/claims/{claimId}");
        Assert.Equal("in_review", claim.Str("status"));
        var line = Guid.Parse(claim.Json["benefitLines"]!.AsArray().Single(l => l!["kind"]!.ToString() == "base")!["id"]!.ToString());
        Assert.Equal(["2026-10-14", "2026-11-06"], await Sql.ListAsync<string>(   // review_target (5 business days), decision_due (30 days)
            "SELECT to_char(due_at AT TIME ZONE 'America/Chicago', 'YYYY-MM-DD') FROM deadlines WHERE claim_id = @c AND kind IN ('decision_due', 'review_target') ORDER BY kind DESC", new { c = claimId }));

        // ---- Thu 8 Oct 11:30: Rachel records the decision, within her $250,000 authority.
        clock.Set(At("2026-10-08T16:30:00Z"));
        var decided = await client.PostApiAsync($"/claims/{claimId}/decisions", LifeScenario.ApproveJson(line), LifeScenario.Headers("rachel"));
        Assert.Equal(201, decided.StatusCode);
        var decisionId = decided.Str("decision.id")!;
        Assert.Equal("approved", await One<string>("SELECT status FROM claims WHERE id = @c", new { c = claimId }));
        var cleared = decided.Json["paymentItems"]!.AsArray();
        Assert.Equal(2, cleared.Count);
        Assert.All(cleared, i => Assert.Equal(("cleared", "2026-10-09"), (i!["status"]!.ToString(), i["payOn"]!.ToString())));
        // The outbox event starts event-<decisionId>, which sends the approval letters and tells the agent.
        Assert.Equal(1, await relay.PublishPendingAsync());
        Assert.Equal("letters_sent", (await ResultAsync<DecisionRecordedWorkflow.Result>("event-" + decisionId)).Outcome);
        Assert.Equal(["AGT-NOTE-02", "APR-LIFE-01", "APR-LIFE-01"], await Sql.ListAsync<string>(
            "SELECT template_code FROM letters WHERE claim_id = @c AND source_kind = 'decision' AND status = 'sent' ORDER BY template_code, recipient_label", new { c = claimId }));

        // ---- Fri 9 Oct 02:00: the daily payment run (a batch: no Temporal), then the payment-confirmed event workflow.
        clock.Set(At("2026-10-09T07:00:00Z"));
        var run = await client.PostApiAsync("/payment-runs", "{\"runDate\":\"2026-10-09\"}");
        Assert.Equal(201, run.StatusCode);
        Assert.Equal(("reconciled", 2, "200383.56"), (run.Str("status"), run.At("paidCount")!.GetValue<int>(), run.Str("total.amount")));
        Assert.Equal("closed", await One<string>("SELECT status FROM claims WHERE id = @c", new { c = claimId }));
        Assert.Equal(1, await relay.PublishPendingAsync());
        var eventId = await One<string>("SELECT workflow_id FROM outbox_events WHERE claim_id = @c AND event_type = 'items_paid'", new { c = claimId });
        Assert.Equal("confirmed_and_closed", (await ResultAsync<PaymentConfirmedWorkflow.Result>(eventId)).Outcome);

        // ================= What is left in the database.
        // Statuses.
        claim = await client.GetApiAsync($"/claims/{claimId}");
        Assert.Equal("closed", claim.Str("status"));
        Assert.Equal("2026-10-09T07:00:00Z", claim.Str("closedAt"));
        Assert.Equal(["paid", "closed"], claim.Json["benefitLines"]!.AsArray().OrderBy(l => l!["kind"]!.ToString()).Select(l => l!["status"]!.ToString()));

        // Amounts: two payment items, paid, exactly the mock's figures.
        var items = (await client.GetApiAsync($"/claims/{claimId}/payment-items")).Items.ToList();
        Assert.Equal(["Diane Castellano", "Mark Castellano"], items.Select(i => i["payeeName"]!.ToString()));
        foreach (var i in items)
        {
            Assert.Equal(("paid", "100000.00", "191.78", "100191.78", "eft"), (i["status"]!.ToString(), i["principal"]!["amount"]!.ToString(), i["interest"]!["amount"]!.ToString(),
                i["amount"]!["amount"]!.ToString(), i["method"]!.ToString()));
            Assert.Equal("2026-10-09T07:00:00Z", i["paidAt"]!.ToString());
            Assert.StartsWith("STUB-EFT-", i["paymentReference"]!.ToString(), StringComparison.Ordinal);
        }
        // ... and they are the mock's interestFor: Math.round(200000 * 0.035 * 20 / 365 * 100) / 100, with the days from 19 Sep to 9 Oct.
        var days = (new DateOnly(2026, 10, 9).DayNumber - new DateOnly(2026, 9, 19).DayNumber);
        Assert.Equal(20, days);
        var mockInterest = Math.Round(200_000.0 * 0.035 * days / 365 * 100, MidpointRounding.AwayFromZero) / 100;
        Assert.Equal(383.56, mockInterest);
        Assert.Equal((decimal)mockInterest, items.Sum(i => decimal.Parse(i["interest"]!["amount"]!.ToString(), CultureInfo.InvariantCulture)));

        // Deadline rows: the docs' eleven. One fired (Mark's follow-up), one skipped (the status letter), the rest done without firing.
        var rows = await Sql.ListAsync<string>("SELECT kind || ':' || state || ':' || fired || ':' || COALESCE(closed_by, '-') FROM deadlines WHERE claim_id = @c ORDER BY created_at, kind, id", new { c = claimId });
        Assert.Equal(11, rows.Count);
        Assert.Equal(1, rows.Count(r => r.EndsWith(":true:workflow", StringComparison.Ordinal)));
        Assert.Equal(["status_letter:skipped:false:decision"], rows.Where(r => r.Contains(":skipped:", StringComparison.Ordinal)));
        Assert.DoesNotContain(rows, r => r.Contains(":open:", StringComparison.Ordinal) || r.Contains(":dispatched:", StringComparison.Ordinal));   // nothing is left waiting
        Assert.Contains("first_contact_by:done:false:user", rows);
        Assert.Contains("payment_due:done:false:payment", rows);
        Assert.Contains("decision_due:done:false:decision", rows);
        Assert.Contains("review_target:done:false:decision", rows);

        // Workflow runs: intake orchestration, Mark's follow-up, and the two event workflows, each completed.
        var runs = (await client.GetApiAsync($"/claims/{claimId}/workflow-runs")).Items.ToList();
        Assert.Equal(["orchestration:completed", "deadline:completed", "event:completed", "event:completed"], runs.Select(r => r["type"] + ":" + r["status"]));
        Assert.Equal(["Decision recorded", "Payment confirmed"], runs.Where(r => r["type"]!.ToString() == "event").Select(r => r["name"]!.ToString()));

        // Letters: intake 4, reminder 1, approval 3, payment 4.
        var letters = await Sql.ListAsync<string>("SELECT template_code FROM letters WHERE claim_id = @c AND status = 'sent' ORDER BY template_code", new { c = claimId });
        Assert.Equal(["ACK-LIFE-01", "AGT-NOTE-01", "AGT-NOTE-02", "AGT-NOTE-03", "APR-LIFE-01", "APR-LIFE-01", "CLS-LIFE-01", "PAY-LIFE-01", "PAY-LIFE-01", "PKT-LIFE-02", "PKT-LIFE-02", "REM-LIFE-01"], letters);

        // History: the story in order (oldest first), stamped with business time.
        var titles = await Sql.ListAsync<string>("SELECT title FROM history_events WHERE claim_id = @c AND type IN ('decision', 'payment') OR claim_id = @c AND title LIKE 'Claim closed%' ORDER BY occurred_at, seq", new { c = claimId });
        Assert.Equal(
            ["Decision recorded: approved (v1)", "2 payment items cleared for the Fri 9 Oct run", "2 payment items in the 2026-10-09 payment run",
             "Paid $200,383.56 in the daily payment run", "Claim closed: every benefit line paid or closed"], titles);
        Assert.Equal(0, await One<int>("SELECT count(*) FROM work_items WHERE claim_id = @c AND status = 'open'", new { c = claimId }));   // closing the claim closed its queue
        Assert.Equal(0, await One<int>("SELECT count(*) FROM outbox_events WHERE claim_id = @c AND published_at IS NULL", new { c = claimId }));
    }
}
