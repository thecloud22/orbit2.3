using Claims.Domain;
using Temporalio.Common;
using Temporalio.Exceptions;
using Temporalio.Workflows;
using static Claims.Temporal.DocumentRejectedActivities;

namespace Claims.Temporal;

/// <summary>
/// Event workflow <c>event-&lt;outboxEventId&gt;</c>, started by the outbox relay after the examiner rejected a document (`document_rejected`). The rejection is already
/// saved in Postgres (requirement `requested` again, the review row and the old follow-up row closed, a new follow-up row written); this workflow only sends the
/// "certified copy needed" letter. When the letters service is down Temporal retries the send (5 attempts, 2 s, x2, max 30 s: waits of 2, 4, 8 and 16 s); when the
/// attempts run out the run is recorded as FAILED, an ops work item is opened by the last step, and the run stays visible. An operator then starts it again under the SAME
/// workflow id (allowed because the id reuse policy is ALLOW_DUPLICATE_FAILED_ONLY): run 2 sends the letter with the same idempotency key, so the claimant gets one.
/// </summary>
[Workflow("DocumentRejectedWorkflow")]
public class DocumentRejectedWorkflow
{
    /// <param name="Outcome">letter_sent</param>
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
            var facts = await Workflow.ExecuteActivityAsync((DocumentRejectedActivities a) => a.BeginAsync(input), Options);
            steps.Add(RunStep.Done("Build the letter", "Why a photocopy can’t be accepted; how to order a certified copy · REQ-LIFE-03", "Letter templates"));
            var sent = await Workflow.ExecuteActivityAsync((DocumentRejectedActivities a) => a.SendLetterAsync(input), Options);
            steps.Add(RunStep.Ran("Send it", $"{First(facts.Claimant)} by letter · the letters service answered" + (sent.Attempts > 1 ? $" on attempt {sent.Attempts}" : "") + " · same idempotency key on every attempt",
                "Letters service", sent.Attempts, "Temporal ran the send again after a failure; the letter carries an idempotency key, so it went once."));
            await Workflow.ExecuteActivityAsync((DocumentRejectedActivities a) => a.CompleteAsync(input, steps), Options);
            return new Result("letter_sent", First(facts.Claimant));
        }
        catch (ActivityFailureException e)
        {
            var message = e.InnerException is not null ? e.InnerException.Message : e.Message;
            steps.Add(e.ActivityType == "DocumentRejected_SendLetter"
                ? RunStep.Failed("Send it", $"{message} · 5 attempts, waiting 2, 4, 8 and 16 s between them · gave up", "Letters service", 5,
                    "Temporal retried the send five times, waiting longer each time, then stopped as the retry policy says.")
                : RunStep.Failed("Build the letter", message, "Postgres", 5));
            steps.Add(RunStep.Done("Record the failure", "Ops task opened · the run shows as failed in Temporal", "Postgres"));
            await Workflow.ExecuteActivityAsync((DocumentRejectedActivities a) => a.RecordFailureAsync(input, message, steps), Options);
            throw;
        }
    }

    private static string First(string name)
    {
        var i = name.IndexOf(' ', StringComparison.Ordinal);
        return i < 0 ? name : name[..i];
    }
}
