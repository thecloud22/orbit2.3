using Claims.Clock;
using System.Globalization;
using Claims.Common;
using Claims.Domain;
using Claims.Store;
using Claims.View;
using static Claims.Store.DeadlineRepository;

namespace Claims.Requirement;

/// <summary>
/// Accepting or waiving a requirement: Postgres only, so no workflow. One transaction saves the new state, closes the
/// follow-up rows still waiting, writes the history, and, when it was the last requirement, completes proof of loss
/// (status in_review, the decision clock and review target as deadline rows, a work item for the owner).
/// Documents arriving and being classified (the event workflow that would normally call accept) is not built.
/// </summary>
public sealed class RequirementService(RequirementRepository requirements, DeadlineRepository deadlines, HistoryRepository history,
                                       WorkItemRepository workItems, ClaimQueries queries, Db db, BusinessCalendar calendar, IClock clock)
{
    public const int DecisionDays = 30;
    public const int ReviewBusinessDays = 5;

    public Task<RequirementView> AcceptAsync(Guid id, long ifMatch, string? satisfiedBy, Actor actor) =>
        db.InTransactionAsync(async () =>
        {
            var r = await LockAndCheckAsync(id, ifMatch);
            await AcceptLockedAsync(r, string.IsNullOrWhiteSpace(satisfiedBy) ? "Accepted by " + actor.Name : satisfiedBy, actor);
            return (await queries.RequirementAsync(id))!;
        });

    /// <summary>
    /// The accept path for a document a workflow or the examiner accepted, in the caller's transaction (or its own): the same effects as
    /// <see cref="AcceptAsync"/> (follow-up rows closed, history, proof of loss when it was the last requirement) without the optimistic-concurrency check, which
    /// belongs to a person's click, not to a workflow. Repeating it is harmless: a requirement that is already met changes nothing and this returns false.
    /// </summary>
    public Task<bool> AcceptFromDocumentAsync(Guid id, string satisfiedBy, Actor actor) => db.InTransactionAsync(async () =>
    {
        var r = await requirements.LockAsync(id) ?? throw ApiException.NotFound("Requirement", id);
        if (r.State is RequirementState.Accepted or RequirementState.Waived or RequirementState.Expired) return false;
        await AcceptLockedAsync(r, satisfiedBy, actor);
        return true;
    });

    private async Task AcceptLockedAsync(RequirementRepository.Row r, string satisfiedBy, Actor actor)
    {
        var now = clock.UtcNow;
        await requirements.MarkAcceptedAsync(r.Id, satisfiedBy, now);
        var closed = await deadlines.CloseOpenFollowUpsAsync(r.Id, "Closed: requirement accepted", now);
        await history.AppendAsync(r.ClaimId, now, "data", "Requirement met: " + r.Name, actor,
            closed > 0 ? closed + " follow-up row" + (closed > 1 ? "s" : "") + " closed" : null, r.Name, null);
        await AfterMetAsync(r.ClaimId, now);
    }

    public Task<RequirementView> WaiveAsync(Guid id, long ifMatch, string? reason, Actor actor)
    {
        if (string.IsNullOrWhiteSpace(reason)) throw ApiException.Unprocessable("reason_required", "Waiving a requirement needs a reason");
        return db.InTransactionAsync(async () =>
        {
            var r = await LockAndCheckAsync(id, ifMatch);
            var now = clock.UtcNow;
            await requirements.MarkWaivedAsync(id, reason.Trim(), actor.Name, now);
            await deadlines.CloseOpenFollowUpsAsync(id, "Closed: requirement waived", now);
            await history.AppendAsync(r.ClaimId, now, "data", "Requirement waived: " + r.Name, actor, reason.Trim(), r.Name, null);
            await AfterMetAsync(r.ClaimId, now);
            return (await queries.RequirementAsync(id))!;
        });
    }

    private async Task<RequirementRepository.Row> LockAndCheckAsync(Guid id, long ifMatch)
    {
        var r = await requirements.LockAsync(id) ?? throw ApiException.NotFound("Requirement", id);
        if (r.Version != ifMatch) throw ApiException.VersionConflict("Requirement " + id);
        if (r.State is RequirementState.Accepted or RequirementState.Waived or RequirementState.Expired)
            throw ApiException.Conflict("invalid_state", "Requirement is already " + r.State.Db());
        return r;
    }

    /// <summary>Proof of loss is complete when every requirement is accepted or waived: the decision clock starts.</summary>
    private async Task AfterMetAsync(Guid claimId, DateTimeOffset now)
    {
        if (await requirements.CountUnmetAsync(claimId) > 0) return;
        var moved = await db.ExecuteAsync(
            "UPDATE claims SET status = 'in_review', proof_complete_at = @now WHERE id = @id AND status = 'gathering_evidence'",
            new { now = now.ToUniversalTime(), id = claimId });
        if (moved == 0) return;   // received (set-up not finished yet) or already past evidence
        var decisionDue = calendar.DaysAfter(now, DecisionDays);
        var reviewDue = calendar.BusinessDaysAfter(now, ReviewBusinessDays);
        var decisionRow = await deadlines.InsertAsync(new NewDeadline(claimId, DeadlineKind.DecisionDue, null, "Decide the claim", "decide", decisionDue));
        var reviewRow = await deadlines.InsertAsync(new NewDeadline(claimId, DeadlineKind.ReviewTarget, null, "Examiner review done (alerts the team lead if not)", "review", reviewDue));
        await db.ExecuteAsync("UPDATE benefit_lines SET status = 'ready_to_decide', waiting_on = 'Decision' WHERE claim_id = @id AND status = 'gathering_evidence'",
            new { id = claimId });
        // owner_id may be null (unassigned claim): the work item then goes to the team queue.
        var head = (await db.QueryAsync("SELECT c.owner_id, p.full_name FROM claims c JOIN parties p ON p.id = c.insured_party_id WHERE c.id = @id", new { id = claimId },
            r => (Owner: r.GuidOrNull("owner_id"), Insured: r.Text("full_name"))))[0];
        var owner = head.Owner;
        await workItems.InsertOnceAsync("record-decision:" + claimId, owner, claimId, 1, "Record decision: " + head.Insured,
            "Proof of loss complete · state limit " + Iso(calendar.LocalDate(decisionDue)), calendar.LocalDate(reviewDue), "You", "decision", "workflow", null);
        await history.AppendAsync(claimId, now, "data", "Proof of loss complete: decision clock started", Actor.System("rules"),
            "Decide by " + Iso(calendar.LocalDate(decisionDue)) + " (" + decisionRow + ") · review by " + Iso(calendar.LocalDate(reviewDue)) + " (" + reviewRow + ")", null, null);
    }

    private static string Iso(DateOnly d) => d.ToString("yyyy-MM-dd", CultureInfo.InvariantCulture);
}
