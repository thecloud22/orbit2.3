using Claims.Decision;
using Claims.Payment;

namespace Claims.Tests;

/// <summary>
/// The money rules, ported from the mock (web/src/api/lifeFlow.ts). The expected figures are the ones the docs page
/// (docs/life-claim/README.md) prints for the mock's own runs, and each was also computed with the mock's own <c>interestFor</c> in Node:
/// Math.round(total * 0.035 * days / 365 * 100) / 100.
/// </summary>
public class PaymentRulesTests
{
    [Theory]
    [InlineData(200_000, 20, "383.56")]     // the clean run: 19 Sep to 9 Oct
    [InlineData(400_000, 20, "767.12")]     // the accident variation: $400,767.12 paid
    [InlineData(200_000, 83, "1591.78")]    // evidence-never-arrives, waived: $201,591.78
    [InlineData(100_000, 20, "191.78")]     // one half of the clean run; competing claimant: Diane's $100,191.78
    [InlineData(100_000, 45, "431.51")]     // Mark's half resolved and paid 3 Nov: $100,431.51
    [InlineData(100_000, 24, "230.14")]     // a replacement payment keeps the first payment's interest: $100,230.14
    [InlineData(200_000, 0, "0.00")]
    [InlineData(200_000, -3, "0.00")]       // never negative days
    public void InterestIsTheMocksInterestFor(int total, int days, string expected) =>
        Assert.Equal(decimal.Parse(expected, System.Globalization.CultureInfo.InvariantCulture), PaymentRules.InterestFor(total, days));

    [Fact]
    public void InterestRoundsHalfAwayFromZero()
    {
        // 1 * 0.035 * 365 / 365 = 0.035 exactly: half a cent rounds up to 0.04 (banker's rounding would give 0.03).
        Assert.Equal(0.04m, PaymentRules.InterestFor(1m, 365));
        Assert.Equal(0.35m, PaymentRules.InterestFor(10m, 365));
    }

    [Fact]
    public void SplitGivesEachPayeeTheirShareAndTheLastTheRounding()
    {
        Assert.Equal([100_000m, 100_000m], PaymentRules.Split(200_000m, [50m, 50m]));
        Assert.Equal([191.78m, 191.78m], PaymentRules.Split(383.56m, [50m, 50m]));
        // 383.57 in half: floor(19178.5) = 19178 cents to the first, the last takes the odd cent.
        Assert.Equal([191.78m, 191.79m], PaymentRules.Split(383.57m, [50m, 50m]));
        // Thirds: the last payee absorbs the rounding and the parts always add back up.
        var thirds = PaymentRules.Split(100m, [33.33m, 33.33m, 33.34m]);
        Assert.Equal(100m, thirds.Sum());
        Assert.Equal([33.33m, 33.33m, 33.34m], thirds);
    }

    [Fact]
    public void MoneyIsWrittenLikeTheMock()
    {
        Assert.Equal("$200,383.56", PaymentRules.Usd(200_383.56m));
        Assert.Equal("$250,000", PaymentRules.UsdShort(250_000m));
        Assert.Equal("$0.99", PaymentRules.UsdShort(0.99m));
    }

    [Fact]
    public void ThePlanForTheCastellanoStoryIsTwoItemsOfOneHundredThousandAndInterest()
    {
        var diane = new Payee(Guid.NewGuid(), "Diane Castellano", 50m, "eft");
        var mark = new Payee(Guid.NewGuid(), "Mark Castellano", 50m, "eft");
        var line = new PayableLine(Guid.NewGuid(), "Whole life", false, 200_000m);

        var items = DecisionPlan.Items([line], [diane, mark], 20);

        Assert.Equal(2, items.Count);
        Assert.All(items, i => Assert.Equal((100_000m, 191.78m, 100_191.78m), (i.Principal, i.Interest, i.Amount)));
        Assert.Equal(200_383.56m, DecisionPlan.Total(items));
        Assert.Equal("50% of $200,000.00 + $191.78 interest", items[0].Basis);
    }

    [Fact]
    public void ARiderThatPaysIsItsOwnLineAndItemsAreNamedAfterIt()
    {
        var payees = new[] { new Payee(Guid.NewGuid(), "Diane Castellano", 50m, "eft"), new Payee(Guid.NewGuid(), "Mark Castellano", 50m, "check") };
        var items = DecisionPlan.Items([new PayableLine(Guid.NewGuid(), "Whole life", false, 200_000m), new PayableLine(Guid.NewGuid(), "Accidental death rider", true, 200_000m)], payees, 20);

        Assert.Equal(4, items.Count);
        Assert.Equal(400_767.12m, DecisionPlan.Total(items));
        Assert.Equal(["eft", "check", "eft", "check"], items.Select(i => i.Method));
        Assert.Contains("(Accidental death rider)", items[2].Basis, StringComparison.Ordinal);
    }

    [Theory]
    [InlineData("2026-10-08", "2026-10-09")]   // Thursday: paid Friday
    [InlineData("2026-10-09", "2026-10-12")]   // Friday: paid Monday
    [InlineData("2026-10-10", "2026-10-12")]   // Saturday
    public void TheRunPaysOnTheNextBusinessDay(string decided, string pays) =>
        Assert.Equal(DateOnly.Parse(pays, System.Globalization.CultureInfo.InvariantCulture),
            DecisionService.PayDateAfter(DateOnly.Parse(decided, System.Globalization.CultureInfo.InvariantCulture)));
}
