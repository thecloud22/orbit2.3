using System.Globalization;
using Claims.Domain;

namespace Claims.View;

// The JSON resources the API returns. Field names are camelCase; enum values are snake_case (the same strings the
// database stores); money is {amount: "200000.00", currency: "USD"}; timestamps are UTC instants (RFC 3339); business
// dates are plain dates. Nulls are written, as in the Java version.

public sealed record Money(string Amount, string Currency)
{
    public static Money Of(decimal amount, string currency) =>
        new(decimal.Round(amount, 2).ToString("F2", CultureInfo.InvariantCulture), currency.Trim());
}

public sealed record Page<T>(IReadOnlyList<T> Items, string? NextCursor)
{
    public static Page<T> Of(IReadOnlyList<T> items) => new(items, null);
}

/// <summary>
/// GET /claims/{id}/decisions: the decision versions (each <c>amount</c> is that decision's OWN line: the rider is a decision of its own) and, added, <c>ClaimTotal</c>:
/// the sum of the amounts of the decisions that count (in effect or awaiting approval; a version that a later one supersedes does not), null when none has an amount.
/// </summary>
public sealed record DecisionList(IReadOnlyList<DecisionView> Items, string? NextCursor, Money? ClaimTotal)
{
    public static DecisionList Of(IReadOnlyList<DecisionView> items)
    {
        var superseded = items.Where(d => d.SupersedesId is not null).Select(d => d.SupersedesId!.Value).ToHashSet();
        var counting = items.Where(d => d.Amount is not null && !superseded.Contains(d.Id) && d.Status is "in_effect" or "awaiting_approval").ToList();
        var total = counting.Count == 0 ? null : Money.Of(counting.Sum(d => decimal.Parse(d.Amount!.Amount, CultureInfo.InvariantCulture)), counting[0].Amount!.Currency);
        return new DecisionList(items, null, total);
    }
}

public sealed record PartyRef(Guid Id, string Name);

public sealed record ClaimPartyView(Guid PartyId, string Name, string Role, string? Relationship, string? BeneficiaryKind,
                                    string? SharePercent, bool Payee, string? PacketChannel, string? AccessNote, DateOnly? DiedOn);

public sealed record LifeDetails(string Kind, DateOnly DateOfDeath, string? PlaceOfDeath, string MannerOfDeath, bool DeathOutsideUs,
                                 string? FuneralHome, Guid CallerPartyId, string? CallerRelationship, IReadOnlyList<string> ContactBy,
                                 bool AgentConsent, bool OtherClaimantsPossible, string IntakeChannel);

public sealed record BenefitLineView(Guid Id, string PolicyNumber, string Kind, Guid? ParentLineId, string? RiderKey, string Name,
                                     Money Amount, string Status, string? WaitingOn, string ProductConfigVersion, long Version);

public sealed record ClaimView(Guid Id, string ClaimNumber, string Family, string ProductCode, string Status, string? Track,
                               string? RouteRule, IReadOnlyList<string> RouteReasons, Guid? OwnerId, string Team, DateTimeOffset NoticedAt,
                               DateTimeOffset? ProofCompleteAt, DateTimeOffset? ClosedAt, PartyRef Insured, LifeDetails? Details,
                               IReadOnlyList<BenefitLineView> BenefitLines, IReadOnlyList<ClaimPartyView> Parties,
                               long Version, DateTimeOffset CreatedAt, DateTimeOffset UpdatedAt);

public sealed record ClaimSummary(Guid Id, string ClaimNumber, string Family, string ProductCode, string Status, string? Track,
                                  Guid? OwnerId, string InsuredName, DateTimeOffset NoticedAt, long Version);

public sealed record RequirementSource(Guid? PartyId, string Label, string? Detail);

public sealed record RequirementView(Guid Id, Guid ClaimId, Guid? BenefitLineId, string Key, string Name, string Purpose,
                                     RequirementSource From, string State, string? StateNote, DateTimeOffset RequestedAt, int FollowUpDays, int FollowUpCount,
                                     DateTimeOffset? LastReminderAt, DateTimeOffset? ReceivedAt, DateTimeOffset? AcceptedAt, string? SatisfiedBy,
                                     DateTimeOffset? WaivedAt, string? WaiveReason, long Version);

public sealed record DeadlineView(Guid Id, Guid ClaimId, string Kind, Guid? RequirementId, Guid? DocumentId, Guid? PartyId, string What, string? Sla, DateTimeOffset DueAt,
                                  DateTimeOffset OriginalDueAt, string? ExtensionReason, string State, int Attempt, DateTimeOffset? DispatchedAt,
                                  bool Fired, string? LastOutcome, string? LastError, string? WorkflowId, DateTimeOffset? ClosedAt,
                                  string? ClosedBy, string? Result, long Version);

public sealed record LetterView(Guid Id, Guid ClaimId, Guid? BenefitLineId, string TemplateCode, string Channel, Guid? RecipientPartyId,
                                string RecipientLabel, string Subject, string? Summary, string Status, DateTimeOffset? SentAt,
                                string? WorkflowId, DateTimeOffset CreatedAt, string? StatusReason = null);

public sealed record HistoryEventView(Guid Id, Guid ClaimId, DateTimeOffset OccurredAt, DateTimeOffset RecordedAt, string Type, string Title,
                                      string ActorKind, string Actor, string? Detail, string? Ref, string? WorkflowId);

public sealed record WorkItemView(Guid Id, Guid? OwnerId, Guid ClaimId, int Priority, string Action, string Why, DateOnly DueOn,
                                  string WaitingOn, string? Flag, string Section, string Status, long Version);

public sealed record WorkflowRunView(Guid Id, string WorkflowId, string RunId, string Type, string Name, Guid? ClaimId,
                                     string StartedBy, string? TriggerKind, Guid? TriggerId, string Status, DateTimeOffset StartedAt,
                                     DateTimeOffset? FinishedAt, IReadOnlyList<RunStep> Steps, IReadOnlyList<string> Saved, string? Error,
                                     int RunNo, Guid? RerunOfId, string? Note, int? ElapsedMs, bool CanRerun);

/// <summary>A decision version. Immutable; <c>Status</c> and the approval come from the separate approval row.</summary>
public sealed record DecisionView(Guid Id, Guid ClaimId, Guid BenefitLineId, string BenefitLineName, int Version, Guid? SupersedesId,
                                  string Outcome, string OutcomeText, string Basis, IReadOnlyList<string> Evidence,
                                  IReadOnlyList<string> Provisions, Money? Amount, DateTimeOffset RecordedAt, Guid RecordedBy,
                                  string RecordedByName, string AuthorityNote, bool RequiresApproval, string Status, Guid? ApprovedBy,
                                  string? ApprovedByName, DateTimeOffset? ApprovedAt, string? LetterTemplate);

public sealed record PaymentItemView(Guid Id, Guid ClaimId, Guid BenefitLineId, Guid? DecisionId, string Kind, Guid? AdjustsItemId,
                                     Guid? ReplacementOfId, Guid? ReplacedById, Guid? PaymentMethodId, Guid PayeePartyId, string PayeeName, string Basis, Money Principal, Money Interest,
                                     Money Amount, string Method, DateOnly PayOn, string Status, string? HoldReason, Guid? RunId,
                                     DateTimeOffset? PaidAt, string? PaymentReference, string? ReturnCode, string? ReturnReason, long Version);

public sealed record PaymentRunView(Guid Id, DateOnly RunDate, string Status, string Trigger, int ItemCount, int PaidCount, int ReturnedCount,
                                    Money Total, string? FileReference, string? Error, DateTimeOffset StartedAt, DateTimeOffset? FinishedAt);

/// <param name="Kind">recorded | awaiting_approval</param>
public sealed record RecordDecisionResult(string Kind, string Message, DecisionView Decision, IReadOnlyList<DecisionView> RelatedDecisions,
                                          IReadOnlyList<PaymentItemView> PaymentItems, Guid? ApprovalWorkItemId);

public sealed record DevClockView(DateTimeOffset Now, DateTimeOffset RealNow, double OffsetSeconds, bool Virtual, DateOnly BusinessDate, string Zone);

public sealed record DueDeadlineView(Guid Id, Guid ClaimId, string Kind, string What, DateTimeOffset DueAt);

public sealed record DevClockAdvancedView(DateTimeOffset Now, DateTimeOffset RealNow, double OffsetSeconds, bool Virtual, DateOnly BusinessDate,
                                          string Zone, IReadOnlyList<DueDeadlineView> DueDeadlines);

/// <summary>A staff user: who a work item's owner id is, and how much they may approve alone. Read-only; there is no staff administration yet.</summary>
public sealed record StaffView(Guid Id, string Handle, string Name, string? Title, string Team, string Role, Money PayoutLimit);

public sealed record DocumentAttributesView(string? TinMasked, bool? Photocopy, bool? SealPresent);

public sealed record DocumentView(Guid Id, Guid ClaimId, Guid? RequirementId, string? RequirementName, Guid? PartyId, string? PartyName, string Kind,
                                  string Source, DocumentAttributesView Attributes, string Status, string? StatusNote, DateTimeOffset ReceivedAt,
                                  string ReceivedBy, string? ReviewedBy, DateTimeOffset? ReviewedAt, string? ReviewReason, string? WorkflowId, long Version);

public sealed record PaymentMethodView(Guid Id, Guid PartyId, Guid ClaimId, string Kind, string RoutingLast4, string AccountLast4, string? HolderName,
                                       string Status, DateTimeOffset CreatedAt, DateTimeOffset? VerifiedAt, long Version);

public sealed record PaymentMethodHoldView(Guid Id, Guid PartyId, Guid ClaimId, Guid SourceItemId, string Reason, DateTimeOffset CreatedAt, Guid? SupersededByMethodId);

public sealed record PaymentMethodsView(IReadOnlyList<PaymentMethodView> Items, IReadOnlyList<PaymentMethodHoldView> Holds, string? NextCursor);

public sealed record PaymentMethodUpdatedView(PaymentMethodView PaymentMethod, IReadOnlyList<PaymentItemView> ReplacementItems, DeadlineView? ReissueDeadline);

public sealed record ReturnProcessedView(Guid PaymentItemId, Guid ClaimId, string PayeeName, Money Amount, string ReturnCode, string? ReturnReason, Guid OutboxEventId);

public sealed record ReturnSkippedView(Guid PaymentItemId, string Reason);

public sealed record ReturnsProcessedView(DateTimeOffset ReadAt, int Read, IReadOnlyList<ReturnProcessedView> Processed, IReadOnlyList<ReturnSkippedView> Skipped);

public sealed record BankReturnView(Guid PaymentItemId, string ReasonCode, string? ReasonText, DateTimeOffset QueuedAt);

public sealed record FaultStateView(string Name, int? Count, DateTimeOffset Since);

public sealed record FaultAvailableView(string Name, string Description);

public sealed record FaultEventView(DateTimeOffset At, string Name, string Detail);

public sealed record DevFaultsView(IReadOnlyList<FaultStateView> Active, IReadOnlyList<FaultAvailableView> Available, IReadOnlyList<FaultEventView> Log);

public sealed record OverdueItemView(Guid DeadlineId, Guid ClaimId, string Kind, string What, DateTimeOffset DueAt, bool Raised);

public sealed record OverdueCheckView(DateTimeOffset CheckedAt, int Raised, int AlreadyRaised, IReadOnlyList<OverdueItemView> Items);

public sealed record RerunView(string WorkflowId, string Outcome, Guid PreviousRunId);
