namespace Claims.Domain;

/// <summary>
/// Only <see cref="RequirementFollowUp"/> has a workflow. The rest are rows something else closes (the intake run, the welcome call, the decision, the payment
/// run, a person's review, the payee's new account) or targets the nightly overdue check raises to a person when they are late. <see cref="DocumentReviewBy"/>
/// and <see cref="BankDetailsBy"/> are display/target rows on purpose: a person's review and a payee's answer are not something a workflow can do for them.
/// </summary>
public enum DeadlineKind
{
    AcknowledgeBy, FormsBy, FirstContactBy, StatusLetter, RequirementFollowUp, DecisionDue, ReviewTarget, PaymentDue,
    DocumentReviewBy, BankDetailsBy,
}
