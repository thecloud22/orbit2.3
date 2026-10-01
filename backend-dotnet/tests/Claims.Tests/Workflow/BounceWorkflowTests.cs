using Claims.Temporal;
using Temporalio.Api.Enums.V1;
using Temporalio.Client;
using Temporalio.Exceptions;
using Temporalio.Worker;

namespace Claims.Tests.Workflow;

/// <summary>
/// The four workflows of "things bounce back", on Temporal's time-skipping test server with fake activities and no database: what each does with the answer it gets, and above all the
/// difference between an ANSWER (the IRS says "no match": no retry) and a FAILURE (a 503: retried), the retry schedule when the letters service is down, and the id-reuse policy that
/// makes an ops re-run possible only after a failure.
/// </summary>
public class BounceWorkflowTests(WorkflowEnvironmentFixture fixture) : WorkflowTestBase(fixture)
{
    private readonly FakeDocumentReceivedActivities received = new();
    private readonly FakeDocumentRejectedActivities rejected = new();
    private readonly FakePaymentReturnedActivities returned = new();
    private readonly FakePaymentMethodUpdatedActivities method = new();

    private static DocumentReceivedActivities.Input ReceivedInput => new(Guid.NewGuid(), Guid.NewGuid(), Guid.NewGuid());

    private static DocumentRejectedActivities.Input RejectedInput => new(Guid.NewGuid(), Guid.NewGuid(), Guid.NewGuid());

    private Task<DocumentReceivedWorkflow.Result> RunReceivedAsync() => WithWorkerAsync(
        o => o.AddWorkflow<DocumentReceivedWorkflow>().AddAllActivities(received),
        queue => Client.ExecuteWorkflowAsync((DocumentReceivedWorkflow wf) => wf.RunAsync(ReceivedInput), Options("event-doc", queue)));

    // ------------------------------------------------------------------ document received

    [Fact]
    public async Task ATinThatDoesNotMatchIsAnAnswerNotAnErrorSoTemporalDoesNotRetryIt()
    {
        received.TinMatch = false;

        var r = await RunReceivedAsync();

        Assert.Equal("not_enough", r.Outcome);
        // One check, exactly: an answer is returned normally, so nothing is retried; the workflow took its not-enough branch and ended.
        Assert.Equal(["begin", "checkTin", "markNotEnough:TIN mismatch", "askForCorrection", "completeNotEnough"], received.CallsSnapshot());
        Assert.Equal([1], received.TinAttempts);
        Assert.Equal(["Read the document", "Check the taxpayer ID", "Mark the requirement not enough", "Ask for a corrected W-9"], received.FinalSteps!.Select(s => s.Label));
        Assert.All(received.FinalSteps!, s => Assert.Equal("done", s.State));
        Assert.Contains("answer, not an error", received.FinalNote, StringComparison.Ordinal);
    }

    [Fact]
    public async Task AMatchIsAcceptedThroughTheAcceptStep()
    {
        var r = await RunReceivedAsync();

        Assert.Equal("accepted", r.Outcome);
        Assert.Equal(["begin", "checkTin", "accept"], received.CallsSnapshot());
        Assert.Equal("IRS TIN match: ok", received.FinalSteps!.Single(s => s.Label == "Check the taxpayer ID").Detail);
    }

    [Fact]
    public async Task AFailureOfTheIrsServiceIsRetriedAndTheStepShowsHowManyAttempts()
    {
        received.FailTinTimes(2);   // a 503 twice, then an answer
        var before = await Env.GetCurrentTimeAsync();

        var r = await RunReceivedAsync();

        Assert.Equal("accepted", r.Outcome);
        Assert.Equal([1, 2, 3], received.TinAttempts);
        var step = received.FinalSteps!.Single(s => s.Label == "Check the taxpayer ID");
        Assert.Equal(("retried", 3), (step.State, step.Attempts));
        Assert.NotNull(step.Note);
        Assert.True(await Env.GetCurrentTimeAsync() - before >= TimeSpan.FromSeconds(6));   // waits of 2 and 4 s
    }

    [Fact]
    public async Task ARerunOfADocumentWorkflowAfterAFailedLetterGoesDownTheAcceptPathWithoutAskingForACorrection()
    {
        var input = ReceivedInput;
        var id = "event-doc-rerun-" + Guid.NewGuid();
        Task<DocumentReceivedWorkflow.Result> RunAs(string queue) => Client.ExecuteWorkflowAsync((DocumentReceivedWorkflow wf) => wf.RunAsync(input),
            new WorkflowOptions(id, queue) { IdReusePolicy = WorkflowIdReusePolicy.AllowDuplicateFailedOnly });

        var (run2, calls) = await WithWorkerAsync(o => o.AddWorkflow<DocumentReceivedWorkflow>().AddAllActivities(received), async queue =>
        {
            // Run 1: "no match", the letters service is down: the retries run out, the run fails (the letter row is queued in Postgres).
            received.TinMatch = false;
            received.LettersAlwaysFail = true;
            await Assert.ThrowsAsync<WorkflowFailedException>(() => RunAs(queue));
            var afterRun1 = received.CallsSnapshot();
            // Run 2 under the same id, the fault gone: the taxpayer number matches now.
            received.TinMatch = true;
            received.LettersAlwaysFail = false;
            var r = await RunAs(queue);
            return (r, (afterRun1, received.CallsSnapshot().Skip(afterRun1.Count).ToList()));
        });

        Assert.Equal("accepted", run2.Outcome);
        Assert.Equal(["begin", "checkTin", "markNotEnough:TIN mismatch", "askForCorrection", "askForCorrection", "askForCorrection", "askForCorrection", "askForCorrection", "recordFailure"], calls.Item1);
        // Run 2 accepts (the accept step is where the still-queued letter of run 1 is skipped) and asks for nothing.
        Assert.Equal(["begin", "checkTin", "accept"], calls.Item2);
    }

    [Fact]
    public async Task ACertifiedOriginalIsAcceptedAndAPhotocopyIsHandedToAPersonAndTheWorkflowEnds()
    {
        received.Route = "accept";
        received.Kind = "death_certificate";
        var accepted = await RunReceivedAsync();
        Assert.Equal("accepted", accepted.Outcome);
        Assert.Equal(["begin", "accept"], received.CallsSnapshot());

        var photocopy = new FakeDocumentReceivedActivities { Route = "review", Kind = "death_certificate", Reason = "A photocopy: the rules accept only a certified original" };
        var handed = await WithWorkerAsync(o => o.AddWorkflow<DocumentReceivedWorkflow>().AddAllActivities(photocopy),
            queue => Client.ExecuteWorkflowAsync((DocumentReceivedWorkflow wf) => wf.RunAsync(ReceivedInput), Options("event-doc", queue)));
        Assert.Equal("needs_review", handed.Outcome);
        // Ends: no waiting for the examiner. The hand-off is the last thing it does.
        Assert.Equal(["begin", "handToPerson"], photocopy.CallsSnapshot());
        Assert.Equal(["Read the document", "Can the rules accept it?", "Ask the examiner"], photocopy.FinalSteps!.Select(s => s.Label));
        Assert.Contains("not a sleeping workflow", photocopy.FinalNote, StringComparison.Ordinal);
    }

    [Fact]
    public async Task WhenTheIrsServiceStaysDownTheRetriesRunOutTheFailureIsRecordedAndTheWorkflowFails()
    {
        received.FailTinTimes(99);

        var e = await Assert.ThrowsAsync<WorkflowFailedException>(RunReceivedAsync);

        Assert.IsType<ActivityFailureException>(e.InnerException);
        Assert.Equal(5, received.TinAttempts.Count);
        Assert.Equal("recordFailure", received.CallsSnapshot()[^1]);
        var failed = received.StepsAtFailure!.Last();
        Assert.Equal(("failed", 5), (failed.State, failed.Attempts));
        Assert.Equal("Check the taxpayer ID", failed.Label);
    }

    // ------------------------------------------------------------------ document rejected: the letter, the failed run and run 2

    private Task<DocumentRejectedWorkflow.Result> RunRejectedAsync(string workflowId, string queue) =>
        Client.ExecuteWorkflowAsync((DocumentRejectedWorkflow wf) => wf.RunAsync(RejectedInput),
            new WorkflowOptions(workflowId, queue) { IdReusePolicy = WorkflowIdReusePolicy.AllowDuplicateFailedOnly });

    [Fact]
    public async Task WithTheLettersServiceDownTheSendIsRetriedFiveTimesWithGrowingWaitsThenTheRunFails()
    {
        rejected.LettersAlwaysFail = true;
        var before = await Env.GetCurrentTimeAsync();

        var e = await Assert.ThrowsAsync<WorkflowFailedException>(() => WithWorkerAsync(o => o.AddWorkflow<DocumentRejectedWorkflow>().AddAllActivities(rejected),
            queue => RunRejectedAsync("event-rejected-" + Guid.NewGuid(), queue)));

        Assert.IsType<ActivityFailureException>(e.InnerException);
        Assert.Equal([1, 2, 3, 4, 5], rejected.LetterAttempts);
        // 2 + 4 + 8 + 16 seconds between the five attempts, in workflow time.
        Assert.True(await Env.GetCurrentTimeAsync() - before >= TimeSpan.FromSeconds(30));
        Assert.Equal("recordFailure", rejected.CallsSnapshot()[^1]);
        Assert.DoesNotContain("complete", rejected.CallsSnapshot());
        Assert.Equal(["Build the letter", "Send it", "Record the failure"], rejected.StepsAtFailure!.Select(s => s.Label));
        Assert.Equal(("failed", 5), (rejected.StepsAtFailure![1].State, rejected.StepsAtFailure![1].Attempts));
        Assert.Contains("503", rejected.FailedWith, StringComparison.Ordinal);
    }

    [Fact]
    public async Task ARerunUnderTheSameWorkflowIdIsAllowedAfterAFailureAndRefusedAfterItCompleted()
    {
        var id = "event-rerun-" + Guid.NewGuid();
        var queueRun = await WithWorkerAsync(o => o.AddWorkflow<DocumentRejectedWorkflow>().AddAllActivities(rejected), async queue =>
        {
            // Run 1: the letters service is down, so the workflow fails.
            rejected.LettersAlwaysFail = true;
            await Assert.ThrowsAsync<WorkflowFailedException>(() => RunRejectedAsync(id, queue));

            // The service is back. Run 2 starts under the SAME id: allowed, because the last run failed.
            rejected.LettersAlwaysFail = false;
            var run2 = await RunRejectedAsync(id, queue);
            Assert.Equal("letter_sent", run2.Outcome);

            // Run 3 would be a duplicate of a COMPLETED workflow: refused, which is also what makes a repeated outbox start a no-op.
            await Assert.ThrowsAsync<WorkflowAlreadyStartedException>(() => RunRejectedAsync(id, queue));
            return queue;
        });
        Assert.NotEmpty(queueRun);
        Assert.Equal(1, rejected.CallsSnapshot().Count(c => c == "complete"));      // one letter workflow completed, ever
        Assert.Equal(1, rejected.CallsSnapshot().Count(c => c == "recordFailure"));  // one failure recorded
    }

    // ------------------------------------------------------------------ payment returned, new account

    [Fact]
    public async Task APaymentReturnedReopensTheClaimAsksThePayeeAndTellsTheExaminerThenEnds()
    {
        var r = await WithWorkerAsync(o => o.AddWorkflow<PaymentReturnedWorkflow>().AddAllActivities(returned),
            queue => Client.ExecuteWorkflowAsync((PaymentReturnedWorkflow wf) => wf.RunAsync(new PaymentReturnedActivities.Input(Guid.NewGuid(), Guid.NewGuid(), Guid.NewGuid())),
                Options("event-returned", queue)));

        Assert.Equal("reopened", r.Outcome);
        Assert.Equal(["begin", "reopen", "askForNewAccount", "complete"], returned.CallsSnapshot());
        Assert.Equal(["Read the return", "Reopen the claim", "Stop paying the closed account", "Ask Mark for a new account", "Tell the examiner"], returned.CompletedSteps!.Select(s => s.Label));
        Assert.Equal("Closed → Reopened · payment returned", returned.CompletedSteps![1].Detail);
    }

    [Fact]
    public async Task ANewAccountThatVerifiesIsConfirmedAndOneThatDoesNotIsHeld()
    {
        Task<PaymentMethodUpdatedWorkflow.Result> Run() => WithWorkerAsync(o => o.AddWorkflow<PaymentMethodUpdatedWorkflow>().AddAllActivities(method),
            queue => Client.ExecuteWorkflowAsync((PaymentMethodUpdatedWorkflow wf) => wf.RunAsync(new PaymentMethodUpdatedActivities.Input(Guid.NewGuid(), Guid.NewGuid(), Guid.NewGuid())),
                Options("event-method", queue)));

        var ok = await Run();
        Assert.Equal("verified", ok.Outcome);
        Assert.Equal(["begin", "verify", "confirm", "complete"], method.CallsSnapshot());
        Assert.Equal("verified", method.CompletedStatus);

        method.Calls.Clear();
        method.Verifies = false;
        var no = await Run();
        Assert.Equal("rejected", no.Outcome);   // "not verified" is an answer: no retry, the replacement is held
        Assert.Equal(["begin", "verify", "reject", "complete"], method.CallsSnapshot());
        Assert.Equal("rejected", method.CompletedStatus);
    }

    // ------------------------------------------------------------------ replay: the new workflows stay compatible with runs in flight

    [Fact]
    public async Task ARecordedDocumentRunWithARetryAndARecordedFailedLetterRunReplayAgainstTheCurrentCode()
    {
        received.FailTinTimes(1);   // a history with a retry in it
        var docHistory = await WithWorkerAsync(o => o.AddWorkflow<DocumentReceivedWorkflow>().AddAllActivities(received), async queue =>
        {
            var handle = await Client.StartWorkflowAsync((DocumentReceivedWorkflow wf) => wf.RunAsync(ReceivedInput), Options("event-replay-doc", queue));
            await handle.GetResultAsync();
            return await handle.FetchHistoryAsync();
        });
        rejected.LettersAlwaysFail = true;   // a history that ends in a failure
        var failedHistory = await WithWorkerAsync(o => o.AddWorkflow<DocumentRejectedWorkflow>().AddAllActivities(rejected), async queue =>
        {
            var handle = await Client.StartWorkflowAsync((DocumentRejectedWorkflow wf) => wf.RunAsync(RejectedInput), Options("event-replay-rejected", queue));
            await Assert.ThrowsAsync<WorkflowFailedException>(() => handle.GetResultAsync());
            return await handle.FetchHistoryAsync();
        });

        var replayer = new WorkflowReplayer(new WorkflowReplayerOptions { DataConverter = TemporalSetup.DataConverterFor() }
            .AddWorkflow<DocumentReceivedWorkflow>().AddWorkflow<DocumentRejectedWorkflow>());
        Assert.Null((await replayer.ReplayWorkflowAsync(docHistory, true, TestContext.Current.CancellationToken)).ReplayFailure);
        Assert.Null((await replayer.ReplayWorkflowAsync(failedHistory, true, TestContext.Current.CancellationToken)).ReplayFailure);
    }
}
