namespace Claims.Clock;

/// <summary>
/// Real time plus an offset held in memory. It is also the app's <see cref="TimeProvider"/>: timers and delays are the system's, only
/// <c>GetUtcNow()</c> is shifted, so a poller sleeping 15 s still sleeps 15 real seconds and then reads business time. The offset is only
/// ever changed by the Development endpoints (Claims:Dev:Controls); a process that never calls them runs on real time.
/// </summary>
public sealed class VirtualClock : TimeProvider, IClock
{
    private long offsetTicks;

    public override DateTimeOffset GetUtcNow() => RealNow + Offset;

    public DateTimeOffset UtcNow => GetUtcNow();

    public DateTimeOffset RealNow => System.GetUtcNow();

    public TimeSpan Offset => new(Interlocked.Read(ref offsetTicks));

    public bool IsVirtual => Offset != TimeSpan.Zero;

    public DateTimeOffset Advance(TimeSpan by)
    {
        if (by <= TimeSpan.Zero) throw new ArgumentOutOfRangeException(nameof(by), "Business time only moves forward");
        Interlocked.Add(ref offsetTicks, by.Ticks);
        return UtcNow;
    }

    public DateTimeOffset AdvanceTo(DateTimeOffset to)
    {
        var by = to - UtcNow;
        if (by <= TimeSpan.Zero) throw new ArgumentOutOfRangeException(nameof(to), "Business time only moves forward");
        return Advance(by);
    }

    public void Reset() => Interlocked.Exchange(ref offsetTicks, 0);
}
