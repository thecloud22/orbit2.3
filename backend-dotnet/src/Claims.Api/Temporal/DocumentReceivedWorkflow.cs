using Claims.Domain;
using Claims.Requirement;
using Temporalio.Common;
using Temporalio.Exceptions;
using Temporalio.Workflows;
using static Claims.Temporal.DocumentReceivedActivities;

namespace Claims.Temporal;

/// <summary>
/// Event workflow <c>event-&lt;outboxEventId&gt;</c>, started by the outbox relay when a document has been saved (`document_received`). SHORT: no timers, no signals,
/// nothing waits for a person. What it does depends on the route the rules pick (<see cref="DocumentRules"/>):
///
///   claimant statement + W-9  IRS taxpayer-number check. "Match": accept through the normal accept path. "No match" is an ANSWER, not an error: the activity returns
///                             it, the workflow takes its not-enough branch (state saved, letter to the claimant) and ends; Temporal does not retry it. A 503 or timeout IS
///                             a failure, and Temporal retries it (5 attempts, 2 s, x2, max 30 s).
///   certified death certificate / police report  accepted.
///   photocopy, or anything the rules cannot accept  handed to a person (requirement `received`, a work item, a review row) and the workflow ENDS.
///
/// The corrected W-9 is simply another document: another event, another workflow, which knows nothing about this one.
/// </summary>
[Workflow("DocumentReceivedWorkflow")]
public class DocumentReceivedWorkflow
{
    /// <param name="Outcome">accepted | not_enough | needs_review</param>
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
            var facts = await Workflow.ExecuteActivityAsync((DocumentReceivedActivities a) => a.BeginAsync(input), Options);
            steps.Add(RunStep.Done("Read the document", $"{DocumentRules.Title(facts.Kind)} by {facts.Source.Replace('_', ' ')}" + (facts.PartyName is null ? "" : " · " + facts.PartyName) +
                " · the kind is what the sender declared (no classifier is built)", "Rules"));

            if (facts.Route == DocumentRules.TinCheck)
            {
                var check = await Workflow.ExecuteActivityAsync((DocumentReceivedActivities a) => a.CheckTinAsync(input), Options);
                steps.Add(RunStep.Ran("Check the taxpayer ID",
                    check.Match ? "IRS TIN match: ok" : "IRS TIN match: the name and number don’t match" + (check.Detail.Contains("fault", StringComparison.Ordinal) ? " · " + check.Detail : ""),
                    "IRS TIN matching", check.Attempts, $"Temporal ran the check {check.Attempts} times: the earlier attempts failed (the service could not be reached), the last one got an answer."));
                if (check.Match)
                {
                    steps.Add(RunStep.Done("Match to the claim and requirement", facts.ClaimNumber + " · " + (facts.RequirementName ?? "no requirement"), "Postgres"));
                    var accepted = await Workflow.ExecuteActivityAsync((DocumentReceivedActivities a) => a.AcceptAsync(input, steps, AcceptedNote(check.Attempts, facts.RunNo)), Options);
                    return new Result("accepted", accepted ? "Requirement accepted" : "Requirement was already met");
                }
                var notEnough = await Workflow.ExecuteActivityAsync((DocumentReceivedActivities a) => a.MarkNotEnoughAsync(input, "TIN mismatch"), Options);
                steps.Add(RunStep.Done("Mark the requirement not enough", "TIN mismatch · a correction follow-up is due " + notEnough.CorrectionDue, "Postgres"));
                var sent = await Workflow.ExecuteActivityAsync((DocumentReceivedActivities a) => a.AskForCorrectionAsync(input), Options);
                steps.Add(RunStep.Ran("Ask for a corrected W-9", notEnough.PartyName + " by email · W9-LIFE-01", "Letters and notifications", sent.Attempts,
                    "The letter carries an idempotency key, so a retried send goes once."));
                await Workflow.ExecuteActivityAsync((DocumentReceivedActivities a) => a.CompleteNotEnoughAsync(input, steps, NoMatchNote), Options);
                return new Result("not_enough", "TIN mismatch");
            }

            if (facts.Route == DocumentRules.Accept)
            {
                steps.Add(RunStep.Done("Can the rules accept it?", "Yes: " + facts.Reason, "Rules"));
                var accepted = await Workflow.ExecuteActivityAsync((DocumentReceivedActivities a) => a.AcceptAsync(input, steps, ""), Options);
                return new Result("accepted", accepted ? "Requirement accepted" : "Requirement was already met");
            }

            steps.Add(RunStep.Done("Can the rules accept it?", "No: " + facts.Reason, "Rules"));
            steps.Add(RunStep.Done("Ask the examiner", "A work item and a review deadline row", "Postgres"));
            await Workflow.ExecuteActivityAsync((DocumentReceivedActivities a) => a.HandToPersonAsync(input, facts.Reason, steps, HandOffNote), Options);
            return new Result("needs_review", facts.Reason);
        }
        catch (ActivityFailureException e)
        {
            var message = e.InnerException is not null ? e.InnerException.Message : e.Message;
            steps.Add(RunStep.Failed(LabelFor(e.ActivityType), message, SystemFor(e.ActivityType), 5, "The retries ran out."));
            await Workflow.ExecuteActivityAsync((DocumentReceivedActivities a) => a.RecordFailureAsync(input, message, steps), Options);
            throw;
        }
    }

    private const string NoMatchNote =
        "The IRS said “no match”. That is an answer, not an error, so the activity returned normally and Temporal did not retry it: the workflow took its not-enough branch, " +
        "asked for a correction and ended. Temporal retries only failures, such as a timeout or a 503. The corrected W-9 will be a new event and a new workflow.";

    private const string HandOffNote =
        "The workflow ends here instead of waiting for the examiner. Waiting on a person is a work item and a deadline row in Postgres, not a sleeping workflow, so nothing is lost " +
        "if she takes a day or the workers are redeployed.";

    private static string AcceptedNote(int attempts, int runNo) =>
        (attempts > 1 ? $"The IRS check ran {attempts} times (Temporal retried it after a failure) and then matched. " : "") +
        (runNo > 1 ? "" : "It reads the requirement from Postgres and knows nothing about any earlier try. If this was the last requirement, proof of loss completes in the same transaction: no workflow waits for the decision, the decision clock is a deadline row.");

    private static string LabelFor(string activityType) => activityType switch
    {
        "DocumentReceived_CheckTin" => "Check the taxpayer ID",
        "DocumentReceived_AskForCorrection" => "Ask for a corrected W-9",
        "DocumentReceived_Accept" => "Accept the document",
        "DocumentReceived_MarkNotEnough" => "Mark the requirement not enough",
        "DocumentReceived_HandToPerson" => "Ask the examiner",
        _ => "Handle the document",
    };

    private static string SystemFor(string activityType) => activityType switch
    {
        "DocumentReceived_CheckTin" => "IRS TIN matching",
        "DocumentReceived_AskForCorrection" => "Letters and notifications",
        _ => "Postgres",
    };
}
