using Claims.Domain;
using Claims.Events;
using Claims.Temporal;
using Temporalio.Activities;

namespace Claims.Tests.Workflow;

/// <summary>In-memory stand-in for the decision event workflow's activities, with scripted failures, under the real activity names.</summary>
public sealed class FakeDecisionRecordedActivities
{
    private int lettersFailuresLeft;
    public List<string> Calls { get; } = [];
    public volatile bool RiderExplained = true;
    public volatile bool Consent = true;
    public volatile bool LettersAlwaysFail;
    public volatile IReadOnlyList<RunStep>? CompletedSteps;
    public volatile string? FailedWith;
    public volatile IReadOnlyList<RunStep>? StepsAtFailure;
    public readonly List<int> LetterAttempts = [];

    public void FailLettersTimes(int n) => Interlocked.Exchange(ref lettersFailuresLeft, n);

    public IReadOnlyList<string> CallsSnapshot()
    {
        lock (Calls) return [.. Calls];
    }

    private void Called(string name)
    {
        lock (Calls) Calls.Add(name);
    }

    [Activity("DecisionRecorded_Begin")]
    public Task<DecisionEventService.Facts> BeginAsync(DecisionRecordedActivities.Input input)
    {
        Called("begin");
        return Task.FromResult(new DecisionEventService.Facts(input.ClaimId, "L-26-043310", "Robert Castellano", "Fri 9 Oct",
            [new DecisionEventService.PayeeFact(Guid.NewGuid(), "Diane Castellano", "portal", 50m, 100_191.78m),
             new DecisionEventService.PayeeFact(Guid.NewGuid(), "Mark Castellano", "mail", 50m, 100_191.78m)],
            RiderExplained, Consent, Consent ? "Tom Bright" : null));
    }

    [Activity("DecisionRecorded_SendApprovalLetters")]
    public Task<int> SendApprovalLettersAsync(Guid decisionId)
    {
        Called("sendApprovalLetters");
        lock (LetterAttempts) LetterAttempts.Add(ActivityExecutionContext.Current.Info.Attempt);
        if (LettersAlwaysFail || Interlocked.Decrement(ref lettersFailuresLeft) >= 0) throw new InvalidOperationException("The letters service is unavailable");
        return Task.FromResult(2);
    }

    [Activity("DecisionRecorded_TellAgent")]
    public Task<bool> TellAgentAsync(Guid decisionId)
    {
        Called("tellAgent");
        return Task.FromResult(Consent);
    }

    [Activity("DecisionRecorded_Complete")]
    public Task CompleteAsync(Guid decisionId, List<RunStep> steps)
    {
        Called("complete");
        CompletedSteps = steps;
        return Task.CompletedTask;
    }

    [Activity("DecisionRecorded_RecordFailure")]
    public Task RecordFailureAsync(Guid decisionId, string error, List<RunStep> steps)
    {
        Called("recordFailure");
        FailedWith = error;
        StepsAtFailure = steps;
        return Task.CompletedTask;
    }
}

public sealed class FakePaymentConfirmedActivities
{
    public List<string> Calls { get; } = [];
    public volatile bool Closed = true;
    public volatile bool Consent = true;
    public volatile IReadOnlyList<RunStep>? CompletedSteps;

    public IReadOnlyList<string> CallsSnapshot()
    {
        lock (Calls) return [.. Calls];
    }

    private void Called(string name)
    {
        lock (Calls) Calls.Add(name);
    }

    [Activity("PaymentConfirmed_Begin")]
    public Task<PaymentEventService.Facts> BeginAsync(PaymentConfirmedActivities.Input input)
    {
        Called("begin");
        return Task.FromResult(new PaymentEventService.Facts(input.ClaimId, "L-26-043310", Closed,
            [new PaymentEventService.PaidFact(Guid.NewGuid(), "Diane Castellano", 100_191.78m), new PaymentEventService.PaidFact(Guid.NewGuid(), "Mark Castellano", 100_191.78m)],
            Consent, Consent ? "Tom Bright" : null));
    }

    [Activity("PaymentConfirmed_SendConfirmations")]
    public Task<int> SendConfirmationsAsync(PaymentConfirmedActivities.Input input)
    {
        Called("sendConfirmations");
        return Task.FromResult(2);
    }

    [Activity("PaymentConfirmed_SendClosingLetter")]
    public Task<bool> SendClosingLetterAsync(PaymentConfirmedActivities.Input input)
    {
        Called("sendClosingLetter");
        return Task.FromResult(Closed);
    }

    [Activity("PaymentConfirmed_TellAgent")]
    public Task<bool> TellAgentAsync(PaymentConfirmedActivities.Input input)
    {
        Called("tellAgent");
        return Task.FromResult(Consent);
    }

    [Activity("PaymentConfirmed_Complete")]
    public Task CompleteAsync(PaymentConfirmedActivities.Input input, List<RunStep> steps)
    {
        Called("complete");
        CompletedSteps = steps;
        return Task.CompletedTask;
    }

    [Activity("PaymentConfirmed_RecordFailure")]
    public Task RecordFailureAsync(PaymentConfirmedActivities.Input input, string error, List<RunStep> steps)
    {
        Called("recordFailure");
        return Task.CompletedTask;
    }
}
