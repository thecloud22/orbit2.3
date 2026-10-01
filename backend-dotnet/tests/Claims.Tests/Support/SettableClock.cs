using Claims.Clock;

namespace Claims.Tests.Support;

/// <summary>
/// A business clock the test sets to an exact instant, so the mock's story ("Thu 8 Oct 11:30") is the same on every day the suite runs,
/// whatever the real date. Registered in place of the app's clock, as both <see cref="IClock"/> and <see cref="TimeProvider"/>.
/// </summary>
public sealed class SettableClock(DateTimeOffset start) : TimeProvider, IClock
{
    private long ticks = start.UtcTicks;

    public override DateTimeOffset GetUtcNow() => new(Interlocked.Read(ref ticks), TimeSpan.Zero);

    public DateTimeOffset UtcNow => GetUtcNow();

    public DateTimeOffset RealNow => System.GetUtcNow();

    public TimeSpan Offset => UtcNow - RealNow;

    public bool IsVirtual => true;

    public void Set(DateTimeOffset to) => Interlocked.Exchange(ref ticks, to.UtcTicks);

    public DateTimeOffset Advance(TimeSpan by)
    {
        Interlocked.Add(ref ticks, by.Ticks);
        return UtcNow;
    }

    public DateTimeOffset AdvanceTo(DateTimeOffset to)
    {
        Set(to);
        return to;
    }

    public void Reset() => Set(RealNow);
}
