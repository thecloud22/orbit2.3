using Claims.Domain;
using Claims.Events;
using Claims.Temporal;
using Temporalio.Activities;

namespace Claims.Tests.Workflow;

/// <summary>Scripted stand-ins, under the real activity names, for the document workflows (no database): the route the rules pick, the IRS answer, and scripted failures.</summary>
public sealed class FakeDocumentReceivedActivities
{
    private int tinFailuresLeft;
    public List<string> Calls { get; } = [];
    public volatile string Route = "tin_check";
    public volatile string Reason = "Claimant statement with a W-9: the taxpayer number is checked with the IRS";
    public volatile string Kind = "claimant_statement_w9";
    public volatile bool TinMatch = true;
    public volatile bool LettersAlwaysFail;
    public readonly List<int> TinAttempts = [];
    public volatile IReadOnlyList<RunStep>? FinalSteps;
    public volatile string? FinalNote;
    public volatile string? FailedWith;
    public volatile string? HandOffReason;
    public volatile IReadOnlyList<RunStep>? StepsAtFailure;

    public void FailTinTimes(int n) => Interlocked.Exchange(ref tinFailuresLeft, n);

    public IReadOnlyList<string> CallsSnapshot()
    {
        lock (Calls) return [.. Calls];
    }

    private void Called(string name)
    {
        lock (Calls) Calls.Add(name);
    }

    [Activity("DocumentReceived_Begin")]
    public Task<DocumentEventService.Facts> BeginAsync(DocumentReceivedActivities.Input input)
    {
        Called("begin");
        return Task.FromResult(new DocumentEventService.Facts(input.ClaimId, "L-26-043310", Kind, "portal", Route, Reason, "Claimant statement and W-9 · Diane", "Diane Castellano", 1));
    }

    [Activity("DocumentReceived_CheckTin")]
    public Task<DocumentEventService.TinCheck> CheckTinAsync(DocumentReceivedActivities.Input input)
    {
        Called("checkTin");
        var attempt = ActivityExecutionContext.Current.Info.Attempt;
        lock (TinAttempts) TinAttempts.Add(attempt);
        if (Interlocked.Decrement(ref tinFailuresLeft) >= 0) throw new InvalidOperationException("The IRS TIN matching service returned 503");
        return Task.FromResult(new DocumentEventService.TinCheck(TinMatch, "irs-1", TinMatch ? "match" : "no match", attempt));
    }

    [Activity("DocumentReceived_Accept")]
    public Task<bool> AcceptAsync(DocumentReceivedActivities.Input input, List<RunStep> steps, string note)
    {
        Called("accept");
        FinalSteps = steps;
        FinalNote = note;
        return Task.FromResult(true);
    }

    [Activity("DocumentReceived_MarkNotEnough")]
    public Task<DocumentEventService.NotEnough> MarkNotEnoughAsync(DocumentReceivedActivities.Input input, string reason)
    {
        Called("markNotEnough:" + reason);
        return Task.FromResult(new DocumentEventService.NotEnough(Guid.NewGuid(), "Diane Castellano", "2026-10-06"));
    }

    [Activity("DocumentReceived_AskForCorrection")]
    public Task<SendResult> AskForCorrectionAsync(DocumentReceivedActivities.Input input)
    {
        Called("askForCorrection");
        if (LettersAlwaysFail) throw new InvalidOperationException("The letters service returned 503");
        return Task.FromResult(new SendResult(true, ActivityExecutionContext.Current.Info.Attempt));
    }

    [Activity("DocumentReceived_CompleteNotEnough")]
    public Task CompleteNotEnoughAsync(DocumentReceivedActivities.Input input, List<RunStep> steps, string note)
    {
        Called("completeNotEnough");
        FinalSteps = steps;
        FinalNote = note;
        return Task.CompletedTask;
    }

    [Activity("DocumentReceived_HandToPerson")]
    public Task HandToPersonAsync(DocumentReceivedActivities.Input input, string reason, List<RunStep> steps, string note)
    {
        Called("handToPerson");
        HandOffReason = reason;
        FinalSteps = steps;
        FinalNote = note;
        return Task.CompletedTask;
    }

    [Activity("DocumentReceived_RecordFailure")]
    public Task RecordFailureAsync(DocumentReceivedActivities.Input input, string error, List<RunStep> steps)
    {
        Called("recordFailure");
        FailedWith = error;
        StepsAtFailure = steps;
        return Task.CompletedTask;
    }
}

public sealed class FakeDocumentRejectedActivities
{
    private int lettersFailuresLeft;
    public List<string> Calls { get; } = [];
    public volatile bool LettersAlwaysFail;
    public readonly List<int> LetterAttempts = [];
    public volatile IReadOnlyList<RunStep>? CompletedSteps;
    public volatile IReadOnlyList<RunStep>? StepsAtFailure;
    public volatile string? FailedWith;

    public void FailLettersTimes(int n) => Interlocked.Exchange(ref lettersFailuresLeft, n);

    public IReadOnlyList<string> CallsSnapshot()
    {
        lock (Calls) return [.. Calls];
    }

    private void Called(string name)
    {
        lock (Calls) Calls.Add(name);
    }

    [Activity("DocumentRejected_Begin")]
    public Task<DocumentEventService.RejectedFacts> BeginAsync(DocumentRejectedActivities.Input input)
    {
        Called("begin");
        return Task.FromResult(new DocumentEventService.RejectedFacts(input.ClaimId, "L-26-043310", "Diane Castellano", "Certified death certificate", "Photocopy, not certified", 1));
    }

    [Activity("DocumentRejected_SendLetter")]
    public Task<SendResult> SendLetterAsync(DocumentRejectedActivities.Input input)
    {
        Called("sendLetter");
        var attempt = ActivityExecutionContext.Current.Info.Attempt;
        lock (LetterAttempts) LetterAttempts.Add(attempt);
        if (LettersAlwaysFail || Interlocked.Decrement(ref lettersFailuresLeft) >= 0) throw new InvalidOperationException("The letters service returned 503");
        return Task.FromResult(new SendResult(true, attempt));
    }

    [Activity("DocumentRejected_Complete")]
    public Task CompleteAsync(DocumentRejectedActivities.Input input, List<RunStep> steps)
    {
        Called("complete");
        CompletedSteps = steps;
        return Task.CompletedTask;
    }

    [Activity("DocumentRejected_RecordFailure")]
    public Task RecordFailureAsync(DocumentRejectedActivities.Input input, string error, List<RunStep> steps)
    {
        Called("recordFailure");
        FailedWith = error;
        StepsAtFailure = steps;
        return Task.CompletedTask;
    }
}

public sealed class FakePaymentReturnedActivities
{
    public List<string> Calls { get; } = [];
    public volatile bool Reopened = true;
    public volatile IReadOnlyList<RunStep>? CompletedSteps;

    public IReadOnlyList<string> CallsSnapshot()
    {
        lock (Calls) return [.. Calls];
    }

    private void Called(string name)
    {
        lock (Calls) Calls.Add(name);
    }

    [Activity("PaymentReturned_Begin")]
    public Task<PaymentReturnEventService.ReturnFacts> BeginAsync(PaymentReturnedActivities.Input input)
    {
        Called("begin");
        return Task.FromResult(new PaymentReturnEventService.ReturnFacts(input.ClaimId, "L-26-043310", input.PaymentItemId, Guid.NewGuid(), "Mark Castellano", "$100,230.14", "R02", "Account closed", "closed", 1));
    }

    [Activity("PaymentReturned_Reopen")]
    public Task<PaymentReturnEventService.ReopenResult> ReopenAsync(PaymentReturnedActivities.Input input)
    {
        Called("reopen");
        return Task.FromResult(new PaymentReturnEventService.ReopenResult(Reopened, Reopened ? "reopened" : "paying", "2026-10-19", "Rachel Kim"));
    }

    [Activity("PaymentReturned_AskForNewAccount")]
    public Task<SendResult> AskForNewAccountAsync(PaymentReturnedActivities.Input input)
    {
        Called("askForNewAccount");
        return Task.FromResult(new SendResult(true, 1));
    }

    [Activity("PaymentReturned_Complete")]
    public Task CompleteAsync(PaymentReturnedActivities.Input input, List<RunStep> steps, string note)
    {
        Called("complete");
        CompletedSteps = steps;
        return Task.CompletedTask;
    }

    [Activity("PaymentReturned_RecordFailure")]
    public Task RecordFailureAsync(PaymentReturnedActivities.Input input, string error, List<RunStep> steps)
    {
        Called("recordFailure");
        return Task.CompletedTask;
    }
}

public sealed class FakePaymentMethodUpdatedActivities
{
    public List<string> Calls { get; } = [];
    public volatile bool Verifies = true;
    public volatile IReadOnlyList<RunStep>? CompletedSteps;
    public volatile string? CompletedStatus;

    public IReadOnlyList<string> CallsSnapshot()
    {
        lock (Calls) return [.. Calls];
    }

    private void Called(string name)
    {
        lock (Calls) Calls.Add(name);
    }

    [Activity("PaymentMethodUpdated_Begin")]
    public Task<PaymentReturnEventService.MethodFacts> BeginAsync(PaymentMethodUpdatedActivities.Input input)
    {
        Called("begin");
        return Task.FromResult(new PaymentReturnEventService.MethodFacts(input.ClaimId, input.PaymentMethodId, Guid.NewGuid(), "Mark Castellano", "0021", "4417", "pending_verification", 1, 1));
    }

    [Activity("PaymentMethodUpdated_VerifyAccount")]
    public Task<PaymentReturnEventService.Verified> VerifyAccountAsync(PaymentMethodUpdatedActivities.Input input)
    {
        Called("verify");
        return Task.FromResult(new PaymentReturnEventService.Verified(Verifies, "v-1", Verifies ? "Account open · name matches" : "Account closed or not found", ActivityExecutionContext.Current.Info.Attempt));
    }

    [Activity("PaymentMethodUpdated_Confirm")]
    public Task<SendResult> ConfirmAsync(PaymentMethodUpdatedActivities.Input input)
    {
        Called("confirm");
        return Task.FromResult(new SendResult(true, 1));
    }

    [Activity("PaymentMethodUpdated_Reject")]
    public Task<int> RejectAsync(PaymentMethodUpdatedActivities.Input input, string detail)
    {
        Called("reject");
        return Task.FromResult(1);
    }

    [Activity("PaymentMethodUpdated_Complete")]
    public Task CompleteAsync(PaymentMethodUpdatedActivities.Input input, string status, List<RunStep> steps, string note)
    {
        Called("complete");
        CompletedStatus = status;
        CompletedSteps = steps;
        return Task.CompletedTask;
    }

    [Activity("PaymentMethodUpdated_RecordFailure")]
    public Task RecordFailureAsync(PaymentMethodUpdatedActivities.Input input, string error, List<RunStep> steps)
    {
        Called("recordFailure");
        return Task.CompletedTask;
    }
}
