namespace Claims.Domain;

/// <summary>
/// The claim state machine. <c>Received</c> = notice saved, intake run has not finished set-up. <c>InReview</c> = proof of loss complete, waiting
/// for a decision. <c>AwaitingApproval</c> = decided above the examiner's authority. <c>Approved</c> = payment items cleared, waiting for a
/// payment run. <c>Paying</c> = at least one item is in a run. <c>Closed</c> = every item paid. <c>Reopened</c> = a closed claim whose payment the
/// bank returned; it closes again when the replacement item is paid (only <c>PaymentReturnedWorkflow</c> moves a claim from closed to reopened).
/// </summary>
public enum ClaimStatus { Received, GatheringEvidence, InReview, AwaitingApproval, Approved, Paying, Closed, Reopened }

public static class ClaimStatusExtensions
{
    /// <summary>No more evidence chasing once proof is complete and the claim is being decided, paid or closed.</summary>
    public static bool DecidedOrClosed(this ClaimStatus s) => s is ClaimStatus.AwaitingApproval or ClaimStatus.Approved or ClaimStatus.Paying or ClaimStatus.Closed or ClaimStatus.Reopened;
}
