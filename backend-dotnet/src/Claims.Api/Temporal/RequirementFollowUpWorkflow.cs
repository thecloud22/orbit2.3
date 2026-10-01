using Claims.Domain;
using Temporalio.Common;
using Temporalio.Exceptions;
using Temporalio.Workflows;
using static Claims.Temporal.RequirementFollowUpActivities;

namespace Claims.Temporal;

/// <summary>
/// Deadline workflow <c>deadline-&lt;id&gt;</c> for kind requirement_follow_up: re-check, remind, write the next row.
///
/// Short by design: no timers, no waiting for the requirement to arrive. If it has arrived by the time this runs, the workflow
/// skips; if not, it reminds and writes the NEXT follow-up as a new deadline row, which the dispatcher will fire later. "Stop when
/// the requirement is met" therefore means: nothing is left scheduled once the requirement is accepted or waived.
/// </summary>
[Workflow("RequirementFollowUpWorkflow")]
public class RequirementFollowUpWorkflow
{
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
    public async Task<Result> RunAsync(Guid deadlineId)
    {
        var steps = new List<RunStep>();
        try
        {
            var check = await Workflow.ExecuteActivityAsync((RequirementFollowUpActivities a) => a.BeginAsync(deadlineId), Options);
            steps.Add(RunStep.Done("Re-check: is it still missing?", check.Applies ? "Yes: " + check.RequirementName : check.Reason ?? "", "Postgres"));
            if (!check.Applies)
            {
                return await Workflow.ExecuteActivityAsync((RequirementFollowUpActivities a) => a.SkipAsync(deadlineId, check.Reason ?? "", steps), Options);
            }
            await Workflow.ExecuteActivityAsync((RequirementFollowUpActivities a) => a.SendReminderAsync(deadlineId), Options);
            steps.Add(RunStep.Done("Send a reminder", check.Recipient + " by " + check.Channel, "Notifications"));
            return await Workflow.ExecuteActivityAsync((RequirementFollowUpActivities a) => a.CompleteFollowUpAsync(deadlineId, steps), Options);
        }
        catch (ActivityFailureException e)
        {
            var message = e.InnerException is not null ? e.InnerException.Message : e.Message;
            await Workflow.ExecuteActivityAsync((RequirementFollowUpActivities a) => a.RecordFailureAsync(deadlineId, message, steps), Options);
            throw;
        }
    }
}
