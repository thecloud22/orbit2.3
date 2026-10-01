using System.Text.RegularExpressions;
using Claims.Common;
using Claims.View;

namespace Claims.Intake;

/// <summary>
/// Shape validation for <see cref="LifeIntakeRequest"/>: what Bean Validation (@NotNull, @NotBlank, @NotEmpty, @Pattern, @Size,
/// @Valid) did in the Java version. Field names are the JSON paths (<c>policies[0].faceAmount.amount</c>). Business rules that
/// need more than the shape (shares add up to 100, identity verified, ...) live in <see cref="LifeIntakeService"/> with their own codes.
/// </summary>
public static partial class LifeIntakeValidator
{
    [GeneratedRegex("^(email|text|phone|mail)$")] private static partial Regex ContactByRule();
    [GeneratedRegex("^[0-9]{4}$")] private static partial Regex Ssn4Rule();
    [GeneratedRegex("^(natural|accident|pending)$")] private static partial Regex MannerRule();
    [GeneratedRegex("^(primary|contingent)$")] private static partial Regex KindRule();
    [GeneratedRegex("^(portal|mail)$")] private static partial Regex PacketRule();
    [GeneratedRegex(@"^[0-9]{1,13}(\.[0-9]{1,2})?$")] private static partial Regex AmountRule();
    [GeneratedRegex("^[A-Z]{3}$")] private static partial Regex CurrencyRule();

    public static IReadOnlyList<FieldError> Validate(LifeIntakeRequest? r)
    {
        var e = new List<FieldError>();
        if (r is null)
        {
            e.Add(new FieldError("", "must not be null"));
            return e;
        }

        if (r.Caller is null) e.Add(Null("caller"));
        else
        {
            var c = r.Caller;
            Blank(e, "caller.name", c.Name);
            if (c.Name is { Length: > 200 }) e.Add(new FieldError("caller.name", "size must be between 0 and 200"));
            if (c.Relationship is { Length: > 100 }) e.Add(new FieldError("caller.relationship", "size must be between 0 and 100"));
            if (c.ContactBy is null) e.Add(Null("caller.contactBy"));
            else
                foreach (var v in c.ContactBy.Where(v => v is not null && !ContactByRule().IsMatch(v)))
                    e.Add(Pattern("caller.contactBy[]", "email|text|phone|mail"));
        }

        if (r.Insured is null) e.Add(Null("insured"));
        else
        {
            Blank(e, "insured.name", r.Insured.Name);
            if (r.Insured.DateOfBirth is null) e.Add(Null("insured.dateOfBirth"));
            if (r.Insured.SsnLast4 is not null && !Ssn4Rule().IsMatch(r.Insured.SsnLast4)) e.Add(Pattern("insured.ssnLast4", "[0-9]{4}"));
        }

        if (r.Death is null) e.Add(Null("death"));
        else
        {
            if (r.Death.DateOfDeath is null) e.Add(Null("death.dateOfDeath"));
            if (r.Death.Manner is null) e.Add(Null("death.manner"));
            else if (!MannerRule().IsMatch(r.Death.Manner)) e.Add(Pattern("death.manner", "natural|accident|pending"));
        }

        if (r.Policies is null || r.Policies.Count == 0) e.Add(new FieldError("policies", "must not be empty"));
        else
            for (var i = 0; i < r.Policies.Count; i++)
            {
                var p = r.Policies[i];
                var at = $"policies[{i}]";
                if (p is null) { e.Add(Null(at)); continue; }
                Blank(e, at + ".policyNumber", p.PolicyNumber);
                Blank(e, at + ".productCode", p.ProductCode);
                Blank(e, at + ".productName", p.ProductName);
                if (p.IssueDate is null) e.Add(Null(at + ".issueDate"));
                if (p.PaidToDate is null) e.Add(Null(at + ".paidToDate"));
                CheckMoney(e, at + ".faceAmount", p.FaceAmount);
                if (p.Riders is not null)
                    for (var j = 0; j < p.Riders.Count; j++)
                    {
                        var rd = p.Riders[j];
                        var rat = $"{at}.riders[{j}]";
                        if (rd is null) { e.Add(Null(rat)); continue; }
                        Blank(e, rat + ".key", rd.Key);
                        Blank(e, rat + ".name", rd.Name);
                        CheckMoney(e, rat + ".amount", rd.Amount);
                    }
            }

        if (r.Designation is null) e.Add(Null("designation"));
        else
        {
            if (r.Designation.Date is null) e.Add(Null("designation.date"));
            if (r.Designation.Beneficiaries is null || r.Designation.Beneficiaries.Count == 0)
                e.Add(new FieldError("designation.beneficiaries", "must not be empty"));
            else
                for (var i = 0; i < r.Designation.Beneficiaries.Count; i++)
                {
                    var b = r.Designation.Beneficiaries[i];
                    var at = $"designation.beneficiaries[{i}]";
                    if (b is null) { e.Add(Null(at)); continue; }
                    Blank(e, at + ".ref", b.Ref);
                    Blank(e, at + ".name", b.Name);
                    if (b.Kind is null) e.Add(Null(at + ".kind"));
                    else if (!KindRule().IsMatch(b.Kind)) e.Add(Pattern(at + ".kind", "primary|contingent"));
                    if (b.SharePercent is null) e.Add(Null(at + ".sharePercent"));
                    if (b.Contact?.Packet is { } packet && !PacketRule().IsMatch(packet)) e.Add(Pattern(at + ".contact.packet", "portal|mail"));
                }
        }

        if (r.Agent is not null) Blank(e, "agent.name", r.Agent.Name);
        return e;
    }

    private static void CheckMoney(List<FieldError> e, string at, Money? m)
    {
        if (m is null) { e.Add(Null(at)); return; }
        if (m.Amount is null) e.Add(Null(at + ".amount"));
        else if (!AmountRule().IsMatch(m.Amount)) e.Add(new FieldError(at + ".amount", "must be a decimal string with at most 2 decimals, e.g. \"200000.00\""));
        if (m.Currency is null) e.Add(Null(at + ".currency"));
        else if (!CurrencyRule().IsMatch(m.Currency)) e.Add(new FieldError(at + ".currency", "must be a 3-letter ISO 4217 code"));
    }

    private static FieldError Null(string field) => new(field, "must not be null");

    private static FieldError Pattern(string field, string regex) => new(field, $"must match \"{regex}\"");

    private static void Blank(List<FieldError> e, string field, string? value)
    {
        if (string.IsNullOrWhiteSpace(value)) e.Add(new FieldError(field, "must not be blank"));
    }
}
