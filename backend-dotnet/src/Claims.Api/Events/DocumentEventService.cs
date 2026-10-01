using System.Globalization;
using System.Text.Json.Nodes;
using Claims.Clock;
using Claims.Common;
using Claims.Documents;
using Claims.Domain;
using Claims.Gateway;
using Claims.Intake;
using Claims.Requirement;
using Claims.Store;
using static Claims.Store.DeadlineRepository;
using static Claims.Store.LetterRepository;

namespace Claims.Events;

/// <summary>
/// The database work of the two short workflows about a document: <c>DocumentReceivedWorkflow</c> (started by the outbox event `document_received`) and
/// <c>DocumentRejectedWorkflow</c> (started by `document_rejected`, after the examiner's review was saved). Every method is safe to repeat: state changes are
/// compare-and-set or keyed, letters go through <see cref="LetterService.SendOnceAsync"/> with a dedupe key, and Begin / Finish of the run record are idempotent.
///
/// The IRS check is the one place a NEGATIVE answer is not a failure: <see cref="CheckTinAsync"/> returns "no match" as data, and only an exception (a 503) makes
/// Temporal retry.
/// </summary>
public sealed class DocumentEventService(Db db, IClock clock, BusinessCalendar calendar, DocumentRepository documents, RequirementRepository requirements,
                                         RequirementService requirementService, DeadlineRepository deadlines, HistoryRepository history, WorkItemRepository workItems,
                                         WorkflowRunRepository runs, LetterService letters, ITinMatchGateway tin, WorkflowFailureRecorder failures)
{
    public const int CorrectionFollowUpDays = 7;

    public sealed record Facts(Guid ClaimId, string ClaimNumber, string Kind, string Source, string Route, string Reason, string? RequirementName, string? PartyName,
                               int RunNo);

    public sealed record TinCheck(bool Match, string Reference, string Detail, int Attempts);

    public sealed record NotEnough(Guid? PartyId, string PartyName, string CorrectionDue);

    // ------------------------------------------------------------------ document received

    public async Task<Facts> BeginReceivedAsync(Guid claimId, Guid documentId, Guid eventId, string workflowId, string runRecordId)
    {
        await runs.BeginAsync(workflowId, runRecordId, "event", "Document received", claimId, "Outbox relay · event " + eventId + " (document saved)", "outbox_event", eventId, clock.UtcNow);
        var run = await runs.FindAsync(workflowId, runRecordId);
        if (run is { RunNo: > 1 })
            await runs.AppendNoteAsync(workflowId, runRecordId, RerunNote(workflowId, run.RunNo));
        var d = await documents.FindAsync(documentId) ?? throw new InvalidOperationException($"Document {documentId} does not exist");
        var attrs = JsonNode.Parse(d.AttributesJson)!.AsObject();
        var (route, reason) = DocumentRules.RouteFor(d.Kind, attrs["photocopy"]?.GetValue<bool>(), attrs["sealPresent"]?.GetValue<bool>());
        var number = await db.SingleAsync<string>("SELECT claim_number FROM claims WHERE id = @c", new { c = claimId });
        var req = d.RequirementId is null ? null : await requirements.FindAsync(d.RequirementId.Value);
        var party = d.PartyId is null ? null : await db.SingleOrDefaultAsync<string>("SELECT full_name FROM parties WHERE id = @p", new { p = d.PartyId });
        return new Facts(claimId, number, d.Kind, d.Source, route, reason, req?.Name, party, run?.RunNo ?? 1);
    }

    /// <summary>Asks the IRS. "No match" is returned as an answer; only a failure to reach the service is an exception.</summary>
    public async Task<TinCheck> CheckTinAsync(Guid documentId, int attempt)
    {
        var d = await documents.FindAsync(documentId) ?? throw new InvalidOperationException($"Document {documentId} does not exist");
        var name = d.PartyId is null ? "" : await db.SingleOrDefaultAsync<string>("SELECT full_name FROM parties WHERE id = @p", new { p = d.PartyId }) ?? "";
        var attrs = JsonNode.Parse(d.AttributesJson)!.AsObject();
        var answer = await tin.CheckAsync(name, attrs["tin"]?.GetValue<string>());
        return new TinCheck(answer.Match, answer.Reference, answer.Detail, attempt);
    }

    /// <summary>The rules (or a matching TIN) accept it: the document and the requirement, in one transaction, then the run is finished. The normal accept path.</summary>
    public Task<bool> AcceptAsync(Guid documentId, IReadOnlyList<RunStep> steps, string note, string workflowId, string runRecordId) => db.InTransactionAsync(async () =>
    {
        var now = clock.UtcNow;
        var d = await documents.FindAsync(documentId) ?? throw new InvalidOperationException($"Document {documentId} does not exist");
        var changed = await documents.SetStatusAsync(documentId, ["received", "not_enough", "under_review"], "accepted", "Accepted by the rules");
        var accepted = false;
        var proofBefore = await db.SingleAsync<string>("SELECT status FROM claims WHERE id = @c", new { c = d.ClaimId });
        if (d.RequirementId is { } rid)
            accepted = await requirementService.AcceptFromDocumentAsync(rid, $"{DocumentRules.Title(d.Kind)} received by {d.Source.Replace('_', ' ')}: accepted by the rules", Actor.Workflow(workflowId));
        var proofAfter = await db.SingleAsync<string>("SELECT status FROM claims WHERE id = @c", new { c = d.ClaimId });
        await history.AppendAsync(d.ClaimId, now, "document", "Accepted: " + DocumentRules.Title(d.Kind), Actor.Workflow(workflowId),
            accepted ? "Classified, checked and accepted; the requirement is met" : "Accepted (the requirement was already met)", DocumentRules.Title(d.Kind), workflowId);
        var saved = new List<string> { changed ? "Document accepted" : "Document already decided", accepted ? "Requirement accepted · its follow-up rows closed" : "Requirement was already met" };
        // A re-run (or any later accept) after an earlier run queued "please correct your W-9" that never went out: the situation changed, so that letter is moot.
        // Skipped with a reason, never left queued. Keyed like the send, so a repeat of this step changes nothing.
        if (await letters.SkipIfWaitingAsync(CorrectionLetterKey(documentId), CorrectionLetterSkipReason))
        {
            await history.AppendAsync(d.ClaimId, now, "communication", "Letter skipped: W9-LIFE-01 (correction no longer needed)", Actor.Workflow(workflowId),
                CorrectionLetterSkipReason, null, workflowId);
            saved.Add("Queued correction letter (W9-LIFE-01) skipped · no longer needed");
        }
        if (proofBefore != "in_review" && proofAfter == "in_review") saved.Add("Proof of loss complete · decision rows written · status in_review");
        await runs.FinishAsync(workflowId, runRecordId, "completed", steps, saved, null, now, note);
        return accepted;
    });

    /// <summary>
    /// The IRS said "no match". One transaction saves that: the document is `not_enough`, the requirement `not_enough` ("TIN mismatch"), the follow-up row that was
    /// waiting closes, a correction follow-up row (7 days) is written, and the examiner gets a work item. The letter to the claimant is the next step.
    /// </summary>
    public Task<NotEnough> MarkNotEnoughAsync(Guid documentId, string reason, string workflowId) => db.InTransactionAsync(async () =>
    {
        var now = clock.UtcNow;
        var d = await documents.FindAsync(documentId) ?? throw new InvalidOperationException($"Document {documentId} does not exist");
        var req = d.RequirementId is null ? null : await requirements.LockAsync(d.RequirementId.Value);
        var partyName = d.PartyId is null ? "the claimant" : await db.SingleAsync<string>("SELECT full_name FROM parties WHERE id = @p", new { p = d.PartyId });
        var first = LifeIntakeRules.First(partyName);
        await documents.SetStatusAsync(documentId, ["received", "not_enough"], "not_enough", reason);
        var dueAt = calendar.DaysAfter(now, CorrectionFollowUpDays);
        var closedIds = new List<Guid>();
        Guid? chase = null;
        if (req is not null && !req.State.Met())
        {
            closedIds = await deadlines.CloseLiveFollowUpsAsync(req.Id, $"Closed: it arrived {LocalDate(now)}, but the {reason}; a correction follow-up follows", now);
            await requirements.SetStateAsync(req.Id, "not_enough", reason, now);
            chase = await deadlines.InsertAsync(new NewDeadline(d.ClaimId, DeadlineKind.RequirementFollowUp, req.Id, $"Follow up: corrected W-9 · {first}", null, dueAt));
        }
        var owner = await db.SingleOrDefaultAsync<Guid?>("SELECT owner_id FROM claims WHERE id = @c", new { c = d.ClaimId });
        await workItems.InsertOnceAsync("not-enough:" + documentId, owner, d.ClaimId, 2, $"Corrected W-9 needed: {partyName}", $"{reason} · a correction is due {Iso(calendar.LocalDate(dueAt))}",
            calendar.LocalDate(dueAt), partyName, "requirements", "workflow", null);
        await history.AppendAsync(d.ClaimId, now, "data", $"Not enough: {req?.Name ?? DocumentRules.Title(d.Kind)}: {reason}", Actor.Workflow(workflowId),
            $"{closedIds.Count} follow-up row closed · a correction follow-up is due {Iso(calendar.LocalDate(dueAt))}" + (chase is null ? "" : $" ({chase})"), req?.Name, workflowId);
        return new NotEnough(d.PartyId, partyName, Iso(calendar.LocalDate(dueAt)));
    });

    /// <summary>W9-LIFE-01 to the claimant, once per document.</summary>
    public async Task<bool> AskForCorrectionAsync(Guid documentId, string workflowId)
    {
        var d = await documents.FindAsync(documentId) ?? throw new InvalidOperationException($"Document {documentId} does not exist");
        if (d.PartyId is null) return false;
        var name = await db.SingleAsync<string>("SELECT full_name FROM parties WHERE id = @p", new { p = d.PartyId });
        await letters.SendOnceAsync(new NewLetter(d.ClaimId, "W9-LIFE-01", "email", d.PartyId, name, "Please correct your W-9 · " + LifeIntakeRules.First(name),
            "The name and taxpayer number on your W-9 do not match IRS records. Please check the number and upload a corrected W-9 in the portal.", "outbox_event", null, workflowId,
            CorrectionLetterKey(documentId)), name);
        return true;
    }

    /// <summary>Finishes the run of a document that was not enough (the state was saved by <see cref="MarkNotEnoughAsync"/>, the letter has gone).</summary>
    public Task CompleteNotEnoughAsync(Guid documentId, IReadOnlyList<RunStep> steps, string note, string workflowId, string runRecordId) => db.InTransactionAsync(async () =>
    {
        var now = clock.UtcNow;
        var d = await documents.FindAsync(documentId) ?? throw new InvalidOperationException($"Document {documentId} does not exist");
        await history.AppendAsync(d.ClaimId, now, "communication", "Correction asked for: W9-LIFE-01", Actor.Workflow(workflowId), null, null, workflowId);
        await runs.FinishAsync(workflowId, runRecordId, "completed", steps,
            ["Document marked not enough · TIN mismatch", "Follow-up row closed · a correction follow-up written", "Work item for the examiner", "Correction request in Communications"], null, now, note);
    });

    /// <summary>
    /// The rules cannot accept it: hand it to a person and END the workflow. One transaction: the document `under_review`, the requirement `received` (under review),
    /// a `document_review_by` row (1 business day), a work item for the examiner, history, and the run finished. Nothing waits for the person.
    /// </summary>
    public Task HandToPersonAsync(Guid documentId, string reason, IReadOnlyList<RunStep> steps, string note, string workflowId, string runRecordId) => db.InTransactionAsync(async () =>
    {
        var now = clock.UtcNow;
        var d = await documents.FindAsync(documentId) ?? throw new InvalidOperationException($"Document {documentId} does not exist");
        var req = d.RequirementId is null ? null : await requirements.LockAsync(d.RequirementId.Value);
        var owner = await db.SingleOrDefaultAsync<Guid?>("SELECT owner_id FROM claims WHERE id = @c", new { c = d.ClaimId });
        var moved = await documents.SetStatusAsync(documentId, ["received"], "under_review", reason);
        Guid? row = null;
        var dueAt = calendar.BusinessDaysAfter(now, DocumentService.ReviewBusinessDays);
        if (moved)
        {
            if (req is not null && !req.State.Met()) await requirements.SetStateAsync(req.Id, "received", "Under review: " + reason, now);
            row = await deadlines.InsertAsync(new NewDeadline(d.ClaimId, DeadlineKind.DocumentReviewBy, null, "Examiner reviews the " + DocumentRules.Title(d.Kind).ToLowerInvariant() + " the rules couldn't accept",
                "docReview", dueAt, documentId, d.PartyId));
            await workItems.InsertOnceAsync("review-document:" + documentId, owner, d.ClaimId, 1, "Review the " + DocumentRules.Title(d.Kind).ToLowerInvariant(),
                $"{reason} · review by {Iso(calendar.LocalDate(dueAt))}", calendar.LocalDate(dueAt), "You", "documents", "workflow", null);
            await history.AppendAsync(d.ClaimId, now, "document", "Needs review: " + DocumentRules.Title(d.Kind), Actor.Workflow(workflowId),
                reason + $" · a review row is due {Iso(calendar.LocalDate(dueAt))}", DocumentRules.Title(d.Kind), workflowId);
        }
        await runs.FinishAsync(workflowId, runRecordId, "completed", steps,
            [moved ? "Document needs review" : "Document already decided", req is null ? "No requirement to update" : "Requirement received · under review",
             row is null ? "No new review row" : "Review row written: review by " + Iso(calendar.LocalDate(dueAt)), "Work item for the examiner"], null, now, note);
    });

    public Task RecordReceivedFailureAsync(Guid claimId, string error, IReadOnlyList<RunStep> steps, string workflowId, string runRecordId) =>
        failures.RecordAsync(claimId, workflowId, runRecordId, "Document handling", error, steps);

    // ------------------------------------------------------------------ document rejected (the letter)

    public sealed record RejectedFacts(Guid ClaimId, string ClaimNumber, string Claimant, string RequirementName, string Reason, int RunNo);

    public async Task<RejectedFacts> BeginRejectedAsync(Guid claimId, Guid documentId, Guid eventId, string workflowId, string runRecordId)
    {
        await runs.BeginAsync(workflowId, runRecordId, "event", "Certificate rejected", claimId, "Outbox relay · event " + eventId + " (review saved)", "outbox_event", eventId, clock.UtcNow);
        var run = await runs.FindAsync(workflowId, runRecordId);
        if (run is { RunNo: > 1 })
            await runs.AppendNoteAsync(workflowId, runRecordId, RerunNote(workflowId, run.RunNo));
        var f = await LoadRejectedAsync(documentId);
        return f with { RunNo = run?.RunNo ?? 1 };
    }

    private async Task<RejectedFacts> LoadRejectedAsync(Guid documentId)
    {
        var d = await documents.FindAsync(documentId) ?? throw new InvalidOperationException($"Document {documentId} does not exist");
        var head = await db.QuerySingleAsync("""
            SELECT c.claim_number, d.review_reason, r.name AS requirement_name, COALESCE(rp.full_name, cp.full_name) AS claimant
            FROM documents d JOIN claims c ON c.id = d.claim_id JOIN life_claim_details l ON l.claim_id = c.id JOIN parties cp ON cp.id = l.caller_party_id
            LEFT JOIN requirements r ON r.id = d.requirement_id LEFT JOIN parties rp ON rp.id = r.from_party_id
            WHERE d.id = @d
            """, new { d = documentId }, x => (Number: x.Text("claim_number"), Reason: x.Str("review_reason"), Req: x.Str("requirement_name"), Claimant: x.Text("claimant")));
        return new RejectedFacts(d.ClaimId, head.Number, head.Claimant, head.Req ?? DocumentRules.Title(d.Kind), head.Reason ?? "", 1);
    }

    /// <summary>REQ-LIFE-03 "certified copy needed", once per document (the dedupe key belongs to the document, so a re-run of the workflow sends nothing twice).</summary>
    public async Task<bool> SendCertifiedCopyLetterAsync(Guid documentId, string workflowId)
    {
        var d = await documents.FindAsync(documentId) ?? throw new InvalidOperationException($"Document {documentId} does not exist");
        var f = await LoadRejectedAsync(documentId);
        var partyId = await db.SingleOrDefaultAsync<Guid?>(
            "SELECT COALESCE(r.from_party_id, l.caller_party_id) FROM documents d JOIN life_claim_details l ON l.claim_id = d.claim_id LEFT JOIN requirements r ON r.id = d.requirement_id WHERE d.id = @d",
            new { d = documentId });
        await letters.SendOnceAsync(new NewLetter(d.ClaimId, "REQ-LIFE-03", "letter", partyId, f.Claimant, "Certified copy needed · " + LifeIntakeRules.First(f.Claimant),
            "A photocopy can't be accepted. Please send a certified copy: the funeral home or the county vital records office can order one." + (string.IsNullOrWhiteSpace(f.Reason) ? "" : " (" + f.Reason + ")"),
            "outbox_event", null, workflowId, "document:" + documentId + ":rejected"), f.Claimant);
        return true;
    }

    /// <summary>The letter has gone: the history line, the ops task the failure of an earlier run opened is closed, and the run is finished.</summary>
    public Task CompleteRejectedAsync(Guid documentId, IReadOnlyList<RunStep> steps, string workflowId, string runRecordId) => db.InTransactionAsync(async () =>
    {
        var now = clock.UtcNow;
        var d = await documents.FindAsync(documentId) ?? throw new InvalidOperationException($"Document {documentId} does not exist");
        var reran = await workItems.CompleteByKeyAsync("workflow-failed:" + workflowId, now);
        await history.AppendAsync(d.ClaimId, now, "communication", "Letter sent: certified copy needed (REQ-LIFE-03)", Actor.Workflow(workflowId),
            reran ? "Sent by a re-run of " + workflowId + " with the same idempotency key" : null, null, workflowId);
        await runs.FinishAsync(workflowId, runRecordId, "completed", steps, ["Letter marked sent", reran ? "Ops task closed" : "No ops task was open"], null, now);
    });

    public Task RecordRejectedFailureAsync(Guid claimId, string error, IReadOnlyList<RunStep> steps, string workflowId, string runRecordId) =>
        failures.RecordAsync(claimId, workflowId, runRecordId, "The certified-copy letter", error, steps);

    // ------------------------------------------------------------------ helpers

    internal static string CorrectionLetterKey(Guid documentId) => "document:" + documentId + ":correction";

    internal const string CorrectionLetterSkipReason = "The W-9 was accepted after the letter was queued (a re-run of the workflow found the taxpayer number matching), so a correction is no longer needed";

    internal static string RerunNote(string workflowId, int runNo) =>
        $"This is run {runNo} of {workflowId}. Workflows start with the ID-reuse policy ALLOW_DUPLICATE_FAILED_ONLY: an ID cannot start again while a run is open or after it completed, " +
        $"but run {runNo - 1} failed, so an operator could start this one under the same ID: still one workflow per event. Everything it sends carries the same idempotency key as before, so nobody gets a letter twice.";

    private string LocalDate(DateTimeOffset at) => calendar.LocalDate(at).ToString("d MMM", CultureInfo.InvariantCulture);

    private static string Iso(DateOnly d) => d.ToString("yyyy-MM-dd", CultureInfo.InvariantCulture);
}
