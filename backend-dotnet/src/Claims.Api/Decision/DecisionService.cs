using System.Globalization;
using System.Security.Cryptography;
using System.Text;
using Claims.Clock;
using Claims.Common;
using Claims.Domain;
using Claims.Intake;
using Claims.Payment;
using Claims.Store;
using Claims.View;
using static Claims.Store.DeadlineRepository;

namespace Claims.Decision;

/// <summary>What the caller of POST /claims/{id}/decisions sent, after JSON parsing and before validation.</summary>
public sealed record RecordDecisionRequest(Guid? BenefitLineId, string? Outcome, string? Basis, IReadOnlyList<string>? Evidence,
                                           IReadOnlyList<string>? Provisions, Guid? SupersedesId);

/// <summary>
/// Recording a decision, and a team lead approving one that is above the examiner's authority. Postgres only: no workflow runs in the request.
/// Everything one act changes is ONE transaction (the claim row is locked first, everywhere, so two acts on a claim queue up):
///
///   record  (within authority): decisions locked (v1, base line and riders) + payment items `cleared` + benefit lines + deadline rows
///           closed / written + claim `approved` + work items + history + an outbox event `decision_recorded`.
///   record  (above authority):  decisions locked as awaiting approval + claim `awaiting_approval` + a work item for the team lead + history.
///   approve:                    an approval row per decision, then exactly the effects of a within-authority record.
///
/// The letters (and telling the agent) are the short workflow the outbox event starts; they are not part of this transaction.
/// </summary>
public sealed class DecisionService(Db db, IClock clock, BusinessCalendar calendar, DecisionRepository decisions, PaymentRepository payments,
                                    DeadlineRepository deadlines, HistoryRepository history, WorkItemRepository workItems, OutboxRepository outbox,
                                    StaffRepository staff, ClaimQueries queries)
{
    public sealed record Outcome(RecordDecisionResult Result, bool Replayed);

    public const string ApprovalLetter = "APR-LIFE-01";
    public const string RiderExplanationLetter = "ADB-LIFE-03";

    private sealed record ClaimRow(Guid Id, string Number, string Status, string Team, string Insured, DateOnly DateOfDeath, string Manner);

    private sealed record LineRow(Guid Id, string Kind, Guid? ParentId, string Name, decimal Amount, string Currency, string Status);

    // ------------------------------------------------------------------ record

    public async Task<Outcome> RecordAsync(Guid claimId, RecordDecisionRequest r, string idempotencyKey, string actorHandle)
    {
        var errors = new List<FieldError>();
        if (r.BenefitLineId is null) errors.Add(new FieldError("benefitLineId", "must not be null"));
        if (string.IsNullOrWhiteSpace(r.Outcome)) errors.Add(new FieldError("outcome", "must not be blank"));
        else if (r.Outcome is not ("approve" or "approve_in_part" or "deny")) errors.Add(new FieldError("outcome", "must be approve, approve_in_part or deny"));
        if (string.IsNullOrWhiteSpace(r.Basis)) errors.Add(new FieldError("basis", "must not be blank"));
        if (errors.Count > 0) throw new ApiException(422, "validation_failed", "The request is well formed but not valid", errors);
        if (r.Outcome != "approve")
            throw ApiException.Unprocessable("outcome_not_supported", "Only approve is built. Approving in part and denying go to a second reviewer, which comes with the complex scenario.");
        if (r.SupersedesId is not null)
            throw ApiException.Unprocessable("correction_not_supported", "Correcting an earlier decision (a new version that supersedes it) is not built yet");
        if (idempotencyKey.Length is < 8 or > 128) throw ApiException.BadRequest("invalid_idempotency_key", "Idempotency-Key must be 8 to 128 characters");

        var recorder = await staff.FindActiveByHandleAsync(actorHandle) ?? throw new ApiException(403, "unknown_actor", $"X-Actor '{actorHandle}' is not an active staff user");
        if (recorder.Role is not ("life_examiner" or "team_lead"))
            throw new ApiException(403, "not_permitted", $"{recorder.DisplayName} ({recorder.Role}) does not record life claim decisions");

        return await db.InTransactionAsync(async () =>
        {
            var scope = "decision:" + recorder.Handle;
            var hash = Hash(claimId, r);
            await db.SingleAsync<int>("SELECT 1 FROM (SELECT pg_advisory_xact_lock(hashtextextended(@k, 0))) AS locked", new { k = scope + "|" + idempotencyKey });
            if (await decisions.FindKeyAsync(scope, idempotencyKey) is { } seen)
            {
                if (seen.Hash != hash) throw ApiException.Conflict("idempotency_key_reuse", "This Idempotency-Key was already used with a different request body");
                return new Outcome(await ResultAsync(seen.GroupId!.Value), true);
            }

            var claim = await LockClaimAsync(claimId);
            if (claim.Status != "in_review")
                throw ApiException.Conflict("claim_not_ready_to_decide", $"A claim is decided when proof of loss is complete (in_review); this one is {claim.Status}");
            var lines = await LinesAsync(claimId);
            var line = lines.FirstOrDefault(l => l.Id == r.BenefitLineId) ?? throw ApiException.NotFound("Benefit line", r.BenefitLineId!);
            if (line.Kind != "base") throw ApiException.Unprocessable("rider_follows_base", "A rider is decided with its base line: record the decision on the base line");
            if (line.Status != "ready_to_decide")
                throw ApiException.Conflict("invalid_state", $"Benefit line {line.Name} is {line.Status}, not ready_to_decide");

            var now = clock.UtcNow;
            var riders = lines.Where(l => l.ParentId == line.Id).ToList();
            var payable = new List<LineRow> { line };
            payable.AddRange(riders.Where(x => x.Status == "ready_to_decide"));
            var notPayable = riders.Where(x => x.Status is "not_payable" or "cause_pending").ToList();

            var payees = await PayeesAsync(claimId);
            var payDate = PayDateAfter(calendar.LocalDate(now));
            var plan = DecisionPlan.Items(payable.Select(l => new PayableLine(l.Id, l.Name, l.Kind == "rider", l.Amount)).ToList(), payees, DaysFrom(claim.DateOfDeath, payDate));
            var total = DecisionPlan.Total(plan);
            var requires = total > recorder.PayoutLimit;
            var note = (requires ? "above " : "within ") + PaymentRules.UsdShort(recorder.PayoutLimit) + " authority";

            var evidence = r.Evidence is { Count: > 0 } ? r.Evidence : await DefaultEvidenceAsync(claimId);
            var provisions = r.Provisions is { Count: > 0 } ? r.Provisions : ["Death benefit · section 2", "Beneficiary · section 7"];
            var group = await db.SingleAsync<Guid>("SELECT gen_random_uuid()");   // (Guid.NewGuid is banned assembly-wide, see BannedSymbols.txt)
            Guid baseId = Guid.Empty;
            foreach (var l in payable)
            {
                var itemsOfLine = plan.Where(p => p.LineId == l.Id).ToList();
                var principal = itemsOfLine.Sum(p => p.Principal);
                var interest = itemsOfLine.Sum(p => p.Interest);
                var id = await decisions.InsertAsync(new DecisionRepository.NewDecision(claimId, l.Id, group, "approved",
                    $"Approved · {PaymentRules.Usd(principal)} + {PaymentRules.Usd(interest)} interest", r.Basis!.Trim(), evidence, provisions, now, recorder.Id,
                    l.Kind == "base" || requires ? note : "rider follows the base decision", requires, ApprovalLetter, principal + interest));
                if (l.Id == line.Id) baseId = id;
            }
            foreach (var l in notPayable)
                await decisions.InsertAsync(new DecisionRepository.NewDecision(claimId, l.Id, group, "closed", "Closed · not payable",
                    "The certificate gives natural causes. The rider pays only for an accidental death.", ["Death certificate"], ["Accidental death benefit rider"], now,
                    recorder.Id, "rider follows the base decision", requires, RiderExplanationLetter, null));
            await decisions.InsertKeyAsync(scope, idempotencyKey, hash, claimId, group);

            if (requires) await RequestApprovalAsync(claim, recorder, group, baseId, total, now);
            else await ApplyAsync(claim, await decisions.LockGroupAsync(group), recorder, null, null, now);
            return new Outcome(await ResultAsync(group), false);
        });
    }

    // ------------------------------------------------------------------ approve

    public async Task<RecordDecisionResult> ApproveAsync(Guid decisionId, string actorHandle, string? note)
    {
        var approver = await staff.FindActiveByHandleAsync(actorHandle) ?? throw new ApiException(403, "unknown_actor", $"X-Actor '{actorHandle}' is not an active staff user");
        if (approver.Role != "team_lead")
            throw new ApiException(403, "approver_not_authorized", $"{approver.DisplayName} ({approver.Role}) cannot approve a payout above an examiner's authority; a team lead can");

        return await db.InTransactionAsync(async () =>
        {
            var found = await decisions.FindAsync(decisionId) ?? throw ApiException.NotFound("Decision", decisionId);
            var claim = await LockClaimAsync(found.ClaimId);
            var group = await decisions.LockGroupAsync(found.GroupId);
            var head = group.First(d => d.Id == decisionId);
            if (!head.RequiresApproval || head.Approved || claim.Status != "awaiting_approval")
                throw ApiException.Conflict("not_awaiting_approval", head.Approved ? "This decision is already approved" : "This decision does not need approval, or its claim is not awaiting it");
            if (head.RecordedBy == approver.Id)
                throw new ApiException(403, "self_approval", "A decision cannot be approved by the person who recorded it");
            var recorder = await staff.FindAsync(head.RecordedBy) ?? throw new InvalidOperationException("Recorder of decision " + decisionId + " does not exist");

            var now = clock.UtcNow;
            var payDate = PayDateAfter(calendar.LocalDate(now));
            var plan = await PlanForAsync(group, claim, payDate);
            var total = DecisionPlan.Total(plan);
            if (total > approver.PayoutLimit)
                throw new ApiException(403, "approver_not_authorized",
                    $"{approver.DisplayName}'s authority is {PaymentRules.Usd(approver.PayoutLimit)}; this payout is {PaymentRules.Usd(total)}");

            foreach (var d in group) await decisions.InsertApprovalAsync(d.Id, approver.Id, now, note);
            await ApplyAsync(claim, group, recorder, approver, note, now);
            return await ResultAsync(group[0].GroupId);
        });
    }

    // ------------------------------------------------------------------ the two branches

    private async Task RequestApprovalAsync(ClaimRow claim, StaffRepository.Staff recorder, Guid group, Guid baseId, decimal total, DateTimeOffset now)
    {
        var lead = await staff.TeamLeadForAsync(claim.Team);
        await db.ExecuteAsync("UPDATE claims SET status = 'awaiting_approval' WHERE id = @id AND status = 'in_review'", new { id = claim.Id });
        await workItems.CompleteByKeyAsync("record-decision:" + claim.Id, now);
        await workItems.InsertOnceAsync("approve-decision:" + group, lead?.Id, claim.Id, 1, "Approve payout above authority",
            $"{recorder.DisplayName} · {PaymentRules.Usd(total)} · limit {PaymentRules.Usd(recorder.PayoutLimit)}", calendar.LocalDate(now), "You", "decision", "decision", baseId);
        await history.AppendAsync(claim.Id, now, "decision", "Approval requested: above the examiner's authority", Actor.User(recorder.DisplayName),
            $"{PaymentRules.Usd(total)} above {PaymentRules.Usd(recorder.PayoutLimit)} · waiting on {lead?.DisplayName ?? "a team lead"}", "Decision record", null);
    }

    /// <summary>The effects of a decision that is in force: items cleared, lines and rows updated, claim approved, event to the outbox. Same transaction as the caller's.</summary>
    private async Task ApplyAsync(ClaimRow claim, IReadOnlyList<DecisionRepository.Row> group, StaffRepository.Staff recorder, StaffRepository.Staff? approver,
                                  string? approvalNote, DateTimeOffset now)
    {
        var local = calendar.LocalDate(now);
        var payDate = PayDateAfter(local);
        var plan = await PlanForAsync(group, claim, payDate);
        var byLine = group.ToDictionary(d => d.BenefitLineId);
        foreach (var p in plan)
        {
            await payments.InsertClearedAsync(new PaymentRepository.NewItem(claim.Id, p.LineId, byLine[p.LineId].Id, p.PayeeId, p.Basis, p.Principal, p.Interest,
                p.Method, payDate));
        }
        foreach (var d in group)
        {
            if (d.Outcome == "approved")
                await db.ExecuteAsync("UPDATE benefit_lines SET status = 'approved', waiting_on = 'Payment run' WHERE id = @id", new { id = d.BenefitLineId });
            else
                await db.ExecuteAsync("UPDATE benefit_lines SET status = 'closed', waiting_on = NULL WHERE id = @id", new { id = d.BenefitLineId });
        }

        // The decision clock and the review target were met; the status letter is moot. (Mock: closeRow for D-709, D-710, D-704.)
        var met = await deadlines.CloseLiveByKindAsync(claim.Id, [DeadlineKind.DecisionDue, DeadlineKind.ReviewTarget], DeadlineState.Done, "decision",
            "Met: decided " + Iso(local), now);
        var moot = await deadlines.CloseLiveByKindAsync(claim.Id, [DeadlineKind.StatusLetter], DeadlineState.Skipped, "decision",
            "Skipped: the claim was decided first", now);
        var names = string.Join(" and ", (await PayeesAsync(claim.Id)).Select(p => LifeIntakeRules.First(p.Name)));
        var payDue = await deadlines.InsertAsync(new NewDeadline(claim.Id, DeadlineKind.PaymentDue, null, "Pay " + names, "pay",
            calendar.BusinessDaysAfter(now, PaymentRules.PaymentDueBusinessDays)));

        await db.ExecuteAsync("UPDATE claims SET status = 'approved' WHERE id = @id AND status IN ('in_review', 'awaiting_approval')", new { id = claim.Id });
        await workItems.CompleteByKeyAsync("record-decision:" + claim.Id, now);
        await workItems.CompleteByKeyAsync("approve-decision:" + group[0].GroupId, now);

        var head = group[0];
        var total = DecisionPlan.Total(plan);
        var by = approver ?? recorder;
        var above = approver is not null;
        await history.AppendAsync(claim.Id, now, "decision",
            "Decision recorded: approved (v1)" + (above ? ", approved by " + approver!.DisplayName : ""), Actor.User(recorder.DisplayName),
            $"{PaymentRules.Usd(total)} to {names}" + (string.IsNullOrWhiteSpace(approvalNote) ? "" : " · " + approvalNote), "Decision record", null);
        await history.AppendAsync(claim.Id, now, "payment", $"{plan.Count} payment items cleared for the {payDate.ToString("ddd d MMM", CultureInfo.InvariantCulture)} run",
            Actor.System("on decision"),
            $"{string.Join(", ", met)} closed · {(moot.Count > 0 ? string.Join(", ", moot) + " skipped · " : "")}payment_due written ({payDue})", null, null);
        await outbox.InsertAsync(claim.Id, "decision_recorded", Json.Serialize(new
        {
            claimId = claim.Id.ToString(),
            claimNumber = claim.Number,
            decisionId = head.Id.ToString(),
            groupId = head.GroupId.ToString(),
            approvedBy = by.Handle,
        }));
    }

    // ------------------------------------------------------------------ helpers

    private async Task<ClaimRow> LockClaimAsync(Guid claimId) =>
        await db.QueryOptionalAsync("""
            SELECT c.id, c.claim_number, c.status, c.team, ip.full_name AS insured, d.date_of_death, d.manner_of_death
            FROM claims c JOIN parties ip ON ip.id = c.insured_party_id JOIN life_claim_details d ON d.claim_id = c.id
            WHERE c.id = @id FOR UPDATE OF c
            """, new { id = claimId },
            r => new ClaimRow(r.Guid("id"), r.Text("claim_number"), r.Text("status"), r.Text("team"), r.Text("insured"), r.Date("date_of_death"), r.Text("manner_of_death")))
        ?? throw ApiException.NotFound("Claim", claimId);

    private Task<List<LineRow>> LinesAsync(Guid claimId) => db.QueryAsync(
        "SELECT id, kind, parent_line_id, name, amount, currency, status FROM benefit_lines WHERE claim_id = @c ORDER BY kind, created_at, id", new { c = claimId },
        r => new LineRow(r.Guid("id"), r.Text("kind"), r.GuidOrNull("parent_line_id"), r.Text("name"), r.Decimal("amount"), r.Text("currency"), r.Text("status")));

    /// <summary>Living beneficiaries who are payees, in a fixed order (by name) so the one who takes the rounding never changes.</summary>
    private async Task<IReadOnlyList<Payee>> PayeesAsync(Guid claimId)
    {
        var rows = await db.QueryAsync("""
            SELECT p.id, p.full_name, cp.share_percent, COALESCE(cp.packet_channel, 'portal') AS packet
            FROM claim_parties cp JOIN parties p ON p.id = cp.party_id
            WHERE cp.claim_id = @c AND cp.role = 'beneficiary' AND cp.payee ORDER BY p.full_name, p.id
            """, new { c = claimId },
            r => new Payee(r.Guid("id"), r.Text("full_name"), r.Decimal("share_percent"), r.Text("packet") == "mail" ? "check" : "eft"));
        if (rows.Count == 0) throw ApiException.Unprocessable("no_payees", "The claim has no living beneficiary to pay");
        return rows;
    }

    /// <summary>The items a group of decisions pays on a pay date: the approved decisions' lines, split among the payees.</summary>
    private async Task<IReadOnlyList<PlannedItem>> PlanForAsync(IReadOnlyList<DecisionRepository.Row> group, ClaimRow claim, DateOnly payDate)
    {
        var lines = await LinesAsync(claim.Id);
        var payable = group.Where(d => d.Outcome == "approved").Select(d => lines.First(l => l.Id == d.BenefitLineId))
            .Select(l => new PayableLine(l.Id, l.Name, l.Kind == "rider", l.Amount)).ToList();
        return DecisionPlan.Items(payable, await PayeesAsync(claim.Id), DaysFrom(claim.DateOfDeath, payDate));
    }

    private async Task<IReadOnlyList<string>> DefaultEvidenceAsync(Guid claimId)
    {
        var met = await db.ListAsync<string>("SELECT name FROM requirements WHERE claim_id = @c AND state IN ('accepted', 'waived') ORDER BY name", new { c = claimId });
        return [.. met, "Beneficiary designation"];
    }

    /// <summary>The next business day after the decision: when the daily run may pay (the mock's <c>addBusinessDays(decide, 1)</c>).</summary>
    public static DateOnly PayDateAfter(DateOnly decisionDate) => BusinessCalendar.AddBusinessDays(decisionDate, PaymentRules.PayBusinessDaysAfterDecision);

    public static int DaysFrom(DateOnly from, DateOnly to) => to.DayNumber - from.DayNumber;

    private static string Iso(DateOnly d) => d.ToString("yyyy-MM-dd", CultureInfo.InvariantCulture);

    private static string Hash(Guid claimId, RecordDecisionRequest r) =>
        Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(Json.Serialize(new { claimId, r.BenefitLineId, r.Outcome, basis = r.Basis?.Trim(), r.Evidence, r.Provisions }))));

    /// <summary>The result for one act: the base decision, its riders, and (once in force) the payment items.</summary>
    private async Task<RecordDecisionResult> ResultAsync(Guid groupId)
    {
        var group = await queries.DecisionGroupAsync(groupId);
        var head = group[0];
        var awaiting = head.Status == "awaiting_approval";
        var items = awaiting ? [] : await queries.PaymentItemsForDecisionsAsync([.. group.Select(d => d.Id)]);
        Guid? workItem = awaiting ? await workItems.IdByKeyAsync("approve-decision:" + groupId) : null;
        var total = group.Where(d => d.Amount is not null).Sum(d => decimal.Parse(d.Amount!.Amount, CultureInfo.InvariantCulture));
        string message;
        if (awaiting)
        {
            var claim = await db.SingleAsync<string>("SELECT team FROM claims WHERE id = @c", new { c = head.ClaimId });
            var lead = await staff.TeamLeadForAsync(claim);
            message = $"Sent to {lead?.DisplayName ?? "a team lead"} for approval: {PaymentRules.Usd(total)} is above {head.RecordedByName}'s authority.";
        }
        else
        {
            var payOn = items.Count > 0 ? items[0].PayOn.ToString("ddd d MMM", CultureInfo.InvariantCulture) : "";
            message = $"Decision recorded · {PaymentRules.Usd(items.Sum(i => decimal.Parse(i.Amount.Amount, CultureInfo.InvariantCulture)))} cleared for the {payOn} payment run";
        }
        return new RecordDecisionResult(awaiting ? "awaiting_approval" : "recorded", message, head, group.Skip(1).ToList(), items, workItem);
    }
}
