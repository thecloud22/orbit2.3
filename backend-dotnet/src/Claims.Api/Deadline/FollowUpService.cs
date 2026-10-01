using Claims.Clock;
using System.Globalization;
using Claims.Common;
using Claims.Domain;
using Claims.Intake;
using Claims.Store;
using static Claims.Store.DeadlineRepository;
using static Claims.Store.LetterRepository;
using static Claims.Temporal.RequirementFollowUpActivities;

namespace Claims.Deadline;

/// <summary>
/// The database work of the requirement follow-up deadline workflow. Every method is safe to repeat: the compare-and-set close in
/// <see cref="DeadlineRepository.CloseLiveAsync"/> decides who did the work, and the unique index on live follow-ups stops a second
/// "next row".
///
/// Lock order (also used by RequirementService): requirement row first, then deadline rows.
/// </summary>
public sealed class FollowUpService(Db db, DeadlineRepository deadlines, RequirementRepository requirements, HistoryRepository history,
                                    WorkflowRunRepository runs, WorkItemRepository workItems, LetterService letters, BusinessCalendar calendar,
                                    IClock clock)
{
    private async Task<DeadlineRepository.Row> DeadlineAsync(Guid id) =>
        await deadlines.FindAsync(id) ?? throw new InvalidOperationException($"Deadline {id} does not exist");

    private static string ChannelFor(string requirementKey) => requirementKey is "report" or "amended_certificate" ? "fax" : "email";

    private async Task<ClaimStatus> ClaimStatusAsync(Guid claimId) =>
        EnumText.Parse<ClaimStatus>(await db.SingleAsync<string>("SELECT status FROM claims WHERE id = @id", new { id = claimId }));

    private static string Iso(DateOnly d) => d.ToString("yyyy-MM-dd", CultureInfo.InvariantCulture);

    /// <summary>Step 1: open the run record, then re-check that the deadline still applies.</summary>
    public async Task<Check> BeginAsync(Guid deadlineId, string workflowId, string runId)
    {
        var d = await DeadlineAsync(deadlineId);
        await runs.BeginAsync(workflowId, runId, "deadline", "Requirement follow-up", d.ClaimId,
            "Dispatcher · Temporal Schedule · deadline " + deadlineId + " due", "deadline", deadlineId, clock.UtcNow);
        if (!d.State.Live()) return new Check(false, "Already " + d.State.Db(), "", "", "");
        if (d.Kind != DeadlineKind.RequirementFollowUp || d.RequirementId is null) return new Check(false, "Not a requirement follow-up", "", "", "");
        var r = await requirements.FindAsync(d.RequirementId.Value) ?? throw new InvalidOperationException("Requirement of deadline " + deadlineId + " does not exist");
        if (!r.State.Chasing()) return new Check(false, "Requirement is already " + r.State.Db(), r.Name, r.FromLabel, ChannelFor(r.Key));
        if ((await ClaimStatusAsync(d.ClaimId)).DecidedOrClosed()) return new Check(false, "The claim is already decided", r.Name, r.FromLabel, ChannelFor(r.Key));
        return new Check(true, null, r.Name, r.FromLabel, ChannelFor(r.Key));
    }

    /// <summary>Step 2: the reminder, once per deadline.</summary>
    public async Task SendReminderAsync(Guid deadlineId, string workflowId)
    {
        var d = await DeadlineAsync(deadlineId);
        var r = await requirements.FindAsync(d.RequirementId!.Value) ?? throw new InvalidOperationException("Requirement of deadline " + deadlineId + " does not exist");
        var n = r.FollowUpCount + 1;
        await letters.SendOnceAsync(new NewLetter(d.ClaimId, "REM-LIFE-01", ChannelFor(r.Key), r.FromPartyId, r.FromLabel,
            "Reminder: " + r.Name, "Reminder " + n + ". We still need it to decide the claim.", "deadline", deadlineId, workflowId,
            "deadline:" + deadlineId + ":reminder"), r.FromLabel);
    }

    /// <summary>
    /// Step 3, one transaction: this deadline done, the next follow-up row written, the reminder in the history and the run saved.
    /// If the requirement was accepted while the reminder was in flight, the deadline is skipped instead and no next row is written.
    /// </summary>
    public Task<Result> CompleteAsync(Guid deadlineId, IReadOnlyList<RunStep> steps, string workflowId, string runId) =>
        db.InTransactionAsync(async () =>
        {
            var now = clock.UtcNow;
            var d = await DeadlineAsync(deadlineId);
            var r = await requirements.LockAsync(d.RequirementId!.Value) ?? throw new InvalidOperationException("Requirement of deadline " + deadlineId + " does not exist");
            var locked = await deadlines.LockAsync(deadlineId) ?? throw new InvalidOperationException($"Deadline {deadlineId} does not exist");
            if (!locked.State.Live())
            {
                var next = await deadlines.LiveFollowUpAsync(r.Id);
                return new Result("already_closed", next?.Id, "Already " + locked.State.Db());
            }
            if (!r.State.Chasing() || (await ClaimStatusAsync(d.ClaimId)).DecidedOrClosed())
            {
                await deadlines.CloseLiveAsync(deadlineId, DeadlineState.Skipped, "workflow",
                    "Requirement became " + r.State.Db() + " while the reminder was in flight", false, "skipped", runId, now);
                await runs.FinishAsync(workflowId, runId, "skipped", steps, ["Deadline skipped: requirement " + r.State.Db()], null, now);
                return new Result("skipped", null, "Requirement became " + r.State.Db());
            }
            var channel = ChannelFor(r.Key);
            var when = TimeZoneInfo.ConvertTime(now, calendar.Zone).ToString("ddd d MMM HH:mm", CultureInfo.InvariantCulture);
            await deadlines.CloseLiveAsync(deadlineId, DeadlineState.Done, "workflow", "Fired " + when + " → reminder sent by " + channel, true,
                "completed", runId, now);
            var days = r.FollowUpDays > 0 ? r.FollowUpDays : LifeIntakeRules.FollowUpDays;
            var nextDue = calendar.DaysAfter(now, days);
            var nextId = await deadlines.InsertAsync(new NewDeadline(d.ClaimId, DeadlineKind.RequirementFollowUp, r.Id, "Follow up again: " + r.Name, null, nextDue));
            await requirements.RecordReminderAsync(r.Id, now);
            await history.AppendAsync(d.ClaimId, now, "communication", "Reminder sent: " + r.Name, Actor.Workflow(workflowId),
                "Deadline " + deadlineId + " came due · next follow-up " + nextId + " on " + Iso(calendar.LocalDate(nextDue)), r.Name, workflowId);
            await runs.FinishAsync(workflowId, runId, "completed", steps, ["Deadline " + deadlineId + " done",
                "Next follow-up " + nextId + " due " + Iso(calendar.LocalDate(nextDue)), "Reminder in the history"], null, now);
            return new Result("reminded", nextId, "Next follow-up due " + Iso(calendar.LocalDate(nextDue)));
        });

    /// <summary>Skipped: the deadline no longer applies.</summary>
    public Task<Result> SkipAsync(Guid deadlineId, string reason, IReadOnlyList<RunStep> steps, string workflowId, string runId) =>
        db.InTransactionAsync(async () =>
        {
            var now = clock.UtcNow;
            var d = await DeadlineAsync(deadlineId);
            var closed = await deadlines.CloseLiveAsync(deadlineId, DeadlineState.Skipped, "workflow", "Skipped: " + reason, false, "skipped", runId, now);
            if (closed)
            {
                await history.AppendAsync(d.ClaimId, now, "data", "Follow-up skipped: " + reason, Actor.Workflow(workflowId),
                    "Deadline " + deadlineId, null, workflowId);
            }
            await runs.FinishAsync(workflowId, runId, "skipped", steps, [closed ? "Deadline skipped: " + reason : "Deadline was already closed"], null, now);
            return new Result(closed ? "skipped" : "already_closed", null, reason);
        });

    /// <summary>Retries exhausted. The deadline stays dispatched so the nightly check finds it too; a person gets a task.</summary>
    public Task RecordFailureAsync(Guid deadlineId, string error, IReadOnlyList<RunStep> steps, string workflowId, string runId) =>
        db.InTransactionAsync(async () =>
        {
            var now = clock.UtcNow;
            var d = await DeadlineAsync(deadlineId);
            await workItems.InsertOnceAsync("workflow-failed:" + workflowId, null, d.ClaimId, 1, "Deadline workflow failed: " + d.What,
                "Workflow " + workflowId + " gave up: " + error, calendar.LocalDate(now), "You", "workflow", "deadline", deadlineId);
            await history.AppendAsync(d.ClaimId, now, "task", "Deadline workflow failed after retries: " + d.What, Actor.Workflow(workflowId), error, null, workflowId);
            await runs.FinishAsync(workflowId, runId, "failed", steps, ["Ops task opened", "Deadline stays dispatched"], error, now);
        });
}
