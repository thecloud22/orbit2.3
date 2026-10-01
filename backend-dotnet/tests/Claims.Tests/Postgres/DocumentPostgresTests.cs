using System.Globalization;
using System.Text.Json;
using Claims.Common;
using Claims.Events;
using Claims.Gateway;
using Claims.Outbox;
using Claims.Store;
using Claims.Tests.Support;
using Npgsql;

namespace Claims.Tests.Postgres;

/// <summary>
/// REQUIRES POSTGRES. Documents, and the two things a person does with one. Every change is ONE transaction in Postgres, saved before any workflow exists: the document with its outbox
/// event and idempotency key; the examiner's review with the requirement, the deadline rows, the work item and the outbox event. The database work of the workflows (the IRS check's
/// answer, the accept path, the hand-off to a person, the letter) is called directly, as the activities call it, with a run record of its own. Business time is frozen at the mock's
/// Thu 1 Oct 11:25 Central so the dates come out as in the docs.
/// </summary>
public class DocumentPostgresTests(DocumentPostgresTests.Fixture fixture) : IClassFixture<DocumentPostgresTests.Fixture>, IAsyncLifetime
{
    public sealed class Fixture : PostgresApiFixture
    {
        protected override string Hint => "documents";

        protected override DateTimeOffset? ClockStart => DateTimeOffset.Parse("2026-09-25T15:03:00Z", CultureInfo.InvariantCulture);

        protected override IReadOnlyDictionary<string, string?> Settings { get; } = new Dictionary<string, string?> { ["Claims:Db:DevSeed"] = "true" };
    }

    private static DateTimeOffset At(string iso) => DateTimeOffset.Parse(iso, CultureInfo.InvariantCulture);

    private Db Sql => fixture.Db;
    private HttpClient Client => fixture.CreateClient();
    private IFaultRegistry Faults => fixture.Get<IFaultRegistry>();

    public ValueTask InitializeAsync()
    {
        if (!PostgresSupport.Available) return ValueTask.CompletedTask;
        foreach (var f in Faults.Active) Faults.Set(f, false);
        fixture.Clock.Set(At("2026-10-01T16:25:00Z"));   // Thu 1 Oct 11:25 Central
        return ValueTask.CompletedTask;
    }

    public ValueTask DisposeAsync() => ValueTask.CompletedTask;

    private Task<T> One<T>(string sql, object? param = null) => Sql.SingleAsync<T>(sql, param);

    private static Dictionary<string, string> Key(string? actor = null) => new() { ["Idempotency-Key"] = "doc-" + Guid.NewGuid(), ["X-Actor"] = actor ?? "portal.diane" };

    private static string Body(string kind, string source, object? attributes = null, object? extra = null)
    {
        var d = new Dictionary<string, object?> { ["kind"] = kind, ["source"] = source };
        if (attributes is not null) d["attributes"] = attributes;
        if (extra is not null) foreach (var p in extra.GetType().GetProperties()) d[p.Name] = p.GetValue(extra);
        return JsonSerializer.Serialize(d);
    }

    private async Task<Guid> RequirementAsync(Guid claim, string namePart) =>
        await One<Guid>("SELECT id FROM requirements WHERE claim_id = @c AND name LIKE @n", new { c = claim, n = "%" + namePart + "%" });

    private async Task<Guid> PartyAsync(Guid claim, string first) =>
        await One<Guid>("SELECT p.id FROM claim_parties cp JOIN parties p ON p.id = cp.party_id WHERE cp.claim_id = @c AND cp.role = 'beneficiary' AND p.full_name LIKE @n", new { c = claim, n = first + "%" });

    private async Task<Guid> ReceiveAsync(Guid claim, string body, string? actor = null)
    {
        var r = await Client.PostApiAsync($"/claims/{claim}/documents", body, Key(actor));
        Assert.Equal(201, r.StatusCode);
        return Guid.Parse(r.Str("id")!);
    }

    private static string Wf(Guid doc) => "event-test-" + doc;

    /// <summary>What the activities do around the service methods: open the run record (Begin) and call them with the workflow and run ids.</summary>
    private async Task<DocumentEventService.Facts> BeginAsync(Guid claim, Guid doc, string workflowId, string run) =>
        await fixture.Get<DocumentEventService>().BeginReceivedAsync(claim, doc, Guid.NewGuid(), workflowId, run);

    // ------------------------------------------------------------------ receiving

    [PostgresFact]
    public async Task ADocumentIsSavedWithItsOutboxEventAndKeyInOneTransactionAndTheRequirementIsUntouched()
    {
        var claim = await LifeScenario.GatheringAsync(fixture);
        var diane = await PartyAsync(claim.ClaimId, "Diane");
        var headers = Key();

        var r = await Client.PostApiAsync($"/claims/{claim.ClaimId}/documents",
            Body("claimant_statement_w9", "portal", new { tin = "123-45-6789" }, new { requirementKey = "statement", partyId = diane }), headers);

        Assert.Equal(201, r.StatusCode);
        Assert.Equal(("received", "claimant_statement_w9", "portal"), (r.Str("status"), r.Str("kind"), r.Str("source")));
        Assert.Equal("***-**-6789", r.Str("attributes.tinMasked"));   // the API never shows the whole number
        Assert.DoesNotContain("123-45", r.Body, StringComparison.Ordinal);
        Assert.Equal("Diane Castellano", r.Str("partyName"));
        Assert.Contains("Diane", r.Str("requirementName"), StringComparison.Ordinal);
        Assert.NotNull(r.Header("ETag"));
        var doc = Guid.Parse(r.Str("id")!);
        // The outbox event carries the document, is unpublished (no workflow yet), and the requirement has not moved: the workflow decides.
        Assert.Equal(1, await One<int>("SELECT count(*) FROM outbox_events WHERE claim_id = @c AND event_type = 'document_received' AND payload->>'documentId' = @d AND published_at IS NULL",
            new { c = claim.ClaimId, d = doc.ToString() }));
        Assert.Equal("requested", await One<string>("SELECT state FROM requirements WHERE id = @r", new { r = await RequirementAsync(claim.ClaimId, "Diane") }));
        Assert.Equal(1, await One<int>("SELECT count(*) FROM history_events WHERE claim_id = @c AND type = 'document' AND title = 'Received: Claimant statement and W-9'", new { c = claim.ClaimId }));

        // Same key and body: the same document, replayed, nothing new written.
        var again = await Client.PostApiAsync($"/claims/{claim.ClaimId}/documents",
            Body("claimant_statement_w9", "portal", new { tin = "123-45-6789" }, new { requirementKey = "statement", partyId = diane }), headers);
        Assert.Equal(200, again.StatusCode);
        Assert.Equal("true", again.Header("Idempotent-Replayed"));
        Assert.Equal(r.Str("id"), again.Str("id"));
        Assert.Equal(1, await One<int>("SELECT count(*) FROM documents WHERE claim_id = @c", new { c = claim.ClaimId }));
        Assert.Equal(1, await One<int>("SELECT count(*) FROM outbox_events WHERE claim_id = @c AND event_type = 'document_received'", new { c = claim.ClaimId }));
        // The same key with another body is refused.
        var other = await Client.PostApiAsync($"/claims/{claim.ClaimId}/documents",
            Body("claimant_statement_w9", "portal", new { tin = "987-65-4321" }, new { requirementKey = "statement", partyId = diane }), headers);
        Assert.Equal((409, "idempotency_key_reuse"), (other.StatusCode, other.Str("code")));
    }

    [PostgresFact]
    public async Task IfTheOutboxWriteFailsNothingOfTheDocumentSurvivesNotEvenTheKey()
    {
        var claim = await LifeScenario.GatheringAsync(fixture);
        await Sql.ExecuteAsync("""
            CREATE OR REPLACE FUNCTION fail_document_outbox() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'injected outbox failure'; END $$;
            CREATE TRIGGER fail_document_outbox BEFORE INSERT ON outbox_events FOR EACH ROW WHEN (NEW.event_type = 'document_received') EXECUTE FUNCTION fail_document_outbox();
            """);
        try
        {
            var headers = Key();
            var r = await Client.PostApiAsync($"/claims/{claim.ClaimId}/documents", Body("death_certificate", "mail_room", new { photocopy = true }), headers);
            Assert.Equal(500, r.StatusCode);
            Assert.Equal(0, await One<int>("SELECT count(*) FROM documents WHERE claim_id = @c", new { c = claim.ClaimId }));
            Assert.Equal(0, await One<int>("SELECT count(*) FROM idempotency_keys WHERE key = @k", new { k = headers["Idempotency-Key"] }));
            Assert.Equal(0, await One<int>("SELECT count(*) FROM history_events WHERE claim_id = @c AND type = 'document'", new { c = claim.ClaimId }));
        }
        finally
        {
            await Sql.ExecuteAsync("DROP TRIGGER fail_document_outbox ON outbox_events; DROP FUNCTION fail_document_outbox();");
        }
    }

    [PostgresFact]
    public async Task BadRequestsAreRefusedAndTheRequirementIsFoundByKindKeyOrParty()
    {
        var claim = await LifeScenario.GatheringAsync(fixture);
        var client = Client;
        var path = $"/claims/{claim.ClaimId}/documents";

        Assert.Equal((422, "validation_failed"), Pair(await client.PostApiAsync(path, Body("passport", "portal"), Key())));
        Assert.Equal((422, "validation_failed"), Pair(await client.PostApiAsync(path, Body("other", "carrier_pigeon"), Key())));
        Assert.Equal((422, "validation_failed"), Pair(await client.PostApiAsync(path, Body("claimant_statement_w9", "portal", new { tin = "12x-45" }), Key())));
        Assert.Equal(400, (await client.PostApiAsync(path, Body("other", "upload"))).StatusCode);   // no Idempotency-Key
        Assert.Equal(404, (await client.PostApiAsync($"/claims/{Guid.NewGuid()}/documents", Body("other", "upload"), Key())).StatusCode);
        // Two statements are open, so a statement with nobody named is ambiguous; with the payee named it is found.
        Assert.Equal((422, "requirement_ambiguous"), Pair(await client.PostApiAsync(path, Body("claimant_statement_w9", "portal", new { tin = "123456789" }), Key())));
        var mark = await PartyAsync(claim.ClaimId, "Mark");
        var ok = await client.PostApiAsync(path, Body("claimant_statement_w9", "portal", new { tin = "123456789" }, new { partyId = mark }), Key());
        Assert.Equal(201, ok.StatusCode);
        Assert.Equal("Mark Castellano", ok.Str("partyName"));
        // A certificate needs no naming: its kind says which requirement it is for.
        var cert = await client.PostApiAsync(path, Body("death_certificate", "mail_room"), Key());
        Assert.Equal(("201", "Certified death certificate"), (cert.StatusCode.ToString(CultureInfo.InvariantCulture), cert.Str("requirementName")));
        // A requirement that is already met takes no more documents.
        await fixture.Get<Claims.Requirement.RequirementService>().AcceptFromDocumentAsync(await RequirementAsync(claim.ClaimId, "Certified death"), "test", Actor.User("rachel"));
        Assert.Equal((409, "requirement_already_met"), Pair(await client.PostApiAsync(path, Body("death_certificate", "mail_room"), Key())));
        // Listing and reading.
        var list = await client.GetApiAsync(path);
        Assert.Equal(2, list.Items.Count());
        Assert.Equal(200, (await client.GetApiAsync("/documents/" + ok.Str("id"))).StatusCode);
        Assert.Equal(404, (await client.GetApiAsync("/documents/" + Guid.NewGuid())).StatusCode);
    }

    private static (int, string?) Pair(ApiResponse r) => (r.StatusCode, r.Str("code"));

    // ------------------------------------------------------------------ what the workflow's database work does with a document

    [PostgresFact]
    public async Task AMatchingStatementIsAcceptedThroughTheAcceptPathAndTheLastRequirementCompletesProofOfLoss()
    {
        var claim = await LifeScenario.GatheringAsync(fixture);
        var accepts = fixture.Get<Claims.Requirement.RequirementService>();
        await accepts.AcceptFromDocumentAsync(await RequirementAsync(claim.ClaimId, "Certified death"), "on file", Actor.User("rachel"));
        await accepts.AcceptFromDocumentAsync(await RequirementAsync(claim.ClaimId, "Diane"), "on file", Actor.User("rachel"));
        var mark = await PartyAsync(claim.ClaimId, "Mark");
        var doc = await ReceiveAsync(claim.ClaimId, Body("claimant_statement_w9", "portal", new { tin = "111223333" }, new { partyId = mark }));
        var service = fixture.Get<DocumentEventService>();
        var wf = Wf(doc);

        var facts = await BeginAsync(claim.ClaimId, doc, wf, "run-1");
        Assert.Equal(("tin_check", 1), (facts.Route, facts.RunNo));
        var answer = await service.CheckTinAsync(doc, 1);
        Assert.True(answer.Match);   // nine digits: the stub IRS says match
        Assert.True(await service.AcceptAsync(doc, [Claims.Domain.RunStep.Done("Check the taxpayer ID", "ok", "IRS TIN matching")], "note", wf, "run-1"));

        Assert.Equal("accepted", await One<string>("SELECT status FROM documents WHERE id = @d", new { d = doc }));
        Assert.Equal("accepted", await One<string>("SELECT state FROM requirements WHERE id = @r", new { r = await RequirementAsync(claim.ClaimId, "Mark") }));
        Assert.Equal(0, await One<int>("SELECT count(*) FROM deadlines WHERE claim_id = @c AND kind = 'requirement_follow_up' AND state = 'open'", new { c = claim.ClaimId }));
        // It was the last requirement: the accept path completed proof of loss in the same transaction.
        Assert.Equal("in_review", await One<string>("SELECT status FROM claims WHERE id = @c", new { c = claim.ClaimId }));
        Assert.Equal(2, await One<int>("SELECT count(*) FROM deadlines WHERE claim_id = @c AND kind IN ('decision_due', 'review_target')", new { c = claim.ClaimId }));
        Assert.Equal(("completed", 1, "note"), (await One<string>("SELECT status FROM workflow_runs WHERE workflow_id = @w", new { w = wf }),
            await One<int>("SELECT run_no FROM workflow_runs WHERE workflow_id = @w", new { w = wf }), await One<string>("SELECT note FROM workflow_runs WHERE workflow_id = @w", new { w = wf })));
        Assert.NotNull(await Sql.SingleOrDefaultAsync<int?>("SELECT elapsed_ms FROM workflow_runs WHERE workflow_id = @w", new { w = wf }));
        // Repeating the step (an activity retried after its answer was lost) changes nothing.
        Assert.False(await service.AcceptAsync(doc, [], "note", wf, "run-1"));
    }

    [PostgresFact]
    public async Task ANoMatchIsSavedAsNotEnoughWithTheChaseTheWorkItemAndTheLetterOnce()
    {
        var claim = await LifeScenario.GatheringAsync(fixture);
        var diane = await PartyAsync(claim.ClaimId, "Diane");
        var reqId = await RequirementAsync(claim.ClaimId, "Diane");
        var oldRow = await One<Guid>("SELECT id FROM deadlines WHERE requirement_id = @r AND state = 'open'", new { r = reqId });
        Faults.Set(FaultCatalog.TinNoMatch, 1);
        var doc = await ReceiveAsync(claim.ClaimId, Body("claimant_statement_w9", "portal", new { tin = "123-45-6789" }, new { partyId = diane }));
        var service = fixture.Get<DocumentEventService>();
        var wf = Wf(doc);
        await BeginAsync(claim.ClaimId, doc, wf, "run-1");

        var answer = await service.CheckTinAsync(doc, 1);
        Assert.False(answer.Match);   // an ANSWER, returned normally
        Assert.Contains("fault tin.no-match", answer.Detail, StringComparison.Ordinal);
        var saved = await service.MarkNotEnoughAsync(doc, "TIN mismatch", wf);
        Assert.Equal(("Diane Castellano", "2026-10-08"), (saved.PartyName, saved.CorrectionDue));   // Thu 1 Oct + 7 days

        Assert.Equal(("not_enough", "TIN mismatch"), (await One<string>("SELECT status FROM documents WHERE id = @d", new { d = doc }), await One<string>("SELECT status_note FROM documents WHERE id = @d", new { d = doc })));
        Assert.Equal(("not_enough", "TIN mismatch"), (await One<string>("SELECT state FROM requirements WHERE id = @r", new { r = reqId }), await One<string>("SELECT state_note FROM requirements WHERE id = @r", new { r = reqId })));
        // The row that waited closed without firing; a correction chase (the same kind, allowed by the one-live-follow-up index) replaced it, due in 7 days.
        Assert.Equal(("done", false, "requirement"), (await One<string>("SELECT state FROM deadlines WHERE id = @d", new { d = oldRow }), await One<bool>("SELECT fired FROM deadlines WHERE id = @d", new { d = oldRow }),
            await One<string>("SELECT closed_by FROM deadlines WHERE id = @d", new { d = oldRow })));
        var chase = await One<string>("SELECT to_char(due_at AT TIME ZONE 'America/Chicago', 'YYYY-MM-DD') || '|' || what FROM deadlines WHERE requirement_id = @r AND state = 'open'", new { r = reqId });
        Assert.Equal("2026-10-08|Follow up: corrected W-9 · Diane", chase);
        Assert.Equal(1, await One<int>("SELECT count(*) FROM work_items WHERE claim_id = @c AND dedupe_key = 'not-enough:' || @d AND status = 'open'", new { c = claim.ClaimId, d = doc.ToString() }));
        // The letter, once, however often the step runs; the second call finds it sent and calls no gateway.
        Assert.True(await service.AskForCorrectionAsync(doc, wf));
        Assert.True(await service.AskForCorrectionAsync(doc, wf));
        Assert.Equal(1, await One<int>("SELECT count(*) FROM letters WHERE claim_id = @c AND template_code = 'W9-LIFE-01' AND status = 'sent' AND dedupe_key = 'document:' || @d || ':correction'", new { c = claim.ClaimId, d = doc.ToString() }));

        // The corrected W-9 is simply another document: another event; its workflow reads the requirement from Postgres and knows nothing of the first try.
        var fixedDoc = await ReceiveAsync(claim.ClaimId, Body("claimant_statement_w9", "portal", new { tin = "123-45-6798" }, new { partyId = diane }));
        var wf2 = Wf(fixedDoc);
        await BeginAsync(claim.ClaimId, fixedDoc, wf2, "run-2");
        Assert.True((await service.CheckTinAsync(fixedDoc, 1)).Match);
        Assert.True(await service.AcceptAsync(fixedDoc, [], "", wf2, "run-2"));
        Assert.Equal("accepted", await One<string>("SELECT state FROM requirements WHERE id = @r", new { r = reqId }));
        Assert.Null(await Sql.SingleOrDefaultAsync<string>("SELECT state_note FROM requirements WHERE id = @r", new { r = reqId }));
        Assert.Equal(0, await One<int>("SELECT count(*) FROM deadlines WHERE requirement_id = @r AND state = 'open'", new { r = reqId }));   // the chase closed
    }

    [PostgresFact]
    public async Task ACorrectionLetterQueuedByAFailedRunIsSkippedWithAReasonWhenARerunAcceptsTheW9AndItStaysSkipped()
    {
        var claim = await LifeScenario.GatheringAsync(fixture);
        var diane = await PartyAsync(claim.ClaimId, "Diane");
        Faults.Set(FaultCatalog.TinNoMatch, 1);
        var doc = await ReceiveAsync(claim.ClaimId, Body("claimant_statement_w9", "portal", new { tin = "123-45-6789" }, new { partyId = diane }));
        var service = fixture.Get<DocumentEventService>();
        var wf = Wf(doc);
        var key = "document:" + doc + ":correction";

        // Run 1: the IRS says "no match", the requirement is not enough, and the letter is queued but the letters service is down: the run fails.
        await BeginAsync(claim.ClaimId, doc, wf, "run-1");
        Assert.False((await service.CheckTinAsync(doc, 1)).Match);
        await service.MarkNotEnoughAsync(doc, "TIN mismatch", wf);
        Faults.Set(FaultCatalog.LettersDown, true);
        await Assert.ThrowsAsync<InvalidOperationException>(() => service.AskForCorrectionAsync(doc, wf));
        await service.RecordReceivedFailureAsync(claim.ClaimId, "The letters service returned 503", [Claims.Domain.RunStep.Failed("Ask for a corrected W-9", "503", "Letters", 5)], wf, "run-1");
        Assert.Equal("queued", await One<string>("SELECT status FROM letters WHERE dedupe_key = @k", new { k = key }));

        // Run 2 after the fault is gone: the number matches now, so the document is accepted and the queued letter is moot.
        Faults.Set(FaultCatalog.LettersDown, false);
        await BeginAsync(claim.ClaimId, doc, wf, "run-2");
        Assert.True((await service.CheckTinAsync(doc, 1)).Match);
        Assert.True(await service.AcceptAsync(doc, [], "", wf, "run-2"));

        var letter = await Sql.QuerySingleAsync("SELECT status, status_reason, sent_at, provider_message_id FROM letters WHERE dedupe_key = @k", new { k = key },
            r => (Status: r.Text("status"), Reason: r.Str("status_reason"), Sent: !r.IsNull("sent_at"), Message: r.Str("provider_message_id")));
        Assert.Equal(("skipped", false, null), (letter.Status, letter.Sent, letter.Message));
        Assert.Contains("no longer needed", letter.Reason, StringComparison.Ordinal);
        Assert.Equal(0, await One<int>("SELECT count(*) FROM letters WHERE claim_id = @c AND template_code = 'W9-LIFE-01' AND status = 'queued'", new { c = claim.ClaimId }));
        Assert.Equal(1, await One<int>("SELECT count(*) FROM history_events WHERE claim_id = @c AND title = 'Letter skipped: W9-LIFE-01 (correction no longer needed)' AND workflow_id = @w", new { c = claim.ClaimId, w = wf }));
        Assert.Contains("skipped", await One<string>("SELECT saved::text FROM workflow_runs WHERE workflow_id = @w AND run_id = 'run-2'", new { w = wf }), StringComparison.Ordinal);

        // Idempotent: skipping again changes nothing, and a late repeat of the send does not bring the letter back (no gateway call, still skipped).
        Assert.False(await fixture.Get<LetterService>().SkipIfWaitingAsync(key, "again"));
        Faults.Set(FaultCatalog.LettersDown, true);
        Assert.True(await service.AskForCorrectionAsync(doc, wf));   // would throw if it called the (down) gateway
        Faults.Set(FaultCatalog.LettersDown, false);
        Assert.Equal("skipped", await One<string>("SELECT status FROM letters WHERE dedupe_key = @k", new { k = key }));
        Assert.Equal(1, await One<int>("SELECT count(*) FROM history_events WHERE claim_id = @c AND title LIKE 'Letter skipped: W9-LIFE-01%'", new { c = claim.ClaimId }));

        // The API says so: status skipped and why.
        var listed = (await Client.GetApiAsync($"/claims/{claim.ClaimId}/letters")).Items.Single(l => l["templateCode"]!.ToString() == "W9-LIFE-01");
        Assert.Equal("skipped", listed["status"]!.ToString());
        Assert.Contains("no longer needed", listed["statusReason"]!.ToString(), StringComparison.Ordinal);
    }

    [PostgresFact]
    public async Task ASentLetterIsNeverSkippedAndALetterSentByTheRerunKeepsItsIdempotencyKey()
    {
        var claim = await LifeScenario.GatheringAsync(fixture);
        var diane = await PartyAsync(claim.ClaimId, "Diane");
        Faults.Set(FaultCatalog.TinNoMatch, 2);
        var doc = await ReceiveAsync(claim.ClaimId, Body("claimant_statement_w9", "portal", new { tin = "123-45-6789" }, new { partyId = diane }));
        var service = fixture.Get<DocumentEventService>();
        var wf = Wf(doc);
        var key = "document:" + doc + ":correction";

        // Run 1 queued the letter and failed; run 2 still gets "no match": the letter is still relevant, so it is SENT (same row, same key), not skipped.
        await BeginAsync(claim.ClaimId, doc, wf, "run-1");
        Assert.False((await service.CheckTinAsync(doc, 1)).Match);
        await service.MarkNotEnoughAsync(doc, "TIN mismatch", wf);
        Faults.Set(FaultCatalog.LettersDown, true);
        await Assert.ThrowsAsync<InvalidOperationException>(() => service.AskForCorrectionAsync(doc, wf));
        Faults.Set(FaultCatalog.LettersDown, false);
        var queuedId = await One<Guid>("SELECT id FROM letters WHERE dedupe_key = @k", new { k = key });
        await BeginAsync(claim.ClaimId, doc, wf, "run-2");
        Assert.False((await service.CheckTinAsync(doc, 1)).Match);
        await service.MarkNotEnoughAsync(doc, "TIN mismatch", wf);
        Assert.True(await service.AskForCorrectionAsync(doc, wf));
        Assert.Equal(("sent", queuedId, 1), (await One<string>("SELECT status FROM letters WHERE dedupe_key = @k", new { k = key }), await One<Guid>("SELECT id FROM letters WHERE dedupe_key = @k", new { k = key }),
            await One<int>("SELECT count(*) FROM letters WHERE claim_id = @c AND template_code = 'W9-LIFE-01'", new { c = claim.ClaimId })));

        // A later accept of the same document must not touch a letter that went out.
        Assert.False(await fixture.Get<LetterService>().SkipIfWaitingAsync(key, "too late"));
        Assert.Equal("sent", await One<string>("SELECT status FROM letters WHERE dedupe_key = @k", new { k = key }));
        Assert.Null(await Sql.SingleOrDefaultAsync<string>("SELECT status_reason FROM letters WHERE dedupe_key = @k", new { k = key }));
    }

    [PostgresFact]
    public async Task APhotocopyIsHandedToAPersonWithAWorkItemAndAReviewRowAndTheRunEnds()
    {
        var claim = await LifeScenario.GatheringAsync(fixture);
        var reqId = await RequirementAsync(claim.ClaimId, "Certified death");
        var doc = await ReceiveAsync(claim.ClaimId, Body("death_certificate", "mail_room", new { photocopy = true }));
        var service = fixture.Get<DocumentEventService>();
        var wf = Wf(doc);

        var facts = await BeginAsync(claim.ClaimId, doc, wf, "run-1");
        Assert.Equal("review", facts.Route);
        await service.HandToPersonAsync(doc, facts.Reason, [], "note", wf, "run-1");

        Assert.Equal(("under_review", "received"), (await One<string>("SELECT status FROM documents WHERE id = @d", new { d = doc }), await One<string>("SELECT state FROM requirements WHERE id = @r", new { r = reqId })));
        // Review row: 1 business day after Thu 1 Oct 11:25 is Fri 2 Oct 08:00 Central.
        Assert.Equal("2026-10-02", await One<string>("SELECT to_char(due_at AT TIME ZONE 'America/Chicago', 'YYYY-MM-DD') FROM deadlines WHERE claim_id = @c AND kind = 'document_review_by' AND document_id = @d AND state = 'open'", new { c = claim.ClaimId, d = doc }));
        var item = await Sql.QueryAsync("SELECT action, status, section, owner_id FROM work_items WHERE dedupe_key = 'review-document:' || @d", new { d = doc.ToString() },
            r => (r.Text("action"), r.Text("status"), r.Text("section"), r.GuidOrNull("owner_id")));
        Assert.Equal(("Review the death certificate", "open", "documents"), (item[0].Item1, item[0].Item2, item[0].Item3));
        Assert.Equal(await One<Guid>("SELECT id FROM staff_users WHERE handle = 'rachel'"), item[0].Item4);
        Assert.Equal("completed", await One<string>("SELECT status FROM workflow_runs WHERE workflow_id = @w", new { w = wf }));   // the workflow ENDED; nothing waits
        // The certificate's own follow-up row is still waiting (the review, not the arrival, closes it).
        Assert.Equal(1, await One<int>("SELECT count(*) FROM deadlines WHERE requirement_id = @r AND state = 'open'", new { r = reqId }));
    }

    // ------------------------------------------------------------------ the examiner's review

    private async Task<(ReadyClaim Claim, Guid Doc, Guid Req, string Version)> UnderReviewAsync()
    {
        var claim = await LifeScenario.GatheringAsync(fixture);
        var doc = await ReceiveAsync(claim.ClaimId, Body("death_certificate", "mail_room", new { photocopy = true }));
        var wf = Wf(doc);
        var facts = await BeginAsync(claim.ClaimId, doc, wf, "run-1");
        await fixture.Get<DocumentEventService>().HandToPersonAsync(doc, facts.Reason, [], "", wf, "run-1");
        var version = (await Client.GetApiAsync("/documents/" + doc)).Header("ETag")!;
        return (claim, doc, await RequirementAsync(claim.ClaimId, "Certified death"), version);
    }

    private static Dictionary<string, string> Review(string actor, string ifMatch) => new() { ["X-Actor"] = actor, ["If-Match"] = ifMatch };

    [PostgresFact]
    public async Task RejectingSavesEverythingBeforeAnyWorkflowExistsAndWritesOneOutboxEvent()
    {
        var (claim, doc, req, version) = await UnderReviewAsync();
        fixture.Clock.Set(At("2026-10-01T20:20:00Z"));   // Thu 1 Oct 15:20 Central

        var r = await Client.PostApiAsync($"/documents/{doc}:review", "{\"decision\":\"reject\",\"reason\":\"Photocopy: no raised seal\"}", Review("rachel", version));

        Assert.Equal(200, r.StatusCode);
        Assert.Equal(("rejected", "rachel"), (r.Str("status"), r.Str("reviewedBy")));
        Assert.Equal("Photocopy: no raised seal", r.Str("reviewReason"));
        // The requirement is requested again, with a NEW follow-up row 10 days out (Sun 11 Oct); the old row and the review row are closed; the work item is done.
        Assert.Equal(("requested", "Rejected: Photocopy: no raised seal"), (await One<string>("SELECT state FROM requirements WHERE id = @r", new { r = req }), await One<string>("SELECT state_note FROM requirements WHERE id = @r", new { r = req })));
        Assert.Equal("2026-10-11", await One<string>("SELECT to_char(due_at AT TIME ZONE 'America/Chicago', 'YYYY-MM-DD') FROM deadlines WHERE requirement_id = @r AND state = 'open'", new { r = req }));
        Assert.Equal(0, await One<int>("SELECT count(*) FROM deadlines WHERE claim_id = @c AND kind = 'document_review_by' AND state IN ('open', 'dispatched')", new { c = claim.ClaimId }));
        Assert.Equal("done", await One<string>("SELECT status FROM work_items WHERE dedupe_key = 'review-document:' || @d", new { d = doc.ToString() }));
        Assert.Equal(1, await One<int>("SELECT count(*) FROM outbox_events WHERE claim_id = @c AND event_type = 'document_rejected' AND published_at IS NULL AND payload->>'documentId' = @d", new { c = claim.ClaimId, d = doc.ToString() }));
        // No workflow has run and no letter has gone: they follow the commit.
        Assert.Equal(0, await One<int>("SELECT count(*) FROM letters WHERE claim_id = @c AND template_code = 'REQ-LIFE-03'", new { c = claim.ClaimId }));
        Assert.Equal(0, await One<int>("SELECT count(*) FROM workflow_runs WHERE claim_id = @c AND name = 'Certificate rejected'", new { c = claim.ClaimId }));
        // A second review of the same document is a conflict: it is no longer under review.
        var again = await Client.PostApiAsync($"/documents/{doc}:review", "{\"decision\":\"accept\"}", Review("rachel", r.Header("ETag")!));
        Assert.Equal((409, "invalid_state"), Pair(again));
    }

    [PostgresFact]
    public async Task AcceptingAfterReviewAcceptsTheRequirementThroughTheNormalPathAndClosesTheReviewRow()
    {
        var (claim, doc, req, version) = await UnderReviewAsync();

        var r = await Client.PostApiAsync($"/documents/{doc}:review", "{\"decision\":\"accept\",\"reason\":\"Seal is there on the original\"}", Review("rachel", version));

        Assert.Equal(200, r.StatusCode);
        Assert.Equal("accepted", r.Str("status"));
        Assert.Equal("accepted", await One<string>("SELECT state FROM requirements WHERE id = @r", new { r = req }));
        Assert.Equal(0, await One<int>("SELECT count(*) FROM deadlines WHERE claim_id = @c AND (kind = 'document_review_by' OR requirement_id = @r) AND state IN ('open', 'dispatched')", new { c = claim.ClaimId, r = req }));
        Assert.Equal(0, await One<int>("SELECT count(*) FROM outbox_events WHERE claim_id = @c AND event_type = 'document_rejected'", new { c = claim.ClaimId }));   // nothing outside Postgres to call: no event
    }

    [PostgresFact]
    public async Task ReviewGuardsWrongVersionWrongStateWrongActorMissingReasonAndMissingHeaders()
    {
        var (claim, doc, req, version) = await UnderReviewAsync();
        var path = $"/documents/{doc}:review";
        var client = Client;

        Assert.Equal((412, "version_conflict"), Pair(await client.PostApiAsync(path, "{\"decision\":\"accept\"}", Review("rachel", "\"999\""))));
        Assert.Equal((403, "unknown_actor"), Pair(await client.PostApiAsync(path, "{\"decision\":\"accept\"}", Review("nobody", version))));
        Assert.Equal((422, "reason_required"), Pair(await client.PostApiAsync(path, "{\"decision\":\"reject\"}", Review("rachel", version))));
        Assert.Equal((422, "validation_failed"), Pair(await client.PostApiAsync(path, "{\"decision\":\"maybe\"}", Review("rachel", version))));
        Assert.Equal((428, "precondition_required"), Pair(await client.PostApiAsync(path, "{\"decision\":\"accept\"}", new Dictionary<string, string> { ["X-Actor"] = "rachel" })));
        Assert.Equal((400, "missing_header"), Pair(await client.PostApiAsync(path, "{\"decision\":\"accept\"}", new Dictionary<string, string> { ["If-Match"] = version })));
        Assert.Equal(404, (await client.PostApiAsync($"/documents/{Guid.NewGuid()}:review", "{\"decision\":\"accept\"}", Review("rachel", version))).StatusCode);
        // A document that is not under review cannot be reviewed.
        var received = await ReceiveAsync(claim.ClaimId, Body("claimant_statement_w9", "portal", new { tin = "123456789" }, new { partyId = await PartyAsync(claim.ClaimId, "Diane") }));
        var v = (await client.GetApiAsync("/documents/" + received)).Header("ETag")!;
        Assert.Equal((409, "invalid_state"), Pair(await client.PostApiAsync($"/documents/{received}:review", "{\"decision\":\"accept\"}", Review("rachel", v))));
        Assert.Equal("requested", await One<string>("SELECT state FROM requirements WHERE id = @r", new { r = await RequirementAsync(claim.ClaimId, "Diane") }));
        _ = req;
    }

    // ------------------------------------------------------------------ the letter: exactly once

    [PostgresFact]
    public async Task TheCertifiedCopyLetterFailsWhileTheLettersServiceIsDownThenGoesExactlyOnceWhateverRunSendsIt()
    {
        var (claim, doc, _, version) = await UnderReviewAsync();
        await Client.PostApiAsync($"/documents/{doc}:review", "{\"decision\":\"reject\",\"reason\":\"Photocopy\"}", Review("rachel", version));
        var service = fixture.Get<DocumentEventService>();
        Faults.Set(FaultCatalog.LettersDown, true);

        // Down: every attempt throws (the workflow's retries run out); the letter row is queued, never sent.
        for (var i = 0; i < 3; i++)
            await Assert.ThrowsAsync<InvalidOperationException>(() => service.SendCertifiedCopyLetterAsync(doc, "event-x"));
        Assert.Equal(("queued", 1), (await One<string>("SELECT status FROM letters WHERE dedupe_key = 'document:' || @d || ':rejected'", new { d = doc.ToString() }),
            await One<int>("SELECT count(*) FROM letters WHERE claim_id = @c AND template_code = 'REQ-LIFE-03'", new { c = claim.ClaimId })));

        // Back up: run 1 and run 2 (different Temporal runs, the same workflow id) both send; the claimant gets one.
        Faults.Set(FaultCatalog.LettersDown, false);
        Assert.True(await service.SendCertifiedCopyLetterAsync(doc, "event-x"));
        Assert.True(await service.SendCertifiedCopyLetterAsync(doc, "event-x"));
        Assert.Equal(("sent", 1), (await One<string>("SELECT status FROM letters WHERE dedupe_key = 'document:' || @d || ':rejected'", new { d = doc.ToString() }),
            await One<int>("SELECT count(*) FROM letters WHERE claim_id = @c AND template_code = 'REQ-LIFE-03'", new { c = claim.ClaimId })));
    }

    [PostgresFact]
    public async Task ARunThatFailedIsRecordedWithItsNoteAndAnOpsTaskAndARerunClosesTheTaskAndIsLinkedToIt()
    {
        var (claim, doc, _, version) = await UnderReviewAsync();
        await Client.PostApiAsync($"/documents/{doc}:review", "{\"decision\":\"reject\",\"reason\":\"Photocopy\"}", Review("rachel", version));
        var service = fixture.Get<DocumentEventService>();
        var wf = "event-rerun-" + doc;

        // Run 1: begins, fails (its retries ran out).
        await service.BeginRejectedAsync(claim.ClaimId, doc, Guid.NewGuid(), wf, "temporal-run-1");
        await service.RecordRejectedFailureAsync(claim.ClaimId, "The letters service returned 503 (fault letters.down)",
            [Claims.Domain.RunStep.Failed("Send it", "503", "Letters service", 5)], wf, "temporal-run-1");
        var failed = await Sql.QueryAsync("SELECT id, status, run_no, note, error, elapsed_ms FROM workflow_runs WHERE workflow_id = @w", new { w = wf },
            r => (Id: r.Guid("id"), Status: r.Text("status"), RunNo: r.Int("run_no"), Note: r.Str("note"), Error: r.Str("error"), Took: r.IsNull("elapsed_ms")));
        Assert.Equal(("failed", 1), (failed[0].Status, failed[0].RunNo));
        Assert.Contains("5 times, waiting 2, 4, 8 and 16 s", failed[0].Note, StringComparison.Ordinal);
        Assert.Contains("503", failed[0].Error, StringComparison.Ordinal);
        Assert.Equal(1, await One<int>("SELECT count(*) FROM work_items WHERE dedupe_key = 'workflow-failed:' || @w AND status = 'open' AND owner_id IS NULL", new { w = wf }));

        // Run 2 under the same workflow id: linked to run 1, sends the letter, closes the ops task.
        await service.BeginRejectedAsync(claim.ClaimId, doc, Guid.NewGuid(), wf, "temporal-run-2");
        Assert.True(await service.SendCertifiedCopyLetterAsync(doc, wf));
        await service.CompleteRejectedAsync(doc, [Claims.Domain.RunStep.Done("Send it", "ok", "Letters service")], wf, "temporal-run-2");
        var second = await Sql.QueryAsync("SELECT status, run_no, rerun_of_id, note FROM workflow_runs WHERE workflow_id = @w AND run_id = 'temporal-run-2'", new { w = wf },
            r => (Status: r.Text("status"), RunNo: r.Int("run_no"), Of: r.GuidOrNull("rerun_of_id"), Note: r.Str("note")));
        Assert.Equal(("completed", 2, failed[0].Id), (second[0].Status, second[0].RunNo, second[0].Of));
        Assert.Contains("ALLOW_DUPLICATE_FAILED_ONLY", second[0].Note, StringComparison.Ordinal);
        Assert.Equal("done", await One<string>("SELECT status FROM work_items WHERE dedupe_key = 'workflow-failed:' || @w", new { w = wf }));

        // The run list says which run can still be re-run: none, now that the latest run completed; and the failed one is no longer the latest.
        var runs = (await Client.GetApiAsync($"/claims/{claim.ClaimId}/workflow-runs")).Items.Where(x => x["workflowId"]!.ToString() == wf).ToList();
        Assert.Equal([false, false], runs.Select(x => x["canRerun"]!.GetValue<bool>()));
        Assert.Equal([1, 2], runs.Select(x => x["runNo"]!.GetValue<int>()));
    }
}
