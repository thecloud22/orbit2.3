using System.Globalization;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;
using Claims.Clock;
using Claims.Common;
using Claims.Domain;
using Claims.Intake;
using Claims.Requirement;
using Claims.Store;
using Claims.View;
using static Claims.Store.DeadlineRepository;

namespace Claims.Documents;

/// <summary>What the caller of POST /claims/{id}/documents sent, after JSON parsing and before validation.</summary>
public sealed record DocumentAttributes(string? Tin, bool? Photocopy, bool? SealPresent);

public sealed record ReceiveDocumentRequest(Guid? RequirementId, string? RequirementKey, Guid? PartyId, string? Kind, string? Source, DateTimeOffset? ReceivedAt,
                                            DocumentAttributes? Attributes);

/// <summary>
/// A document arriving, and the examiner's review of one the rules could not accept. Postgres only: nothing here calls an outside system, so no workflow runs
/// inside the request. What follows a change is a short event workflow, started by the outbox event that is saved in the same transaction:
///
///   receive  document row + outbox `document_received` + history + idempotency key. (The workflow reads it: the IRS check, the rules, the hand-off.)
///   accept   (a review) document accepted, requirement accepted through the normal accept path, review row and work item closed. No event: nothing to call.
///   reject   (a review) document rejected, requirement `requested` again with a new follow-up row, review row and old follow-up closed, the examiner's work item
///            closed, outbox `document_rejected` (the workflow sends the "certified copy needed" letter).
/// </summary>
public sealed class DocumentService(Db db, IClock clock, BusinessCalendar calendar, DocumentRepository documents, RequirementRepository requirements,
                                    RequirementService requirementService, DeadlineRepository deadlines, HistoryRepository history, WorkItemRepository workItems,
                                    OutboxRepository outbox, IdempotencyRepository keys, StaffRepository staff, ClaimQueries queries)
{
    public sealed record Outcome(DocumentView Document, bool Replayed);

    private sealed record ClaimHead(string Status, string Number);

    public const int ReviewBusinessDays = 1;
    public const int RejectedFollowUpDays = 10;

    private static readonly string[] Kinds = ["claimant_statement_w9", "death_certificate", "police_report", "other"];
    private static readonly string[] Sources = ["portal", "mail_room", "upload"];

    // ------------------------------------------------------------------ receive

    public async Task<Outcome> ReceiveAsync(Guid claimId, ReceiveDocumentRequest r, string idempotencyKey, string actorName)
    {
        var errors = new List<FieldError>();
        if (string.IsNullOrWhiteSpace(r.Kind)) errors.Add(new FieldError("kind", "must not be blank"));
        else if (!Kinds.Contains(r.Kind)) errors.Add(new FieldError("kind", "must be claimant_statement_w9, death_certificate, police_report or other"));
        if (string.IsNullOrWhiteSpace(r.Source)) errors.Add(new FieldError("source", "must not be blank"));
        else if (!Sources.Contains(r.Source)) errors.Add(new FieldError("source", "must be portal, mail_room or upload"));
        if (r.RequirementKey is not null && r.RequirementKey is not ("certificate" or "statement" or "primary_died_first" or "report" or "amended_certificate"))
            errors.Add(new FieldError("requirementKey", "must be certificate, statement, primary_died_first, report or amended_certificate"));
        if (r.Attributes?.Tin is { } tin && tin.Any(c => !char.IsAsciiDigit(c) && c != '-' && c != ' '))
            errors.Add(new FieldError("attributes.tin", "may contain only digits and dashes"));
        if (errors.Count > 0) throw new ApiException(422, "validation_failed", "The request is well formed but not valid", errors);
        if (idempotencyKey.Length is < 8 or > 128) throw ApiException.BadRequest("invalid_idempotency_key", "Idempotency-Key must be 8 to 128 characters");

        return await db.InTransactionAsync(async () =>
        {
            var scope = "document:" + actorName;
            var hash = Hash(claimId, r);
            await keys.LockAsync(scope, idempotencyKey);
            if (await keys.FindAsync(scope, idempotencyKey) is { } seen)
            {
                if (seen.Hash != hash) throw ApiException.Conflict("idempotency_key_reuse", "This Idempotency-Key was already used with a different request body");
                return new Outcome((await queries.DocumentAsync(seen.ResourceId!.Value))!, true);
            }

            var claim = await db.QueryOptionalAsync("SELECT status, claim_number FROM claims WHERE id = @c", new { c = claimId }, x => new ClaimHead(x.Text("status"), x.Text("claim_number")))
                ?? throw ApiException.NotFound("Claim", claimId);
            if (claim.Status == "closed") throw ApiException.Conflict("claim_closed", "The claim is closed; a document cannot be added to it");
            var requirement = await ResolveRequirementAsync(claimId, r);
            if (requirement is { State: RequirementState.Accepted or RequirementState.Waived or RequirementState.Expired })
                throw ApiException.Conflict("requirement_already_met", $"The requirement \"{requirement.Name}\" is already {requirement.State.Db()}");

            var now = clock.UtcNow;
            var attrs = new JsonObject();
            if (!string.IsNullOrWhiteSpace(r.Attributes?.Tin)) attrs["tin"] = r.Attributes!.Tin!.Trim();
            if (r.Attributes?.Photocopy is { } pc) attrs["photocopy"] = pc;
            if (r.Attributes?.SealPresent is { } sp) attrs["sealPresent"] = sp;
            var partyId = r.PartyId ?? requirement?.FromPartyId;
            var receivedAt = r.ReceivedAt?.ToUniversalTime() ?? now;
            var id = await documents.InsertAsync(claimId, requirement?.Id, partyId, r.Kind!, r.Source!, attrs.ToJsonString(), receivedAt, actorName);
            var eventId = await outbox.InsertAsync(claimId, "document_received", Json.Serialize(new
            {
                claimId = claimId.ToString(),
                claimNumber = claim.Number,
                documentId = id.ToString(),
                kind = r.Kind,
                requirementId = requirement?.Id.ToString(),
            }));
            await documents.SetOutboxEventAsync(id, eventId);
            await keys.InsertAsync(scope, idempotencyKey, hash, claimId, id);
            var actor = r.Source == "portal" ? new Actor("portal", actorName) : Actor.User(actorName);
            await history.AppendAsync(claimId, receivedAt, "document", "Received: " + DocumentRules.Title(r.Kind!), actor,
                $"By {r.Source!.Replace('_', ' ')}" + (requirement is null ? "" : " · for " + requirement.Name), DocumentRules.Title(r.Kind!), null);
            return new Outcome((await queries.DocumentAsync(id))!, false);
        });
    }

    /// <summary>The requirement a document is for: named by id, or by key (and the payee for a statement), or the one its kind usually satisfies.</summary>
    private async Task<RequirementRepository.Row?> ResolveRequirementAsync(Guid claimId, ReceiveDocumentRequest r)
    {
        if (r.RequirementId is { } rid)
        {
            var one = await requirements.FindAsync(rid);
            return one is not null && one.ClaimId == claimId ? one : throw ApiException.Unprocessable("requirement_not_found", "The requirement is not on this claim");
        }
        var key = r.RequirementKey ?? DocumentRules.DefaultRequirementKey(r.Kind!);
        if (key is null) return null;   // a document of another kind, for no requirement in particular: the examiner decides
        var all = await requirements.ForClaimAsync(claimId);
        var matches = all.Where(x => x.Key == key && (r.PartyId is null || x.FromPartyId == r.PartyId)).ToList();
        if (matches.Count == 0) throw ApiException.Unprocessable("requirement_not_found", $"The claim has no \"{key}\" requirement" + (r.PartyId is null ? "" : " for that person"));
        // Several statements (one per payee): a statement without the payee named is ambiguous unless only one is still open.
        if (matches.Count > 1)
        {
            var open = matches.Where(x => !x.State.Met()).ToList();
            if (open.Count == 1) return open[0];
            throw ApiException.Unprocessable("requirement_ambiguous", $"The claim has {matches.Count} \"{key}\" requirements: say whose it is with partyId, or give requirementId");
        }
        return matches[0];
    }

    // ------------------------------------------------------------------ review

    public async Task<DocumentView> ReviewAsync(Guid id, long ifMatch, string? decision, string? reason, string actorHandle)
    {
        var errors = new List<FieldError>();
        if (decision is not ("accept" or "reject")) errors.Add(new FieldError("decision", "must be accept or reject"));
        if (errors.Count > 0) throw new ApiException(422, "validation_failed", "The request is well formed but not valid", errors);
        if (decision == "reject" && string.IsNullOrWhiteSpace(reason)) throw ApiException.Unprocessable("reason_required", "Rejecting a document needs a reason");
        var reviewer = await staff.FindActiveByHandleAsync(actorHandle) ?? throw new ApiException(403, "unknown_actor", $"X-Actor '{actorHandle}' is not an active staff user");
        if (reviewer.Role is not ("life_examiner" or "team_lead"))
            throw new ApiException(403, "not_permitted", $"{reviewer.DisplayName} ({reviewer.Role}) does not review life claim documents");

        return await db.InTransactionAsync(async () =>
        {
            var d = await documents.LockAsync(id) ?? throw ApiException.NotFound("Document", id);
            if (d.Version != ifMatch) throw ApiException.VersionConflict("Document " + id);
            if (d.Status != "under_review") throw ApiException.Conflict("invalid_state", $"Only a document under review can be reviewed; this one is {d.Status}");
            var now = clock.UtcNow;
            var actor = Actor.User(reviewer.Handle);
            var trimmed = reason?.Trim();
            var requirement = d.RequirementId is null ? null : await requirements.LockAsync(d.RequirementId.Value);   // lock order: requirement first, then its deadline rows
            var review = await deadlines.CloseLiveForDocumentAsync(id, $"Closed: {reviewer.DisplayName} reviewed it at {Local(now)}", now);
            await workItems.CompleteByKeyAsync("review-document:" + id, now);

            if (decision == "accept")
            {
                await documents.ReviewAsync(id, "accepted", "Accepted by " + reviewer.DisplayName, reviewer.Handle, trimmed, now);
                if (requirement is not null)
                    await requirementService.AcceptFromDocumentAsync(requirement.Id, $"{DocumentRules.Title(d.Kind)} accepted by {reviewer.DisplayName} after review", actor);
                await history.AppendAsync(d.ClaimId, now, "document", "Document accepted after review: " + DocumentRules.Title(d.Kind), actor,
                    (trimmed is null ? "" : trimmed + " · ") + (review.Count > 0 ? "review row closed" : ""), DocumentRules.Title(d.Kind), null);
            }
            else
            {
                await documents.ReviewAsync(id, "rejected", trimmed, reviewer.Handle, trimmed, now);
                var closedRows = 0;
                Guid? nextRow = null;
                if (requirement is not null)
                {
                    closedRows = (await deadlines.CloseLiveFollowUpsAsync(requirement.Id, "Closed: the document was rejected; a new follow-up row follows the replacement", now)).Count;
                    await requirements.SetStateAsync(requirement.Id, "requested", "Rejected: " + trimmed, now);
                    var days = requirement.FollowUpDays > 0 ? requirement.FollowUpDays : RejectedFollowUpDays;
                    nextRow = await deadlines.InsertAsync(new NewDeadline(d.ClaimId, DeadlineKind.RequirementFollowUp, requirement.Id,
                        "Follow up: " + (requirement.Key == "certificate" ? "certified copy of the death certificate" : requirement.Name), null, calendar.DaysAfter(now, days)));
                }
                var eventId = await outbox.InsertAsync(d.ClaimId, "document_rejected", Json.Serialize(new
                {
                    claimId = d.ClaimId.ToString(),
                    documentId = id.ToString(),
                    requirementId = requirement?.Id.ToString(),
                    reason = trimmed,
                    reviewedBy = reviewer.Handle,
                }));
                await history.AppendAsync(d.ClaimId, now, "document", "Document rejected: " + DocumentRules.Title(d.Kind), actor,
                    $"{trimmed} · {closedRows + review.Count} rows closed" + (nextRow is null ? "" : $" · a new follow-up row is written") + " · event " + eventId,
                    DocumentRules.Title(d.Kind), null);
            }
            return (await queries.DocumentAsync(id))!;
        });
    }

    private string Local(DateTimeOffset at) => TimeZoneInfo.ConvertTime(at, calendar.Zone).ToString("HH:mm", CultureInfo.InvariantCulture);

    private static string Hash(Guid claimId, ReceiveDocumentRequest r) =>
        Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(JsonSerializer.Serialize(new
        {
            claimId, r.RequirementId, r.RequirementKey, r.PartyId, r.Kind, r.Source, receivedAt = r.ReceivedAt?.ToUniversalTime(),
            tin = r.Attributes?.Tin?.Trim(), r.Attributes?.Photocopy, r.Attributes?.SealPresent,
        }, Json.Options))));
}
