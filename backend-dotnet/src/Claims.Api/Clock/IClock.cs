namespace Claims.Clock;

/// <summary>
/// The business clock. Every decision that depends on "what time is it for the claim" reads it: the dispatcher's due checks, deadline
/// arithmetic, interest, the payment run's cutoff, the timestamps on letters, history and work items. In production it is real time.
/// Development can move it forward (<see cref="VirtualClock"/>, see the /dev/clock endpoints) so a demo can play weeks of a claim in
/// minutes. Delays and timers (poll intervals, retry sleeps) stay on real time: those are about the process, not the claim.
/// </summary>
public interface IClock
{
    /// <summary>Business time: real time plus the offset.</summary>
    DateTimeOffset UtcNow { get; }

    /// <summary>The machine's real time.</summary>
    DateTimeOffset RealNow { get; }

    /// <summary>How far business time is ahead of real time. Zero unless a Development control moved it.</summary>
    TimeSpan Offset { get; }

    bool IsVirtual => Offset != TimeSpan.Zero;

    /// <summary>Moves business time forward by <paramref name="by"/> (which must be positive) and returns the new time.</summary>
    DateTimeOffset Advance(TimeSpan by);

    /// <summary>Moves business time forward to <paramref name="to"/>, which must be after the current business time.</summary>
    DateTimeOffset AdvanceTo(DateTimeOffset to);

    /// <summary>Back to real time. The only way time moves backwards.</summary>
    void Reset();
}
