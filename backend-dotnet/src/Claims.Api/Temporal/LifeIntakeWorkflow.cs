using Claims.Domain;
using Temporalio.Common;
using Temporalio.Exceptions;
using Temporalio.Workflows;
using static Claims.Temporal.LifeIntakeActivities;

namespace Claims.Temporal;

/// <summary>
/// Orchestration <c>orch-&lt;claim number&gt;-intake</c>. Started by the outbox relay when a notice of death is saved.
///
/// Workflow code is replayed, so it stays deterministic: only Workflow.* APIs and pure code in here (see BannedSymbols.txt), no
/// ConfigureAwait(false), and every side effect is an activity. The workflow type name is what the Java version registered.
/// </summary>
[Workflow("LifeIntakeWorkflow")]
public class LifeIntakeWorkflow
{
    /// <param name="Outcome">set_up | needs_review | already_set_up</param>
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
            var facts = await Workflow.ExecuteActivityAsync((LifeIntakeActivities a) => a.BeginAsync(input), Options);
            if (facts.AlreadySetUp)
            {
                return new Result("already_set_up", "Claim " + facts.ClaimNumber + " is already " + facts.Status);
            }
            var doubts = new List<string>();

            // 1. Policies: found, and in force on the date of death.
            var policies = await Workflow.ExecuteActivityAsync((LifeIntakeActivities a) => a.CheckPoliciesAsync(input.ClaimId), Options);
            var inForce = policies.Count(p => p.InForce);
            steps.Add(RunStep.Done("Confirm in force on the date of death",
                policies.Count + " policy checked · " + inForce + " in force", "Policy administration"));
            foreach (var p in policies.Where(p => !p.InForce))
                doubts.Add("Policy " + p.PolicyNumber + " may not have been in force: " + p.Note);

            // 2. Sanctions screening. Temporal retries a timeout; the attempt count shows in the run.
            var screen = await Workflow.ExecuteActivityAsync((LifeIntakeActivities a) => a.ScreenPartiesAsync(input.ClaimId), Options);
            var screened = screen.Clear ? "all clear" : "possible match, reference " + screen.Reference;
            steps.Add(screen.Attempts > 1
                ? RunStep.Ran("Screen the beneficiaries", "Retried by Temporal (attempt " + screen.Attempts + ") · " + screened, "Sanctions screening", screen.Attempts,
                    "The screening service timed out; Temporal retried after the backoff.")
                : RunStep.Done("Screen the beneficiaries", screened, "Sanctions screening"));
            if (!screen.Clear) doubts.Add("Sanctions screening returned a possible match (" + screen.Reference + ")");

            // 3. Is there already a claim for this death?
            var duplicates = await Workflow.ExecuteActivityAsync((LifeIntakeActivities a) => a.FindDuplicateClaimsAsync(input.ClaimId), Options);
            steps.Add(RunStep.Done("Look for an existing claim", duplicates.Count == 0 ? "None for this death" : "Found " + string.Join(", ", duplicates), "Postgres"));
            if (duplicates.Count > 0) doubts.Add("Possible duplicate claim: " + string.Join(", ", duplicates));

            // Anything doubtful stops the checks and opens a task for a person.
            if (doubts.Count > 0)
            {
                await Workflow.ExecuteActivityAsync((LifeIntakeActivities a) => a.HoldForReviewAsync(input.ClaimId, doubts, steps), Options);
                return new Result("needs_review", string.Join("; ", doubts));
            }

            // 4. Route (rules LF-01 / LF-02) and pick the examiner.
            var route = await Workflow.ExecuteActivityAsync((LifeIntakeActivities a) => a.RouteAsync(input.ClaimId), Options);
            steps.Add(RunStep.Done("Route the claim", route.Track + " → " + (route.ExaminerName ?? "team queue") + " · rule " + route.Rule, "Rules"));

            // 5. Acknowledgement and packets, then the agent.
            var sent = await Workflow.ExecuteActivityAsync((LifeIntakeActivities a) => a.SendAcknowledgementAndPacketsAsync(input.ClaimId), Options);
            steps.Add(sent.Attempts > 1
                ? RunStep.Ran("Send the acknowledgement and claim packets",
                    sent.Sent + " letters sent · the first attempt did not report back, so Temporal ran it again (attempt " + sent.Attempts + ") after " + (sent.ElapsedMs / 1000) +
                    " s · the letters service saw the same idempotency keys, so nothing went twice", "Letters and notifications", sent.Attempts,
                    "Temporal scheduled the step again and another worker picked it up; the letters carry idempotency keys (intake:<claim>:ack, intake:<claim>:packet:<party>), so the retry was a no-op.")
                : RunStep.Done("Send the acknowledgement and claim packets", sent.Sent + " letters sent", "Letters and notifications"));
            var told = await Workflow.ExecuteActivityAsync((LifeIntakeActivities a) => a.TellAgentAsync(input.ClaimId), Options);
            steps.Add(told ? RunStep.Done("Tell the agent of record", facts.AgentName + " · status only", "Notifications")
                : RunStep.Skipped("Tell the agent of record", "No consent or no agent on the claim", "Notifications"));

            // 6. One transaction saves the outcome.
            await Workflow.ExecuteActivityAsync((LifeIntakeActivities a) => a.CompleteSetupAsync(input.ClaimId, route, steps), Options);
            return new Result("set_up", route.Track);
        }
        catch (ActivityFailureException e)
        {
            var message = e.InnerException is not null ? e.InnerException.Message : e.Message;
            await Workflow.ExecuteActivityAsync((LifeIntakeActivities a) => a.RecordFailureAsync(input.ClaimId, message, steps), Options);
            throw;
        }
    }
}
