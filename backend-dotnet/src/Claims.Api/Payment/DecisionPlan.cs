using System.Globalization;

namespace Claims.Payment;

/// <summary>A benefit line that pays under this decision.</summary>
public sealed record PayableLine(Guid LineId, string Name, bool IsRider, decimal Amount);

/// <summary>A living beneficiary who is a payee, with a share.</summary>
public sealed record Payee(Guid PartyId, string Name, decimal SharePercent, string Method);

/// <summary>One payment item to write: what one payee is paid on one line.</summary>
public sealed record PlannedItem(Guid LineId, Guid PayeeId, string PayeeName, decimal Principal, decimal Interest, string Method, string Basis)
{
    public decimal Amount => Principal + Interest;
}

/// <summary>Turns the payable lines and payees into payment items: principal split by share, interest on each line split the same way.</summary>
public static class DecisionPlan
{
    public static IReadOnlyList<PlannedItem> Items(IReadOnlyList<PayableLine> lines, IReadOnlyList<Payee> payees, int days)
    {
        var shares = payees.Select(p => p.SharePercent).ToList();
        var items = new List<PlannedItem>();
        foreach (var line in lines)
        {
            var interest = PaymentRules.InterestFor(line.Amount, days);
            var principals = PaymentRules.Split(line.Amount, shares);
            var interests = PaymentRules.Split(interest, shares);
            for (var i = 0; i < payees.Count; i++)
            {
                var p = payees[i];
                var of = line.IsRider ? $"{PaymentRules.Usd(line.Amount)} ({line.Name})" : PaymentRules.Usd(line.Amount);
                items.Add(new PlannedItem(line.LineId, p.PartyId, p.Name, principals[i], interests[i], p.Method,
                    string.Create(CultureInfo.InvariantCulture, $"{p.SharePercent:0.##}% of {of} + {PaymentRules.Usd(interests[i])} interest")));
            }
        }
        return items;
    }

    public static decimal Total(IEnumerable<PlannedItem> items) => items.Sum(i => i.Amount);
}
