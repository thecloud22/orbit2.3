using Claims.Domain;
using Temporalio.Common;
using Temporalio.Exceptions;
using Temporalio.Workflows;
using static Claims.Temporal.PaymentMethodUpdatedActivities;

namespace Claims.Temporal;

/// <summary>
/// Event workflow <c>event-&lt;outboxEventId&gt;</c>, started after a payee's new account was saved together with the replacement payment item (`payment_method_updated`).
/// Checking the account calls an outside system, so it is an activity with retries: "verified / not verified" is an answer, an unreachable bank is a failure Temporal retries.
/// Verified: the payee is told (RTN-LIFE-02). Not verified: the replacement item is held and the examiner gets a work item. Either way the workflow ends; the next payment run
/// pays a cleared replacement and its confirmation closes the claim again.
/// </summary>
[Workflow("PaymentMethodUpdatedWorkflow")]
public class PaymentMethodUpdatedWorkflow
{
    /// <param name="Outcome">verified | rejected</param>
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
            var facts = await Workflow.ExecuteActivityAsync((PaymentMethodUpdatedActivities a) => a.BeginAsync(input), Options);
            var first = First(facts.PayeeName);
            var check = await Workflow.ExecuteActivityAsync((PaymentMethodUpdatedActivities a) => a.VerifyAccountAsync(input), Options);
            steps.Add(RunStep.Ran("Verify the account", $"{check.Detail} · account ending {facts.AccountLast4}", "Bank verification", check.Attempts,
                $"Temporal ran the check {check.Attempts} times: the bank could not be reached until the last attempt."));
            steps.Add(RunStep.Done("The replacement payment item", $"{facts.Items} item cleared when the details were saved: same amount, interest stopped at the first payment · the returned item is kept, never edited", "Postgres"));
            if (check.Ok)
            {
                var sent = await Workflow.ExecuteActivityAsync((PaymentMethodUpdatedActivities a) => a.ConfirmAsync(input), Options);
                steps.Add(RunStep.Ran($"Tell {first}", "Email · RTN-LIFE-02 · paid in the next daily run", "Letters and notifications", sent.Attempts, "The letter carries an idempotency key."));
                await Workflow.ExecuteActivityAsync((PaymentMethodUpdatedActivities a) => a.CompleteAsync(input, "verified", steps, VerifiedNote), Options);
                return new Result("verified", check.Detail);
            }
            var held = await Workflow.ExecuteActivityAsync((PaymentMethodUpdatedActivities a) => a.RejectAsync(input, check.Detail), Options);
            steps.Add(RunStep.Done("Hold the replacement", $"{held} item held · work item for the examiner", "Postgres"));
            await Workflow.ExecuteActivityAsync((PaymentMethodUpdatedActivities a) => a.CompleteAsync(input, "rejected", steps, RejectedNote), Options);
            return new Result("rejected", check.Detail);
        }
        catch (ActivityFailureException e)
        {
            var message = e.InnerException is not null ? e.InnerException.Message : e.Message;
            steps.Add(RunStep.Failed(e.ActivityType == "PaymentMethodUpdated_VerifyAccount" ? "Verify the account" : "Handle the new account", message,
                e.ActivityType == "PaymentMethodUpdated_VerifyAccount" ? "Bank verification" : "Postgres", 5, "The retries ran out."));
            await Workflow.ExecuteActivityAsync((PaymentMethodUpdatedActivities a) => a.RecordFailureAsync(input, message, steps), Options);
            throw;
        }
    }

    private const string VerifiedNote =
        "Checking the account calls an outside service, so it runs as an activity with retries. The replacement is a new payment item saved with the details; the returned one stays as it was, because paid items are never edited.";

    private const string RejectedNote =
        "The bank answered that it could not verify the account. That is an answer, not an error, so Temporal did not retry it: the replacement was held and the examiner asked to get another account.";

    private static string First(string name)
    {
        var i = name.IndexOf(' ', StringComparison.Ordinal);
        return i < 0 ? name : name[..i];
    }
}
