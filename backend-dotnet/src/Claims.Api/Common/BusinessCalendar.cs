namespace Claims.Common;

/// <summary>
/// Turns "N days after X" into the instant a deadline row falls due. Business days skip weekends only;
/// holidays come with the state rules table. Example values, as in the mock.
/// </summary>
public sealed class BusinessCalendar(TimeZoneInfo zone, TimeOnly fireTime)
{
    public TimeZoneInfo Zone { get; } = zone;

    public DateOnly LocalDate(DateTimeOffset at) => DateOnly.FromDateTime(TimeZoneInfo.ConvertTime(at, Zone).DateTime);

    /// <summary>The instant a deadline dated <paramref name="date"/> falls due: fireTime on that local date.</summary>
    public DateTimeOffset DueAt(DateOnly date) => ToInstant(date.ToDateTime(fireTime));

    public DateTimeOffset DaysAfter(DateTimeOffset from, int days) => DueAt(LocalDate(from).AddDays(days));

    public DateTimeOffset BusinessDaysAfter(DateTimeOffset from, int days) => DueAt(AddBusinessDays(LocalDate(from), days));

    public static DateOnly AddBusinessDays(DateOnly from, int days)
    {
        var d = from;
        var left = days;
        while (left > 0)
        {
            d = d.AddDays(1);
            if (d.DayOfWeek is not (DayOfWeek.Saturday or DayOfWeek.Sunday)) left--;
        }
        return d;
    }

    /// <summary>Local wall-clock time to an instant, resolving DST the way java.time does: a time in the spring-forward gap moves
    /// forward by the gap, a time that happens twice takes the earlier offset.</summary>
    private DateTimeOffset ToInstant(DateTime local)
    {
        local = DateTime.SpecifyKind(local, DateTimeKind.Unspecified);
        if (Zone.IsInvalidTime(local)) local = local.AddHours(1);
        var offset = Zone.IsAmbiguousTime(local) ? Zone.GetAmbiguousTimeOffsets(local).Max() : Zone.GetUtcOffset(local);
        return new DateTimeOffset(local, offset).ToUniversalTime();
    }
}
