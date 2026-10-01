using Claims.Domain;
using Temporalio.Common;
using Temporalio.Exceptions;
using Temporalio.Workflows;
using static Claims.Temporal.DecisionRecordedActivities;

namespace Claims.Temporal;

/// <summary>
/// Event workflow <c>event-&lt;decisionId&gt;</c>, started by the outbox relay when a decision has been recorded (or approved) and is in force. It only talks
/// to people: the approval letters and the agent of record. The decision, the payment items and the deadline changes were already saved, in one
/// transaction, before this workflow existed. Short: no timers, no waiting; a failed step is retried by Temporal, and when retries run out the run is
/// recorded as failed and a person gets a task (an ops re-run starts the same id again: the id reuse policy allows it after a failure).
/// </summary>
[Workflow("DecisionRecordedWorkflow")]
public class DecisionRecordedWorkflow
{
    /// <param name="Outcome">letters_sent</param>
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
            var facts = await Workflow.ExecuteActivityAsync((DecisionRecordedActivities a) => a.BeginAsync(input), Options);

            var sent = await Workflow.ExecuteActivityAsync((DecisionRecordedActivities a) => a.SendApprovalLettersAsync(input.DecisionId), Options);
            steps.Add(RunStep.Done("Generate the approval letters", "APR-LIFE-01 × " + sent, "Letters service"));
            if (facts.RiderExplained) steps.Add(RunStep.Done("Explain the rider outcome", "ADB-LIFE-03 · natural causes", "Letters service"));
            steps.Add(RunStep.Done("Deliver the way each beneficiary chose",
                string.Join(" · ", facts.Payees.Select(p => First(p.Name) + (p.Packet == "mail" ? " by mail" : " in the portal and by email"))), "Notifications"));

            var told = await Workflow.ExecuteActivityAsync((DecisionRecordedActivities a) => a.TellAgentAsync(input.DecisionId), Options);
            steps.Add(told ? RunStep.Done("Tell the agent of record", "Status: approved", "Notifications")
                : RunStep.Skipped("Tell the agent of record", "No consent or no agent on the claim", "Notifications"));

            await Workflow.ExecuteActivityAsync((DecisionRecordedActivities a) => a.CompleteAsync(input.DecisionId, steps), Options);
            return new Result("letters_sent", sent + " letters");
        }
        catch (ActivityFailureException e)
        {
            var message = e.InnerException is not null ? e.InnerException.Message : e.Message;
            await Workflow.ExecuteActivityAsync((DecisionRecordedActivities a) => a.RecordFailureAsync(input.DecisionId, message, steps), Options);
            throw;
        }
    }

    /// <summary>The first word of a name, as the letters greet people (pure, so replay-safe).</summary>
    private static string First(string name)
    {
        var i = name.IndexOf(' ', StringComparison.Ordinal);
        return i < 0 ? name : name[..i];
    }
}
