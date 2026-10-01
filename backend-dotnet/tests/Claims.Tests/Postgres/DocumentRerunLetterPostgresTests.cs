using System.Globalization;
using System.Text.Json;
using Claims.Config;
using Claims.Gateway;
using Claims.Temporal;
using Claims.Tests.Support;
using Microsoft.Extensions.DependencyInjection;
using Temporalio.Api.Enums.V1;
using Temporalio.Client;
using Temporalio.Exceptions;
using Temporalio.Testing;
using Temporalio.Worker;

namespace Claims.Tests.Postgres;

/// <summary>
/// REQUIRES POSTGRES. The re-run of a document workflow whose first run queued the "please correct your W-9" letter and then failed (the letters service was down), on Temporal's
/// in-process time-skipping test server with the REAL activities, services and SQL. No letter may stay queued once the workflow has finished:
///   * run 2 gets a match: the correction is moot, so the queued letter is SKIPPED (with a reason, and a history line);
///   * run 2 gets "no match" again: the letter is still relevant, so run 2 SENDS the letter run 1 queued (same row, same idempotency key).
/// </summary>
public class DocumentRerunLetterPostgresTests(DocumentRerunLetterPostgresTests.Fixture fixture) : IClassFixture<DocumentRerunLetterPostgresTests.Fixture>
{
    public sealed class Fixture : PostgresApiFixture
    {
        private CancellationTokenSource? stop;
        private Task? workerTask;

        public WorkflowEnvironment Env { get; private set; } = null!;

        protected override string Hint => "rerunletter";

        protected override DateTimeOffset? ClockStart => DateTimeOffset.Parse("2026-10-01T16:25:00Z", CultureInfo.InvariantCulture);

        protected override IReadOnlyDictionary<string, string?> Settings { get; } = new Dictionary<string, string?> { ["Claims:Db:DevSeed"] = "true" };

        protected override async Task BeforeStartAsync() =>
            Env = await WorkflowEnvironment.StartTimeSkippingAsync(new WorkflowEnvironmentStartTimeSkippingOptions { DataConverter = TemporalSetup.DataConverterFor() });

        protected override void ConfigureServices(IServiceCollection services) =>
            services.AddSingleton<IWorkflowLauncher>(sp => new TemporalWorkflowLauncher(Env.Client, sp.GetRequiredService<ClaimsOptions>()));

        protected override Task StartedAsync()
        {
            var worker = new TemporalWorker(Env.Client, TemporalWorkerService.WorkerOptions("claims", null, null, documentReceived: Get<DocumentReceivedActivities>()));
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

    private IFaultRegistry Faults => fixture.Get<IFaultRegistry>();

    private Task<T> One<T>(string sql, object? param = null) => fixture.Db.SingleAsync<T>(sql, param);

    private Task<DocumentReceivedWorkflow.Result> RunWorkflowAsync(string workflowId, DocumentReceivedActivities.Input input) =>
        fixture.Env.Client.ExecuteWorkflowAsync((DocumentReceivedWorkflow wf) => wf.RunAsync(input),
            new WorkflowOptions(workflowId, "claims") { IdReusePolicy = WorkflowIdReusePolicy.AllowDuplicateFailedOnly });

    /// <summary>A gathering claim and Diane's W-9 (received through the API), the IRS answering "no match" for the first <paramref name="noMatches"/> checks.</summary>
    private async Task<(Guid Claim, Guid Doc, string Workflow, DocumentReceivedActivities.Input Input)> W9Async(int noMatches)
    {
        foreach (var f in Faults.Active) Faults.Set(f, false);
        var claim = await LifeScenario.GatheringAsync(fixture);
        var diane = await One<Guid>("SELECT p.id FROM claim_parties cp JOIN parties p ON p.id = cp.party_id WHERE cp.claim_id = @c AND cp.role = 'beneficiary' AND p.full_name LIKE 'Diane%'", new { c = claim.ClaimId });
        var body = JsonSerializer.Serialize(new { kind = "claimant_statement_w9", source = "portal", partyId = diane, attributes = new { tin = "123-45-6789" } });
        var r = await fixture.CreateClient().PostApiAsync($"/claims/{claim.ClaimId}/documents", body,
            new Dictionary<string, string> { ["Idempotency-Key"] = "rr-" + Guid.NewGuid(), ["X-Actor"] = "portal.diane" });
        Assert.Equal(201, r.StatusCode);
        var doc = Guid.Parse(r.Str("id")!);
        var wf = "event-rerunletter-" + doc;
        Faults.Set(FaultCatalog.TinNoMatch, noMatches);
        return (claim.ClaimId, doc, wf, new DocumentReceivedActivities.Input(claim.ClaimId, doc, Guid.NewGuid()));
    }

    /// <summary>Run 1: "no match", the letters service is down for every attempt, so the retries run out and the workflow fails with the letter still queued.</summary>
    private async Task RunOneFailsWithTheLetterQueuedAsync(Guid claim, Guid doc, string wf, DocumentReceivedActivities.Input input)
    {
        Faults.Set(FaultCatalog.LettersDown, true);
        var e = await Assert.ThrowsAsync<WorkflowFailedException>(() => RunWorkflowAsync(wf, input));
        Assert.IsType<ActivityFailureException>(e.InnerException);
        Assert.Equal(("queued", "failed", 1), (await One<string>("SELECT status FROM letters WHERE dedupe_key = 'document:' || @d || ':correction'", new { d = doc.ToString() }),
            await One<string>("SELECT status FROM workflow_runs WHERE workflow_id = @w AND run_no = 1", new { w = wf }), await One<int>("SELECT count(*) FROM workflow_runs WHERE workflow_id = @w", new { w = wf })));
        Faults.Set(FaultCatalog.LettersDown, false);
    }

    [PostgresFact]
    public async Task ARerunThatAcceptsTheW9SkipsTheLetterRunOneLeftQueuedAndNoLetterStaysQueued()
    {
        var (claim, doc, wf, input) = await W9Async(noMatches: 1);   // the IRS says "no match" once (run 1), then matches
        await RunOneFailsWithTheLetterQueuedAsync(claim, doc, wf, input);

        var run2 = await RunWorkflowAsync(wf, input);   // same workflow id: allowed, run 1 failed

        Assert.Equal("accepted", run2.Outcome);
        var letter = await fixture.Db.QuerySingleAsync("SELECT status, status_reason, sent_at FROM letters WHERE dedupe_key = 'document:' || @d || ':correction'", new { d = doc.ToString() },
            r => (Status: r.Text("status"), Reason: r.Str("status_reason"), Sent: !r.IsNull("sent_at")));
        Assert.Equal(("skipped", false), (letter.Status, letter.Sent));
        Assert.Contains("no longer needed", letter.Reason, StringComparison.Ordinal);
        Assert.Equal(0, await One<int>("SELECT count(*) FROM letters WHERE claim_id = @c AND status = 'queued'", new { c = claim }));
        Assert.Equal(("accepted", "accepted"), (await One<string>("SELECT status FROM documents WHERE id = @d", new { d = doc }),
            await One<string>("SELECT state FROM requirements r JOIN documents d ON d.requirement_id = r.id WHERE d.id = @d", new { d = doc })));
        Assert.Equal(("completed", 2), (await One<string>("SELECT status FROM workflow_runs WHERE workflow_id = @w AND run_no = 2", new { w = wf }), await One<int>("SELECT count(*) FROM workflow_runs WHERE workflow_id = @w", new { w = wf })));
        Assert.Equal(1, await One<int>("SELECT count(*) FROM history_events WHERE claim_id = @c AND title LIKE 'Letter skipped: W9-LIFE-01%'", new { c = claim }));
    }

    [PostgresFact]
    public async Task ARerunThatStillGetsNoMatchSendsTheLetterRunOneQueuedOnceWithTheSameKey()
    {
        var (claim, doc, wf, input) = await W9Async(noMatches: 2);   // "no match" in run 1 and again in run 2
        await RunOneFailsWithTheLetterQueuedAsync(claim, doc, wf, input);
        var queuedId = await One<Guid>("SELECT id FROM letters WHERE dedupe_key = 'document:' || @d || ':correction'", new { d = doc.ToString() });

        var run2 = await RunWorkflowAsync(wf, input);

        Assert.Equal("not_enough", run2.Outcome);
        var letter = await fixture.Db.QuerySingleAsync("SELECT id, status, sent_at FROM letters WHERE dedupe_key = 'document:' || @d || ':correction'", new { d = doc.ToString() },
            r => (Id: r.Guid("id"), Status: r.Text("status"), Sent: !r.IsNull("sent_at")));
        Assert.Equal((queuedId, "sent", true), (letter.Id, letter.Status, letter.Sent));
        Assert.Equal(1, await One<int>("SELECT count(*) FROM letters WHERE claim_id = @c AND template_code = 'W9-LIFE-01'", new { c = claim }));
        Assert.Equal(0, await One<int>("SELECT count(*) FROM letters WHERE claim_id = @c AND status = 'queued'", new { c = claim }));
    }
}
