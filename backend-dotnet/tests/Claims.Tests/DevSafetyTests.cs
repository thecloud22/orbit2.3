using Claims.Clock;
using Microsoft.AspNetCore.Hosting;
using Microsoft.AspNetCore.Mvc.Testing;
using Microsoft.Extensions.Configuration;

namespace Claims.Tests;

/// <summary>The Development controls cannot be switched on by accident in Production. No database needed: the host refuses to start before it migrates.</summary>
public class DevSafetyTests
{
    private static WebApplicationFactory<Program> Host(string environment, IReadOnlyDictionary<string, string?> settings) =>
        new WebApplicationFactory<Program>().WithWebHostBuilder(b =>
        {
            b.UseEnvironment(environment);
            b.ConfigureAppConfiguration((_, c) => c.AddInMemoryCollection(settings));
        });

    [Fact]
    public void TheVirtualClockCannotBeEnabledInProduction()
    {
        using var host = Host("Production", new Dictionary<string, string?> { ["Claims:Dev:Controls"] = "true", ["Claims:Db:Migrate"] = "false", ["Claims:Temporal:Enabled"] = "false" });

        var e = Assert.Throws<InvalidOperationException>(() => host.Server);

        Assert.Contains("never be enabled in Production", e.Message, StringComparison.Ordinal);
    }

    [Fact]
    public void ByDefaultTheClockIsRealTimeAndRefusesToMoveBackwards()
    {
        var clock = new VirtualClock();
        Assert.False(clock.IsVirtual);
        Assert.InRange((clock.UtcNow - TimeProvider.System.GetUtcNow()).Duration(), TimeSpan.Zero, TimeSpan.FromSeconds(1));

        clock.Advance(TimeSpan.FromDays(3));
        Assert.True(clock.IsVirtual);
        // UtcNow and RealNow are two reads of the machine clock, a few microseconds apart, so the difference can be a hair under 3 days: the tolerance is on both sides.
        Assert.InRange(clock.UtcNow - clock.RealNow, TimeSpan.FromDays(3).Subtract(TimeSpan.FromSeconds(1)), TimeSpan.FromDays(3).Add(TimeSpan.FromSeconds(1)));
        Assert.InRange((clock.UtcNow - clock.GetUtcNow()).Duration(), TimeSpan.Zero, TimeSpan.FromSeconds(1));   // the same object is the app's TimeProvider
        Assert.Throws<ArgumentOutOfRangeException>(() => clock.Advance(TimeSpan.FromDays(-1)));
        Assert.Throws<ArgumentOutOfRangeException>(() => clock.AdvanceTo(clock.RealNow));
        clock.Reset();
        Assert.False(clock.IsVirtual);
    }
}
