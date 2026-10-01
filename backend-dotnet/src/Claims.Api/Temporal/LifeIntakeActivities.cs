using System.Text.Json.Serialization;
using Claims.Domain;
using Claims.Gateway;
using Claims.Intake;
using Temporalio.Activities;

namespace Claims.Temporal;

/// <summary>
/// What the life intake orchestration does. Each method is one step: it calls one system, or does one Postgres transaction,
/// and is safe to repeat (Temporal retries activities).
///
/// Activity type names are prefixed (LifeIntake_...) because several activity classes share one worker and method names such as
/// Begin and RecordFailure repeat. They are also exactly what the Java version registered (prefix + capitalised method name), so
/// the two backends are wire compatible.
/// </summary>
public sealed class LifeIntakeActivities(IntakeSetupService setup, IPolicyAdminGateway policyAdmin, ISanctionsGateway sanctions)
{
    public sealed record Input(Guid ClaimId, Guid EventId);

    public sealed record Payee(Guid PartyId, string Name, string Packet, string? Email);

    public sealed record Facts(Guid ClaimId, string ClaimNumber, string Status, string InsuredName, string CallerName, bool CallerByEmail,
                               IReadOnlyList<Payee> Payees, IReadOnlyList<string> PolicyNumbers, string DateOfDeath, bool AgentConsent, string? AgentName)
    {
        [JsonIgnore] public bool AlreadySetUp => Status != "received";
    }

    public sealed record PolicyFinding(string PolicyNumber, bool InForce, string Note);

    public sealed record ScreenOutcome(bool Clear, int Attempts, string Reference);

    /// <param name="Sent">Letters sent (each at most once per idempotency key).</param>
    /// <param name="Attempts">Temporal's attempt number that finished the step (2 after a worker stalled or died on the first).</param>
    /// <param name="ElapsedMs">Real time from the first scheduling of the step to its finish, retries and the wait for the timeout included.</param>
    public sealed record SendOutcome(int Sent, int Attempts, long ElapsedMs);

    public sealed record RouteDecision(string Track, string Rule, IReadOnlyList<string> Reasons, Guid? ExaminerId, string? ExaminerName);

    private static ActivityInfo Info => ActivityExecutionContext.Current.Info;
    private static string WorkflowId => Info.WorkflowId ?? throw new InvalidOperationException("Not running inside a workflow");
    private static string RunId => Info.WorkflowRunId ?? throw new InvalidOperationException("Not running inside a workflow");

    /// <summary>Starts the run record for this workflow run and loads the claim as the workflow sees it.</summary>
    [Activity("LifeIntake_Begin")]
    public async Task<Facts> BeginAsync(Input input)
    {
        await setup.BeginRunAsync(input.ClaimId, input.EventId, WorkflowId, RunId);
        return await setup.LoadFactsAsync(input.ClaimId);
    }

    [Activity("LifeIntake_CheckPolicies")]
    public async Task<List<PolicyFinding>> CheckPoliciesAsync(Guid claimId)
    {
        var f = await setup.LoadFactsAsync(claimId);
        var dod = DateOnly.Parse(f.DateOfDeath, System.Globalization.CultureInfo.InvariantCulture);
        var found = new List<PolicyFinding>();
        foreach (var number in f.PolicyNumbers)
        {
            var s = await policyAdmin.StatusOnAsync(number, dod);
            found.Add(new PolicyFinding(number, s.InForceOnDateOfDeath, s.Note));
        }
        return found;
    }

    [Activity("LifeIntake_ScreenParties")]
    public async Task<ScreenOutcome> ScreenPartiesAsync(Guid claimId)
    {
        var f = await setup.LoadFactsAsync(claimId);
        var names = f.Payees.Select(p => p.Name).ToList();
        names.Add(f.CallerName);
        var s = await sanctions.ScreenAsync(names);
        return new ScreenOutcome(s.Clear, Info.Attempt, s.Reference);
    }

    /// <summary>Claim numbers of other open claims for the same death.</summary>
    [Activity("LifeIntake_FindDuplicateClaims")]
    public Task<List<string>> FindDuplicateClaimsAsync(Guid claimId) => setup.DuplicateClaimsAsync(claimId);

    [Activity("LifeIntake_Route")]
    public Task<RouteDecision> RouteAsync(Guid claimId) => setup.RouteAsync(claimId);

    /// <summary>The acknowledgement to the caller and a claim packet to each payee. Returns letters sent.</summary>
    [Activity("LifeIntake_SendAcknowledgementAndPackets")]
    public async Task<SendOutcome> SendAcknowledgementAndPacketsAsync(Guid claimId)
    {
        var sent = await setup.SendAcknowledgementAndPacketsAsync(claimId, WorkflowId);
        var elapsed = (long)(TimeProvider.System.GetUtcNow() - new DateTimeOffset(DateTime.SpecifyKind(Info.ScheduledTime, DateTimeKind.Utc))).TotalMilliseconds;
        return new SendOutcome(sent, Info.Attempt, Math.Max(0, elapsed));
    }

    /// <summary>Status-only notice to the agent of record, when the caller consented. Returns false when skipped.</summary>
    [Activity("LifeIntake_TellAgent")]
    public Task<bool> TellAgentAsync(Guid claimId) => setup.TellAgentAsync(claimId, WorkflowId);

    /// <summary>One transaction: status, route, owner, closes the ack/forms rows, welcome-call work item, history, run record.</summary>
    [Activity("LifeIntake_CompleteSetup")]
    public Task CompleteSetupAsync(Guid claimId, RouteDecision route, List<RunStep> steps) =>
        setup.CompleteSetupAsync(claimId, route, steps, WorkflowId, RunId);

    /// <summary>Something doubtful: leave the claim as received and open a task for a person.</summary>
    [Activity("LifeIntake_HoldForReview")]
    public Task HoldForReviewAsync(Guid claimId, List<string> reasons, List<RunStep> steps) =>
        setup.HoldForReviewAsync(claimId, reasons, steps, WorkflowId, RunId);

    /// <summary>The workflow gave up after retries: mark the run failed and open an ops task.</summary>
    [Activity("LifeIntake_RecordFailure")]
    public Task RecordFailureAsync(Guid claimId, string error, List<RunStep> steps) =>
        setup.RecordFailureAsync(claimId, error, steps, WorkflowId, RunId);
}
