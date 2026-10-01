using Claims.Temporal;
using Temporalio.Activities;
using Temporalio.Workflows;

namespace Claims.Tests.Workflow;

/// <summary>
/// Not a port of a Java test: guards the names that go on the wire. They are what the Java version registered (workflow type = the interface's
/// simple name; activity type = interface name prefix + capitalised method name), so both backends can serve the same task queue and read each
/// other's workflow histories. Renaming a class or method must not silently rename a workflow or an activity.
/// </summary>
public class WireNamesTests
{
    [Fact]
    public void WorkflowTypeNamesAreTheJavaOnes()
    {
        Assert.Equal("LifeIntakeWorkflow", WorkflowDefinition.Create(typeof(LifeIntakeWorkflow)).Name);
        Assert.Equal("RequirementFollowUpWorkflow", WorkflowDefinition.Create(typeof(RequirementFollowUpWorkflow)).Name);
        Assert.Equal("DeadlineDispatcherWorkflow", WorkflowDefinition.Create(typeof(DeadlineDispatcherWorkflow)).Name);
        // The event workflows added for the simple scenario (started as event-<id>).
        Assert.Equal("DecisionRecordedWorkflow", WorkflowDefinition.Create(typeof(DecisionRecordedWorkflow)).Name);
        Assert.Equal("PaymentConfirmedWorkflow", WorkflowDefinition.Create(typeof(PaymentConfirmedWorkflow)).Name);
        // The four event workflows of "things bounce back" (each started as event-<outbox event id>).
        Assert.Equal("DocumentReceivedWorkflow", WorkflowDefinition.Create(typeof(DocumentReceivedWorkflow)).Name);
        Assert.Equal("DocumentRejectedWorkflow", WorkflowDefinition.Create(typeof(DocumentRejectedWorkflow)).Name);
        Assert.Equal("PaymentReturnedWorkflow", WorkflowDefinition.Create(typeof(PaymentReturnedWorkflow)).Name);
        Assert.Equal("PaymentMethodUpdatedWorkflow", WorkflowDefinition.Create(typeof(PaymentMethodUpdatedWorkflow)).Name);
    }

    [Fact]
    public void ActivityTypeNamesAreTheJavaOnesWithTheirPrefixes()
    {
        var names = new[]
            {
                ActivityDefinition.CreateAll(new LifeIntakeActivities(null!, null!, null!)),
                ActivityDefinition.CreateAll(new RequirementFollowUpActivities(null!)),
                ActivityDefinition.CreateAll(new DispatcherActivities(null!)),
                ActivityDefinition.CreateAll(new DecisionRecordedActivities(null!)),
                ActivityDefinition.CreateAll(new PaymentConfirmedActivities(null!)),
                ActivityDefinition.CreateAll(new DocumentReceivedActivities(null!)),
                ActivityDefinition.CreateAll(new DocumentRejectedActivities(null!)),
                ActivityDefinition.CreateAll(new PaymentReturnedActivities(null!)),
                ActivityDefinition.CreateAll(new PaymentMethodUpdatedActivities(null!)),
            }
            .SelectMany(d => d).Select(d => d.Name).Order(StringComparer.Ordinal).ToList();

        Assert.Equal(
            [
                "DecisionRecorded_Begin", "DecisionRecorded_Complete", "DecisionRecorded_RecordFailure", "DecisionRecorded_SendApprovalLetters",
                "DecisionRecorded_TellAgent",
                "Dispatcher_DispatchDue",
                "DocumentReceived_Accept", "DocumentReceived_AskForCorrection", "DocumentReceived_Begin", "DocumentReceived_CheckTin", "DocumentReceived_CompleteNotEnough",
                "DocumentReceived_HandToPerson", "DocumentReceived_MarkNotEnough", "DocumentReceived_RecordFailure",
                "DocumentRejected_Begin", "DocumentRejected_Complete", "DocumentRejected_RecordFailure", "DocumentRejected_SendLetter",
                "LifeIntake_Begin", "LifeIntake_CheckPolicies", "LifeIntake_CompleteSetup", "LifeIntake_FindDuplicateClaims", "LifeIntake_HoldForReview",
                "LifeIntake_RecordFailure", "LifeIntake_Route", "LifeIntake_ScreenParties", "LifeIntake_SendAcknowledgementAndPackets", "LifeIntake_TellAgent",
                "PaymentConfirmed_Begin", "PaymentConfirmed_Complete", "PaymentConfirmed_RecordFailure", "PaymentConfirmed_SendClosingLetter",
                "PaymentConfirmed_SendConfirmations", "PaymentConfirmed_TellAgent",
                "PaymentMethodUpdated_Begin", "PaymentMethodUpdated_Complete", "PaymentMethodUpdated_Confirm", "PaymentMethodUpdated_RecordFailure", "PaymentMethodUpdated_Reject",
                "PaymentMethodUpdated_VerifyAccount",
                "PaymentReturned_AskForNewAccount", "PaymentReturned_Begin", "PaymentReturned_Complete", "PaymentReturned_RecordFailure", "PaymentReturned_Reopen",
                "RequirementFollowUp_Begin", "RequirementFollowUp_CompleteFollowUp", "RequirementFollowUp_RecordFailure", "RequirementFollowUp_SendReminder",
                "RequirementFollowUp_Skip",
            ],
            names);
    }
}
