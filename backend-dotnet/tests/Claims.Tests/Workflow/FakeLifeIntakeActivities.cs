using Claims.Domain;
using Claims.Temporal;
using Temporalio.Activities;
using static Claims.Temporal.LifeIntakeActivities;

namespace Claims.Tests.Workflow;

/// <summary>
/// In-memory activities with scripted behaviour, so workflow logic is tested without a database. Registered under the same activity
/// names as the real ones (a workflow only knows names), which is also what Temporal's testing guidance recommends for mocks.
/// </summary>
public sealed class FakeLifeIntakeActivities
{
    public List<string> Calls { get; } = [];
    public volatile string Status = "received";
    public volatile bool PolicyInForce = true;
    public volatile IReadOnlyList<string> Duplicates = [];
    public volatile bool SanctionsClear = true;
    public volatile bool Consent = true;
    private int sanctionsFailuresLeft;
    public volatile bool LettersAlwaysFail;

    public volatile IReadOnlyList<RunStep>? CompletedSteps;
    public volatile IReadOnlyList<string>? HeldReasons;
    public volatile string? FailedWith;
    public volatile IReadOnlyList<RunStep>? StepsAtFailure;

    public void FailSanctionsTimes(int n) => Interlocked.Exchange(ref sanctionsFailuresLeft, n);

    public int CallCount(string name)
    {
        lock (Calls) return Calls.Count(c => c == name);
    }

    public IReadOnlyList<string> CallsSnapshot()
    {
        lock (Calls) return [.. Calls];
    }

    private void Called(string name)
    {
        lock (Calls) Calls.Add(name);
    }

    [Activity("LifeIntake_Begin")]
    public Task<Facts> BeginAsync(Input input)
    {
        Called("begin");
        return Task.FromResult(new Facts(input.ClaimId, "L-26-043310", Status, "Robert Castellano", "Diane Castellano", true,
            [new Payee(Guid.NewGuid(), "Diane Castellano", "portal", "diane@example.com"),
             new Payee(Guid.NewGuid(), "Mark Castellano", "portal", "mark@example.com")],
            ["WL-0804419"], "2026-09-19", Consent, Consent ? "Tom Bright" : null));
    }

    [Activity("LifeIntake_CheckPolicies")]
    public Task<List<PolicyFinding>> CheckPoliciesAsync(Guid claimId)
    {
        Called("checkPolicies");
        return Task.FromResult(new List<PolicyFinding> { new("WL-0804419", PolicyInForce, PolicyInForce ? "premium paid to 2026-09-01" : "policy lapsed") });
    }

    [Activity("LifeIntake_ScreenParties")]
    public Task<ScreenOutcome> ScreenPartiesAsync(Guid claimId)
    {
        Called("screenParties");
        if (Interlocked.Decrement(ref sanctionsFailuresLeft) >= 0) throw new InvalidOperationException("sanctions service timed out");
        return Task.FromResult(new ScreenOutcome(SanctionsClear, ActivityExecutionContext.Current.Info.Attempt, "ref-1"));
    }

    [Activity("LifeIntake_FindDuplicateClaims")]
    public Task<List<string>> FindDuplicateClaimsAsync(Guid claimId)
    {
        Called("findDuplicateClaims");
        return Task.FromResult(Duplicates.ToList());
    }

    [Activity("LifeIntake_Route")]
    public Task<RouteDecision> RouteAsync(Guid claimId)
    {
        Called("route");
        return Task.FromResult(new RouteDecision("fast_track_life", "LF-01", ["Natural causes"], Guid.NewGuid(), "Rachel Kim"));
    }

    [Activity("LifeIntake_SendAcknowledgementAndPackets")]
    public Task<SendOutcome> SendAcknowledgementAndPacketsAsync(Guid claimId)
    {
        Called("sendAcknowledgementAndPackets");
        if (LettersAlwaysFail) throw new InvalidOperationException("notification provider is down");
        return Task.FromResult(new SendOutcome(3, ActivityExecutionContext.Current.Info.Attempt, 1200));
    }

    [Activity("LifeIntake_TellAgent")]
    public Task<bool> TellAgentAsync(Guid claimId)
    {
        Called("tellAgent");
        return Task.FromResult(Consent);
    }

    [Activity("LifeIntake_CompleteSetup")]
    public Task CompleteSetupAsync(Guid claimId, RouteDecision route, List<RunStep> steps)
    {
        Called("completeSetup");
        CompletedSteps = steps;
        return Task.CompletedTask;
    }

    [Activity("LifeIntake_HoldForReview")]
    public Task HoldForReviewAsync(Guid claimId, List<string> reasons, List<RunStep> steps)
    {
        Called("holdForReview");
        HeldReasons = reasons;
        return Task.CompletedTask;
    }

    [Activity("LifeIntake_RecordFailure")]
    public Task RecordFailureAsync(Guid claimId, string error, List<RunStep> steps)
    {
        Called("recordFailure");
        FailedWith = error;
        StepsAtFailure = steps;
        return Task.CompletedTask;
    }
}
