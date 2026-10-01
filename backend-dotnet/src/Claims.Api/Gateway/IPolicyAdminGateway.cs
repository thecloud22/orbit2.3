namespace Claims.Gateway;

public sealed record PolicyStatus(string PolicyNumber, bool InForceOnDateOfDeath, DateOnly PaidTo, string Note);

/// <summary>Policy administration is the system of record for the policy. The intake workflow re-checks it.</summary>
public interface IPolicyAdminGateway
{
    Task<PolicyStatus> StatusOnAsync(string policyNumber, DateOnly dateOfDeath);
}
