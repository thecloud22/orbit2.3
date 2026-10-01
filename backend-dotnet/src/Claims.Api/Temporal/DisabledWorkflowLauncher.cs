using Claims.Domain;

namespace Claims.Temporal;

/// <summary>Used when Claims:Temporal:Enabled is false (API-only runs, DB tests): starting a workflow fails loudly.</summary>
public sealed class DisabledWorkflowLauncher : IWorkflowLauncher
{
    public IReadOnlySet<DeadlineKind> SupportedDeadlineKinds { get; } = new HashSet<DeadlineKind> { DeadlineKind.RequirementFollowUp };

    public Task<Started> StartDeadlineWorkflowAsync(DeadlineKind kind, Guid deadlineId) =>
        throw new InvalidOperationException("Temporal is disabled (Claims:Temporal:Enabled=false)");

    public Task<Started> StartIntakeAsync(string claimNumber, Guid claimId, Guid eventId) =>
        throw new InvalidOperationException("Temporal is disabled (Claims:Temporal:Enabled=false)");

    public Task<Started> StartEventAsync(EventStart start) =>
        throw new InvalidOperationException("Temporal is disabled (Claims:Temporal:Enabled=false)");
}
