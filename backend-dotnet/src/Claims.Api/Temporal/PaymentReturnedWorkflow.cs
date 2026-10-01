using Claims.Domain;
using Temporalio.Common;
using Temporalio.Exceptions;
using Temporalio.Workflows;
using static Claims.Temporal.PaymentReturnedActivities;

namespace Claims.Temporal;

/// <summary>
/// Event workflow <c>event-&lt;outboxEventId&gt;</c>, started by the outbox relay after the returns BATCH marked a paid item `returned` (`payment_returned`). Batch never changes the
/// claim; this is the claim side: reopen it (closed → reopened), stop paying the closed account (the batch already recorded that hold), ask the payee for a new account,
/// tell the examiner, and write the row that waits for the payee's details (10 days). After that nothing sleeps in Temporal: the deadline row waits.
/// </summary>
[Workflow("PaymentReturnedWorkflow")]
public class PaymentReturnedWorkflow
{
    /// <param name="Outcome">reopened | already_open</param>
    public sealed record Result(string Outcome, string Detail);

    private static readonly ActivityOptions Options = new()
    {
        StartToCloseTimeout = TimeSpan.FromSeconds(30),
        RetryPolicy = new RetryPolicy
        {
            InitialInterval = TimeSpan.FromSeconds(2),
            BackoffCoefficient = 2.0f,
            MaximumInterval = TimeSpan.FromSeconds(30),
            MaximumAttempts = 5,
        },
    };

    [WorkflowRun]
    public async Task<Result> RunAsync(Input input)
    {
        var steps = new List<RunStep>();
        try
        {
            var facts = await Workflow.ExecuteActivityAsync((PaymentReturnedActivities a) => a.BeginAsync(input), Options);
            steps.Add(RunStep.Done("Read the return", $"{facts.PayeeName} · {facts.Amount} · {facts.ReturnCode} {facts.ReturnReason}", "Postgres"));
            var reopen = await Workflow.ExecuteActivityAsync((PaymentReturnedActivities a) => a.ReopenAsync(input), Options);
            steps.Add(RunStep.Done("Reopen the claim", reopen.Reopened ? "Closed → Reopened · payment returned" : "The claim was not closed: it stays " + reopen.ClaimStatus, "Postgres"));
            steps.Add(RunStep.Done("Stop paying the closed account", "The hold on the closed account was recorded by the returns job: no future item uses it", "Postgres"));
            var first = First(facts.PayeeName);
            var sent = await Workflow.ExecuteActivityAsync((PaymentReturnedActivities a) => a.AskForNewAccountAsync(input), Options);
            steps.Add(RunStep.Ran($"Ask {first} for a new account", "Email · RTN-LIFE-01 · new details due " + reopen.DetailsDue, "Letters and notifications", sent.Attempts,
                "The letter carries an idempotency key, so a retried send goes once."));
            steps.Add(RunStep.Done("Tell the examiner", $"Work item for {reopen.Examiner}", "Postgres"));
            await Workflow.ExecuteActivityAsync((PaymentReturnedActivities a) => a.CompleteAsync(input, steps, Note(first)), Options);
            return new Result(reopen.Reopened ? "reopened" : "already_open", reopen.ClaimStatus);
        }
        catch (ActivityFailureException e)
        {
            var message = e.InnerException is not null ? e.InnerException.Message : e.Message;
            steps.Add(RunStep.Failed(e.ActivityType == "PaymentReturned_AskForNewAccount" ? "Ask for a new account" : "Handle the return", message, "Postgres", 5, "The retries ran out."));
            await Workflow.ExecuteActivityAsync((PaymentReturnedActivities a) => a.RecordFailureAsync(input, message, steps), Options);
            throw;
        }
    }

    private static string Note(string payee) =>
        "Batch never changes the claim itself. The returns job only marked the payment item returned, recorded the hold and wrote an event; this Temporal workflow did the claim side. " +
        $"After that nothing sleeps in Temporal: the deadline row waits for {payee}'s new details.";

    private static string First(string name)
    {
        var i = name.IndexOf(' ', StringComparison.Ordinal);
        return i < 0 ? name : name[..i];
    }
}
