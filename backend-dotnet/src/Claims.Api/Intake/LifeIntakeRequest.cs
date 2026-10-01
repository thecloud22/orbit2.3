using System.Text.Json.Serialization;
using Claims.View;

namespace Claims.Intake;

/// <summary>
/// POST /claims/life-intake: a phone notice of death, after the intake person has found the insured, the policies being claimed
/// and the beneficiary designation in policy administration (the mock's getLifeIntakeContext + LifeDraft, flattened into one
/// request). Everything here is what the intake person knows at submit; anything that needs an outside system is checked later
/// by the intake workflow.
///
/// The shape is checked by <see cref="LifeIntakeValidator"/> (422 validation_failed with field errors), not by the deserializer, so a
/// missing field is a validation error rather than a parse error. That is why dates and shares the contract requires are nullable
/// here: they are never null once the validator has passed.
/// </summary>
/// <param name="NoticeReceivedAt">When the call started. Defaults to the server clock.</param>
public sealed record LifeIntakeRequest(
    DateTimeOffset? NoticeReceivedAt,
    CallerInfo Caller,
    InsuredInfo Insured,
    DeathInfo Death,
    IReadOnlyList<PolicyClaimed> Policies,
    DesignationInfo Designation,
    AgentInfo? Agent,
    bool OtherClaimantsPossible);

/// <param name="ContactBy">email, text, phone, mail</param>
/// <param name="BeneficiaryRef">Set when the caller is one of the designated beneficiaries: the beneficiary's <c>ref</c>.</param>
public sealed record CallerInfo(string Name, string? Relationship, string? Phone, string? Email, IReadOnlyList<string> ContactBy,
                            bool VerifiedDateOfBirth, bool VerifiedPolicyNumber, bool AgentConsent, string? BeneficiaryRef);

public sealed record InsuredInfo(string Name, DateOnly? DateOfBirth, string? SsnLast4);

public sealed record DeathInfo(DateOnly? DateOfDeath, string? PlaceOfDeath, string Manner, bool OutsideUs, string? FuneralHome)
{
    [JsonIgnore] public DateOnly Date => DateOfDeath!.Value;
}

public sealed record PolicyClaimed(string PolicyNumber, string ProductCode, string ProductName, DateOnly? IssueDate, DateOnly? PaidToDate,
                                   bool InForce, DateOnly? LapsedOn, Money FaceAmount, IReadOnlyList<Rider>? Riders)
{
    [JsonIgnore] public DateOnly Issued => IssueDate!.Value;
}

public sealed record Rider(string Key, string Name, Money Amount);

public sealed record DesignationInfo(DateOnly? Date, string? Source, IReadOnlyList<Beneficiary> Beneficiaries);

/// <param name="Ref">Client-chosen reference, unique in this request; links the caller and contacts.</param>
public sealed record Beneficiary(string Ref, string Name, string? Relationship, string Kind, decimal? SharePercent, DateOnly? DateOfBirth,
                                 DateOnly? DiedOn, string? DiedSource, Contact? Contact)
{
    [JsonIgnore] public decimal Share => SharePercent!.Value;
}

public sealed record Contact(string? Phone, string? Email, string? Address, string? Packet);

public sealed record AgentInfo(string Name, string? Agency);
