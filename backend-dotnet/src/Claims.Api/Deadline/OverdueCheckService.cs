using System.Globalization;
using Claims.Clock;
using Claims.Common;
using Claims.Domain;
using Claims.Store;
using Claims.Temporal;
using Claims.View;

namespace Claims.Deadline;

/// <summary>
/// The nightly overdue check, a plain batch (its trigger is the hosted service <see cref="OverdueCheckPoller"/>, or <c>POST /deadlines:check-overdue</c>). It lists the OPEN
/// deadline rows that are past due and whose kind NO workflow fires (the dispatcher only starts workflows for kinds in <see cref="IWorkflowLauncher.SupportedDeadlineKinds"/>, so
/// nothing would ever notice these), on claims that are not closed, and for each one, ONCE (the work item's dedupe key is the row id):
///
///   * a work item for the claim's owner ("Overdue: ..."), and
///   * a history event.
///
/// It never closes or moves a row and never changes a claim: a row closes when the thing it waits for happens (the welcome call completes `first_contact_by`, the decision closes
/// `decision_due`, the payment run closes `payment_due`, a person's review closes `document_review_by`, the payee's new account closes `bank_details_by`).
/// Rows are locked <c>FOR UPDATE OF d SKIP LOCKED</c>, so two checks at once, or a check racing the action that closes a row, never work on the same row.
/// </summary>
public sealed class OverdueCheckService(Db db, IClock clock, BusinessCalendar calendar, DeadlineRepository deadlines, HistoryRepository history, WorkItemRepository workItems,
                                        IWorkflowLauncher launcher)
{
    public const int BatchSize = 200;

    public async Task<OverdueCheckView> RunAsync()
    {
        var kinds = Enum.GetValues<DeadlineKind>().Where(k => !launcher.SupportedDeadlineKinds.Contains(k)).ToList();
        return await db.InTransactionAsync(async () =>
        {
            var now = clock.UtcNow;
            var rows = await deadlines.LockOverdueAsync(now, kinds, BatchSize);
            var items = new List<OverdueItemView>();
            var raised = 0;
            foreach (var d in rows)
            {
                var days = calendar.LocalDate(now).DayNumber - calendar.LocalDate(d.DueAt).DayNumber;
                var isNew = await workItems.InsertOnceAsync("overdue:" + d.Id, d.OwnerId, d.ClaimId, 1, "Overdue: " + d.What,
                    $"Due {Iso(calendar.LocalDate(d.DueAt))}" + (days > 0 ? $" ({days} day{(days == 1 ? "" : "s")} ago)" : "") + $" · nothing fires this row on its own (kind {d.Kind.Db()}) · claim {d.ClaimNumber}",
                    calendar.LocalDate(now), "You", "workflow", "deadline", d.Id);
                if (isNew)
                {
                    raised++;
                    await history.AppendAsync(d.ClaimId, now, "task", "Deadline overdue: " + d.What, Actor.Batch("nightly overdue check"),
                        $"Due {Iso(calendar.LocalDate(d.DueAt))}; a work item was opened for the owner. The row stays open until what it waits for happens.", d.Id.ToString(), null);
                }
                items.Add(new OverdueItemView(d.Id, d.ClaimId, d.Kind.Db(), d.What, d.DueAt, isNew));
            }
            return new OverdueCheckView(now, raised, items.Count - raised, items);
        });
    }

    private static string Iso(DateOnly d) => d.ToString("yyyy-MM-dd", CultureInfo.InvariantCulture);
}
