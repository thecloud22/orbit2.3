using Temporalio.Client;
using Claims.Domain;
using Claims.Temporal;
using Temporalio.Activities;
using Temporalio.Exceptions;
using static Claims.Temporal.RequirementFollowUpActivities;

namespace Claims.Tests.Workflow;

public class RequirementFollowUpWorkflowTests(WorkflowEnvironmentFixture fixture) : WorkflowTestBase(fixture)
{
    public sealed class Fake
    {
        private readonly List<string> calls = [];
        public volatile Check CheckResult = new(true, null, "Claimant statement and W-9 · Mark", "Mark Castellano", "email");
        private int reminderFailuresLeft;
        public volatile bool RemindersAlwaysFail;
        public volatile IReadOnlyList<RunStep>? CompletedSteps;
        public volatile string? SkippedFor;
        public volatile string? FailedWith;

        public void FailRemindersTimes(int n) => Interlocked.Exchange(ref reminderFailuresLeft, n);

        public IReadOnlyList<string> Calls()
        {
            lock (calls) return [.. calls];
        }

        private void Called(string name)
        {
            lock (calls) calls.Add(name);
        }

        [Activity("RequirementFollowUp_Begin")]
        public Task<Check> BeginAsync(Guid deadlineId)
        {
            Called("begin");
            return Task.FromResult(CheckResult);
        }

        [Activity("RequirementFollowUp_SendReminder")]
        public Task SendReminderAsync(Guid deadlineId)
        {
            Called("sendReminder");
            if (RemindersAlwaysFail || Interlocked.Decrement(ref reminderFailuresLeft) >= 0) throw new InvalidOperationException("email provider timed out");
            return Task.CompletedTask;
        }

        [Activity("RequirementFollowUp_CompleteFollowUp")]
        public Task<Result> CompleteFollowUpAsync(Guid deadlineId, List<RunStep> steps)
        {
            Called("completeFollowUp");
            CompletedSteps = steps;
            return Task.FromResult(new Result("reminded", Guid.NewGuid(), "Next follow-up due 2026-10-15"));
        }

        [Activity("RequirementFollowUp_Skip")]
        public Task<Result> SkipAsync(Guid deadlineId, string reason, List<RunStep> steps)
        {
            Called("skip");
            SkippedFor = reason;
            CompletedSteps = steps;
            return Task.FromResult(new Result("skipped", null, reason));
        }

        [Activity("RequirementFollowUp_RecordFailure")]
        public Task RecordFailureAsync(Guid deadlineId, string error, List<RunStep> steps)
        {
            Called("recordFailure");
            FailedWith = error;
            return Task.CompletedTask;
        }
    }

    private readonly Fake acts = new();

    private Task<Result> RunAsync() => WithWorkerAsync(
        o => o.AddWorkflow<RequirementFollowUpWorkflow>().AddAllActivities(acts),
        queue =>
        {
            var deadline = Guid.NewGuid();
            return Client.ExecuteWorkflowAsync((RequirementFollowUpWorkflow wf) => wf.RunAsync(deadline), Options("deadline-" + deadline, queue));
        });

    [Fact]
    public async Task StillMissingSoRemindsAndWritesTheNextRow()
    {
        var r = await RunAsync();

        Assert.Equal("reminded", r.Outcome);
        Assert.NotNull(r.NextDeadlineId);
        Assert.Equal(["begin", "sendReminder", "completeFollowUp"], acts.Calls());
        Assert.Equal(["Re-check: is it still missing?", "Send a reminder"], acts.CompletedSteps!.Select(s => s.Label));
        Assert.Equal("Mark Castellano by email", acts.CompletedSteps![1].Detail);
    }

    [Fact]
    public async Task StopsWithoutRemindingWhenTheRequirementIsAlreadyMet()
    {
        acts.CheckResult = new Check(false, "Requirement is already accepted", "Claimant statement and W-9 · Mark", "Mark Castellano", "email");

        var r = await RunAsync();

        Assert.Equal("skipped", r.Outcome);
        Assert.Equal(["begin", "skip"], acts.Calls());   // no reminder, no next row
        Assert.Equal("Requirement is already accepted", acts.SkippedFor);
    }

    [Fact]
    public async Task AFailedReminderIsRetriedBeforeAnythingIsSaved()
    {
        acts.FailRemindersTimes(2);

        var r = await RunAsync();

        Assert.Equal("reminded", r.Outcome);
        Assert.Equal(3, acts.Calls().Count(c => c == "sendReminder"));
        Assert.Single(acts.Calls(), c => c == "completeFollowUp");   // saved once, after the retries
    }

    [Fact]
    public async Task WhenRetriesRunOutTheRunIsRecordedAsFailedAndNoNextRowIsWritten()
    {
        acts.RemindersAlwaysFail = true;

        await Assert.ThrowsAsync<WorkflowFailedException>(RunAsync);

        Assert.Equal("recordFailure", acts.Calls()[^1]);
        Assert.DoesNotContain("completeFollowUp", acts.Calls());
        Assert.Contains("email provider timed out", acts.FailedWith);
    }
}
