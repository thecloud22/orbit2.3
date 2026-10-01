using Claims.Domain;
using Temporalio.Common;
using Temporalio.Exceptions;
using Temporalio.Workflows;
using static Claims.Temporal.PaymentConfirmedActivities;

namespace Claims.Temporal;

/// <summary>
/// Event workflow <c>event-&lt;outboxEventId&gt;</c> after the payment run paid a claim's items: confirmations to the payees, the closing letter when the
/// run closed the claim, and the agent. The run itself (a batch, not Temporal) already marked the items paid and closed the claim.
/// </summary>
[Workflow("PaymentConfirmedWorkflow")]
public class PaymentConfirmedWorkflow
{
    /// <param name="Outcome">confirmed | confirmed_and_closed</param>
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
            var facts = await Workflow.ExecuteActivityAsync((PaymentConfirmedActivities a) => a.BeginAsync(input), Options);

            var sent = await Workflow.ExecuteActivityAsync((PaymentConfirmedActivities a) => a.SendConfirmationsAsync(input), Options);
            steps.Add(RunStep.Done("Send payment confirmations", string.Join(" and ", facts.Paid.Select(p => First(p.Name))), "Notifications"));
            steps.Add(RunStep.Done("Are all benefit lines settled?", facts.Closed ? "Yes: the payment run closed the claim" : "No: the claim stays open", "Postgres"));
            var closing = await Workflow.ExecuteActivityAsync((PaymentConfirmedActivities a) => a.SendClosingLetterAsync(input), Options);
            steps.Add(closing ? RunStep.Done("Send the closing letter", "CLS-LIFE-01", "Letters service")
                : RunStep.Skipped("Send the closing letter", "Not yet: the claim stays open", "Letters service"));
            var told = await Workflow.ExecuteActivityAsync((PaymentConfirmedActivities a) => a.TellAgentAsync(input), Options);
            steps.Add(told ? RunStep.Done("Tell the agent of record", facts.Closed ? "Status: closed" : "Status: paid", "Notifications")
                : RunStep.Skipped("Tell the agent of record", "No consent or no agent on the claim", "Notifications"));

            await Workflow.ExecuteActivityAsync((PaymentConfirmedActivities a) => a.CompleteAsync(input, steps), Options);
            return new Result(closing ? "confirmed_and_closed" : "confirmed", sent + " confirmations");
        }
        catch (ActivityFailureException e)
        {
            var message = e.InnerException is not null ? e.InnerException.Message : e.Message;
            await Workflow.ExecuteActivityAsync((PaymentConfirmedActivities a) => a.RecordFailureAsync(input, message, steps), Options);
            throw;
        }
    }

    private static string First(string name)
    {
        var i = name.IndexOf(' ', StringComparison.Ordinal);
        return i < 0 ? name : name[..i];
    }
}
