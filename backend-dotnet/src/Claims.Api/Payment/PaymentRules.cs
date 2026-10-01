using System.Globalization;

namespace Claims.Payment;

/// <summary>
/// The money rules of a life claim, ported from the mock (web/src/api/lifeFlow.ts: <c>interestFor</c>, <c>split</c>, the approve step).
/// Pure, so it is unit-tested without a database. Decimal arithmetic, where the mock used floating point: the two agree except where
/// a value sits within a float's error of a half cent.
/// </summary>
public static class PaymentRules
{
    /// <summary>State rule (example value, as in the mock): 3.5% a year, date of death to payment.</summary>
    public const decimal InterestRate = 0.035m;

    /// <summary>The payment run pays on the next business day after the decision (the mock: <c>addBusinessDays(decide, 1)</c>).</summary>
    public const int PayBusinessDaysAfterDecision = 1;

    /// <summary>Service level "Pay after approval": 2 business days, written as the payment_due row.</summary>
    public const int PaymentDueBusinessDays = 2;

    /// <summary>The mock's <c>interestFor(total, days)</c>: round(total × rate × days ÷ 365, 2), half away from zero, never negative days.</summary>
    public static decimal InterestFor(decimal total, int days) =>
        Math.Round(total * InterestRate * Math.Max(0, days) / 365m, 2, MidpointRounding.AwayFromZero);

    /// <summary>The mock's <c>split</c>: each payee gets floor(amount × percent) cents; the last payee takes the rounding.</summary>
    public static IReadOnlyList<decimal> Split(decimal amount, IReadOnlyList<decimal> sharePercents)
    {
        var parts = sharePercents.Select(s => Math.Floor(amount * s) / 100m).ToArray();
        if (parts.Length > 0) parts[^1] = Math.Round(amount - parts[..^1].Sum(), 2, MidpointRounding.AwayFromZero);
        return parts;
    }

    /// <summary>"$200,383.56", as the mock's <c>fmtMoney</c> writes it.</summary>
    public static string Usd(decimal amount) => amount.ToString("C2", CultureInfo.GetCultureInfo("en-US"));

    /// <summary>"$250,000" (no cents when there are none), for authority notes.</summary>
    public static string UsdShort(decimal amount) => Usd(amount).Replace(".00", "", StringComparison.Ordinal);
}
