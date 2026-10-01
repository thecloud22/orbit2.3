using Claims.Temporal;
using Temporalio.Client;
using Temporalio.Exceptions;
using Temporalio.Worker;

namespace Claims.Tests.Workflow;

/// <summary>
/// The two short event workflows (the letters after a decision, the confirmations after a payment run) on Temporal's time-skipping test server,
/// with fake activities: the steps the run record gets, the retry policy (letters that fail are retried and the run still ends completed, once),
/// and what happens when retries run out. No database.
/// </summary>
public class EventWorkflowTests(WorkflowEnvironmentFixture fixture) : WorkflowTestBase(fixture)
{
    private readonly FakeDecisionRecordedActivities decision = new();
    private readonly FakePaymentConfirmedActivities paid = new();

    private static DecisionRecordedActivities.Input DecisionInput => new(Guid.NewGuid(), Guid.NewGuid(), Guid.NewGuid());

    private Task<DecisionRecordedWorkflow.Result> RunDecisionAsync() => WithWorkerAsync(
        o => o.AddWorkflow<DecisionRecordedWorkflow>().AddAllActivities(decision),
        queue => Client.ExecuteWorkflowAsync((DecisionRecordedWorkflow wf) => wf.RunAsync(DecisionInput), Options("event-decision", queue)));

    private Task<PaymentConfirmedWorkflow.Result> RunPaidAsync() => WithWorkerAsync(
        o => o.AddWorkflow<PaymentConfirmedWorkflow>().AddAllActivities(paid),
        queue => Client.ExecuteWorkflowAsync((PaymentConfirmedWorkflow wf) => wf.RunAsync(new PaymentConfirmedActivities.Input(Guid.NewGuid(), Guid.NewGuid(), Guid.NewGuid())),
            Options("event-paid", queue)));

    [Fact]
    public async Task ADecisionSendsTheApprovalLettersThenTellsTheAgentThenSavesTheRun()
    {
        var r = await RunDecisionAsync();

        Assert.Equal("letters_sent", r.Outcome);
        Assert.Equal(["begin", "sendApprovalLetters", "tellAgent", "complete"], decision.CallsSnapshot());
        // The mock's four steps, in order, each done.
        Assert.Equal(["Generate the approval letters", "Explain the rider outcome", "Deliver the way each beneficiary chose", "Tell the agent of record"],
            decision.CompletedSteps!.Select(s => s.Label));
        Assert.All(decision.CompletedSteps!, s => Assert.Equal("done", s.State));
        Assert.Equal("APR-LIFE-01 × 2", decision.CompletedSteps![0].Detail);
        Assert.Equal("Diane in the portal and by email · Mark by mail", decision.CompletedSteps![2].Detail);
    }

    [Fact]
    public async Task WithNoRiderExplanationAndNoAgentConsentThoseStepsAreLeftOutOrSkipped()
    {
        decision.RiderExplained = false;
        decision.Consent = false;

        await RunDecisionAsync();

        Assert.Equal(["Generate the approval letters", "Deliver the way each beneficiary chose", "Tell the agent of record"], decision.CompletedSteps!.Select(s => s.Label));
        Assert.Equal("skipped", decision.CompletedSteps![^1].State);
    }

    [Fact]
    public async Task LettersThatFailAreRetriedByTemporalAndTheRunStillCompletesOnce()
    {
        decision.FailLettersTimes(2);
        var before = await Env.GetCurrentTimeAsync();

        var r = await RunDecisionAsync();

        Assert.Equal("letters_sent", r.Outcome);
        Assert.Equal([1, 2, 3], decision.LetterAttempts);   // two failures, then success on the third attempt
        Assert.Equal(["begin", "sendApprovalLetters", "sendApprovalLetters", "sendApprovalLetters", "tellAgent", "complete"], decision.CallsSnapshot());
        Assert.Equal(1, decision.CallsSnapshot().Count(c => c == "complete"));
        Assert.DoesNotContain("recordFailure", decision.CallsSnapshot());
        Assert.Equal(4, decision.CompletedSteps!.Count);
        // Back-off 2 s then 4 s elapsed in workflow time (time skipping), not in the test's.
        Assert.True(await Env.GetCurrentTimeAsync() - before >= TimeSpan.FromSeconds(6));
    }

    [Fact]
    public async Task WhenRetriesRunOutTheFailureIsRecordedForAPersonAndTheWorkflowFails()
    {
        decision.LettersAlwaysFail = true;

        var e = await Assert.ThrowsAsync<WorkflowFailedException>(RunDecisionAsync);

        Assert.IsType<ActivityFailureException>(e.InnerException);
        Assert.Equal(5, decision.LetterAttempts.Count);   // the same five attempts as the other workflows
        var calls = decision.CallsSnapshot();
        Assert.Equal("recordFailure", calls[^1]);
        Assert.DoesNotContain("complete", calls);
        Assert.DoesNotContain("tellAgent", calls);
        Assert.Contains("unavailable", decision.FailedWith, StringComparison.Ordinal);
        Assert.Empty(decision.StepsAtFailure!);   // nothing was done before the failing step
    }

    [Fact]
    public async Task APaymentThatClosedTheClaimSendsConfirmationsAndTheClosingLetter()
    {
        var r = await RunPaidAsync();

        Assert.Equal("confirmed_and_closed", r.Outcome);
        Assert.Equal(["begin", "sendConfirmations", "sendClosingLetter", "tellAgent", "complete"], paid.CallsSnapshot());
        Assert.Equal(["Send payment confirmations", "Are all benefit lines settled?", "Send the closing letter", "Tell the agent of record"], paid.CompletedSteps!.Select(s => s.Label));
        Assert.Equal("Yes: the payment run closed the claim", paid.CompletedSteps![1].Detail);
    }

    [Fact]
    public async Task APaymentThatLeftTheClaimOpenSkipsTheClosingLetter()
    {
        paid.Closed = false;

        var r = await RunPaidAsync();

        Assert.Equal("confirmed", r.Outcome);
        Assert.Equal("skipped", paid.CompletedSteps!.Single(s => s.Label == "Send the closing letter").State);
        Assert.StartsWith("No:", paid.CompletedSteps!.Single(s => s.Label == "Are all benefit lines settled?").Detail, StringComparison.Ordinal);
    }

    [Fact]
    public async Task ARecordedDecisionRunReplaysAgainstTheCurrentWorkflowCode()
    {
        decision.FailLettersTimes(1);   // a history with a retry in it
        var history = await WithWorkerAsync(
            o => o.AddWorkflow<DecisionRecordedWorkflow>().AddAllActivities(decision),
            async queue =>
            {
                var handle = await Client.StartWorkflowAsync((DecisionRecordedWorkflow wf) => wf.RunAsync(DecisionInput), Options("event-replay", queue));
                await handle.GetResultAsync();
                return await handle.FetchHistoryAsync();
            });

        var replayer = new WorkflowReplayer(new WorkflowReplayerOptions { DataConverter = TemporalSetup.DataConverterFor() }.AddWorkflow<DecisionRecordedWorkflow>());
        var result = await replayer.ReplayWorkflowAsync(history, true, TestContext.Current.CancellationToken);

        Assert.Null(result.ReplayFailure);
    }
}
