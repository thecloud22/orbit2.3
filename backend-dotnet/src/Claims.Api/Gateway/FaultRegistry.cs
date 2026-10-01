using System.Text.RegularExpressions;
using Claims.Clock;
using Claims.Config;

namespace Claims.Gateway;

/// <summary>One fault switch that is on. <c>Count</c> is the uses left; null means on until it is cleared.</summary>
public sealed record FaultState(string Name, int? Count, DateTimeOffset Since);

/// <summary>What a fault did, for the "what Temporal did" story the UI shows.</summary>
public sealed record FaultEvent(DateTimeOffset At, string Name, string Detail);

/// <summary>The faults the platform knows, with a line each. A worker stall names the activity it hits (<c>worker.stall-once:LifeIntake_SendAcknowledgementAndPackets</c>).</summary>
public static class FaultCatalog
{
    public const string LettersDown = "letters.down";
    public const string BankDown = "bank.down";
    public const string BankRejectNext = "bank.reject-next";
    public const string TinNoMatch = "tin.no-match";
    public const string TinDown = "tin.down";
    public const string StallOncePrefix = "worker.stall-once:";

    public static string StallOnce(string activityType) => StallOncePrefix + activityType;

    public static IReadOnlyList<(string Name, string Description)> All { get; } =
    [
        (LettersDown, "The letters gateway throws on every send attempt (each attempt is a use when a count is given), so the workflow's retries run out."),
        (BankDown, "The bank's file endpoint is unreachable: the payment run fails and releases its items."),
        (BankRejectNext, "The bank returns the next payment it is sent (R02), then the fault switches itself off."),
        (TinNoMatch, "The IRS check answers \"no match\" (an answer, not an error). Each check is a use when a count is given."),
        (TinDown, "The IRS check fails like a 503: Temporal retries the activity. Each check is a use when a count is given."),
        (StallOncePrefix + "<activity type>", "The first execution of that activity does its work and then hangs past its 30 s StartToClose timeout, as a worker killed before it reported back would; Temporal times it out and runs it again."),
    ];

    private static readonly Regex Stall = new("^worker\\.stall-once:[A-Za-z][A-Za-z0-9]*_[A-Za-z][A-Za-z0-9]*$", RegexOptions.CultureInvariant | RegexOptions.NonBacktracking);

    /// <summary>Only names a stub or the worker reads can be switched: a typo should be an error, not a fault that never fires.</summary>
    public static bool IsKnown(string name) =>
        name is LettersDown or BankDown or BankRejectNext or TinNoMatch or TinDown || Stall.IsMatch(name);
}

/// <summary>
/// Named fault switches for the stub gateways and the worker, so a demo or a test can make an outside system misbehave on purpose. Off by default:
/// nothing is on unless <c>Claims:Dev:Faults</c> lists it or a test/endpoint sets it (<c>POST /dev/faults</c>). Names: see <see cref="FaultCatalog"/>.
///
/// A fault is either on until cleared (<c>Set(name, true)</c>) or counted (<c>Set(name, n)</c>: the next n uses). Every read-and-change is one atomic step
/// under a lock, so two threads never both use the last unit of a counted fault, and every use is logged (<see cref="Log"/>) so the UI can say what happened.
/// </summary>
public interface IFaultRegistry
{
    bool IsOn(string fault);

    /// <summary>True once, then the fault is off ("the next one fails"): a counted fault loses one use, an uncounted one is switched off.</summary>
    bool TryConsume(string fault);

    /// <summary>
    /// For a fault that stays on while a service is "down": true while it is on, and a counted fault loses one use (each call is one attempt that fails).
    /// An uncounted fault stays on.
    /// </summary>
    bool Trigger(string fault);

    void Set(string fault, bool on);

    /// <summary>On for the next <paramref name="count"/> uses (at least 1).</summary>
    void Set(string fault, int count);

    IReadOnlyCollection<string> Active { get; }

    IReadOnlyList<FaultState> State { get; }

    IReadOnlyList<FaultEvent> Log { get; }

    /// <summary>Adds a line to the log (a fault that fired somewhere the registry cannot see, such as the worker's stall).</summary>
    void Record(string fault, string detail);
}

public sealed class FaultRegistry : IFaultRegistry
{
    private const int LogLimit = 200;
    private readonly object gate = new();
    private readonly Dictionary<string, (int? Count, DateTimeOffset Since)> on = new(StringComparer.OrdinalIgnoreCase);
    private readonly List<FaultEvent> log = [];
    private readonly IClock? clock;

    public FaultRegistry(ClaimsOptions options, IClock? clock = null)
    {
        this.clock = clock;
        foreach (var f in options.Dev.Faults) on[f] = (null, Now);
    }

    private DateTimeOffset Now => clock?.UtcNow ?? TimeProvider.System.GetUtcNow();

    public bool IsOn(string fault)
    {
        lock (gate) return on.ContainsKey(fault);
    }

    public bool TryConsume(string fault)
    {
        lock (gate)
        {
            if (!on.TryGetValue(fault, out var s)) return false;
            Use(fault, s, "used once");
            return true;
        }
    }

    public bool Trigger(string fault)
    {
        lock (gate)
        {
            if (!on.TryGetValue(fault, out var s)) return false;
            if (s.Count is null) return true;   // on until cleared: not logged per use (a fault that stays on would flood the log)
            Use(fault, s, "used");
            return true;
        }
    }

    private void Use(string fault, (int? Count, DateTimeOffset Since) s, string what)
    {
        if (s.Count is { } n && n > 1) on[fault] = (n - 1, s.Since);
        else on.Remove(fault);
        AddLog(fault, s.Count is { } left ? $"{what}; {Math.Max(0, left - 1)} left" : what + "; switched off");
    }

    public void Set(string fault, bool value)
    {
        lock (gate)
        {
            if (value) on[fault] = (null, Now);
            else on.Remove(fault);
            AddLog(fault, value ? "switched on until cleared" : "switched off");
        }
    }

    public void Set(string fault, int count)
    {
        if (count < 1) throw new ArgumentOutOfRangeException(nameof(count), "A counted fault needs at least one use");
        lock (gate)
        {
            on[fault] = (count, Now);
            AddLog(fault, $"switched on for the next {count} use{(count == 1 ? "" : "s")}");
        }
    }

    public IReadOnlyCollection<string> Active
    {
        get { lock (gate) return [.. on.Keys.Order(StringComparer.OrdinalIgnoreCase)]; }
    }

    public IReadOnlyList<FaultState> State
    {
        get { lock (gate) return [.. on.OrderBy(kv => kv.Key, StringComparer.OrdinalIgnoreCase).Select(kv => new FaultState(kv.Key, kv.Value.Count, kv.Value.Since))]; }
    }

    public IReadOnlyList<FaultEvent> Log
    {
        get { lock (gate) return [.. log]; }
    }

    public void Record(string fault, string detail)
    {
        lock (gate) AddLog(fault, detail);
    }

    private void AddLog(string fault, string detail)
    {
        log.Add(new FaultEvent(Now, fault, detail));
        if (log.Count > LogLimit) log.RemoveRange(0, log.Count - LogLimit);
    }
}
