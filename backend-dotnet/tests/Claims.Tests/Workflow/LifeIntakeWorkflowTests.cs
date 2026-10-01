using Temporalio.Client;
using Claims.Temporal;
using Temporalio.Exceptions;

namespace Claims.Tests.Workflow;

public class LifeIntakeWorkflowTests(WorkflowEnvironmentFixture fixture) : WorkflowTestBase(fixture)
{
    private readonly FakeLifeIntakeActivities acts = new();

    private Task<LifeIntakeWorkflow.Result> RunAsync() => WithWorkerAsync(
        o => o.AddWorkflow<LifeIntakeWorkflow>().AddAllActivities(acts),
        queue => Client.ExecuteWorkflowAsync(
            (LifeIntakeWorkflow wf) => wf.RunAsync(new LifeIntakeActivities.Input(Guid.NewGuid(), Guid.NewGuid())),
            Options("orch-L-26-043310-intake", queue)));

    [Fact]
    public async Task CleanClaimIsCheckedRoutedLettersSentAndSetUpInOneFinalStep()
    {
        var r = await RunAsync();

        Assert.Equal("set_up", r.Outcome);
        Assert.Equal(
            ["begin", "checkPolicies", "screenParties", "findDuplicateClaims", "route", "sendAcknowledgementAndPackets", "tellAgent", "completeSetup"],
            acts.CallsSnapshot());
        // The run record the final transaction saves lists every step, in order.
        Assert.Equal(
            ["Confirm in force on the date of death", "Screen the beneficiaries", "Look for an existing claim", "Route the claim",
             "Send the acknowledgement and claim packets", "Tell the agent of record"],
            acts.CompletedSteps!.Select(s => s.Label));
        Assert.All(acts.CompletedSteps!, s => Assert.Equal("done", s.State));
    }

    [Fact]
    public async Task SanctionsTimeoutIsRetriedByTemporalAndShowsAsRetriedInTheRun()
    {
        acts.FailSanctionsTimes(1);
        var before = await Env.GetCurrentTimeAsync();

        var r = await RunAsync();

        Assert.Equal("set_up", r.Outcome);
        Assert.Equal(2, acts.CallCount("screenParties"));
        var step = Assert.Single(acts.CompletedSteps!, s => s.Label == "Screen the beneficiaries");
        Assert.Equal("retried", step.State);
        Assert.Contains("attempt 2", step.Detail);
        // Time skipping: the 2 s back-off elapsed in workflow time, not in the test's.
        var elapsed = await Env.GetCurrentTimeAsync() - before;
        Assert.True(elapsed >= TimeSpan.FromSeconds(2), $"workflow time advanced only {elapsed}");
    }

    [Fact]
    public async Task AnythingDoubtfulStopsTheChecksAndOpensATaskForAPerson()
    {
        acts.PolicyInForce = false;
        acts.Duplicates = ["L-26-041111"];

        var r = await RunAsync();

        Assert.Equal("needs_review", r.Outcome);
        Assert.Equal(2, acts.HeldReasons!.Count);
        Assert.Contains("WL-0804419", acts.HeldReasons[0]);
        Assert.Contains("L-26-041111", acts.HeldReasons[1]);
        // Nothing is sent and the claim is not set up.
        var calls = acts.CallsSnapshot();
        Assert.DoesNotContain("route", calls);
        Assert.DoesNotContain("sendAcknowledgementAndPackets", calls);
        Assert.DoesNotContain("tellAgent", calls);
        Assert.DoesNotContain("completeSetup", calls);
        Assert.Contains("holdForReview", calls);
    }

    [Fact]
    public async Task SanctionsHitHoldsTheClaim()
    {
        acts.SanctionsClear = false;
        Assert.Equal("needs_review", (await RunAsync()).Outcome);
        Assert.Contains("Sanctions", Assert.Single(acts.HeldReasons!));
    }

    [Fact]
    public async Task NoAgentConsentSkipsTheAgentStepButStillSetsUp()
    {
        acts.Consent = false;
        Assert.Equal("set_up", (await RunAsync()).Outcome);
        Assert.Equal("skipped", Assert.Single(acts.CompletedSteps!, s => s.Label == "Tell the agent of record").State);
    }

    [Fact]
    public async Task AClaimThatIsAlreadySetUpIsLeftAlone()
    {
        acts.Status = "gathering_evidence";
        Assert.Equal("already_set_up", (await RunAsync()).Outcome);
        Assert.Equal(["begin"], acts.CallsSnapshot());
    }

    [Fact]
    public async Task WhenRetriesAreExhaustedTheRunIsRecordedAsFailedAndTheWorkflowFails()
    {
        acts.LettersAlwaysFail = true;

        await Assert.ThrowsAsync<WorkflowFailedException>(RunAsync);

        Assert.Equal(5, acts.CallCount("sendAcknowledgementAndPackets"));   // maximum attempts
        Assert.Equal("recordFailure", acts.CallsSnapshot()[^1]);
        Assert.DoesNotContain("completeSetup", acts.CallsSnapshot());
        Assert.Contains("notification provider is down", acts.FailedWith);
        Assert.Contains(acts.StepsAtFailure!, s => s.Label == "Route the claim");   // what it got through is kept
    }
}
