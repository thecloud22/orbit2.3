using Claims.Clock;
using Claims.Common;
using Claims.Temporal;
using Microsoft.AspNetCore.Hosting;
using Microsoft.AspNetCore.Mvc.Testing;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.DependencyInjection;

namespace Claims.Tests.Support;

/// <summary>
/// The whole API hosted in-process (WebApplicationFactory) on its own freshly created database, migrated by the app at startup exactly
/// as in production. Like Spring's "test" profile: no Temporal (a <see cref="RecordingLauncher"/> stands in for it), nothing polling
/// in the background, so every step is driven by hand and deterministic. One instance per test class (xUnit class fixture).
/// If there is no Postgres the fixture does nothing and the tests are skipped by <see cref="PostgresFactAttribute"/>.
/// </summary>
public abstract class PostgresApiFixture : IAsyncLifetime
{
    private WebApplicationFactory<Program>? factory;

    protected abstract string Hint { get; }

    /// <summary>Extra Claims:* settings for this class.</summary>
    protected virtual IReadOnlyDictionary<string, string?> Settings => new Dictionary<string, string?>();

    /// <summary>Extra services, applied after the app's own (last registration wins).</summary>
    protected virtual void ConfigureServices(IServiceCollection services) { }

    /// <summary>Runs before the host is built (the flow test starts its Temporal test server here).</summary>
    protected virtual Task BeforeStartAsync() => Task.CompletedTask;

    /// <summary>Runs after the host is up, before the first test (the flow test starts its worker here).</summary>
    protected virtual Task StartedAsync() => Task.CompletedTask;

    /// <summary>Set to freeze business time at an instant the tests move by hand (a <see cref="SettableClock"/>); null keeps the app's own clock.</summary>
    protected virtual DateTimeOffset? ClockStart => null;

    public RecordingLauncher Launcher { get; } = new();

    /// <summary>The clock the tests move, when <see cref="ClockStart"/> is set.</summary>
    public SettableClock Clock { get; private set; } = null!;

    public IServiceProvider Services => (factory ?? throw new InvalidOperationException("no database")).Services;

    public Db Db => Services.GetRequiredService<Db>();

    public HttpClient CreateClient() => (factory ?? throw new InvalidOperationException("no database")).CreateClient();

    public T Get<T>() where T : notnull => Services.GetRequiredService<T>();

    public async ValueTask InitializeAsync()
    {
        if (!PostgresSupport.Available) return;
        var connectionString = await PostgresSupport.NewDatabaseAsync(Hint);
        await BeforeStartAsync();
        var settings = new Dictionary<string, string?>
        {
            ["Claims:Db:Url"] = connectionString,
            ["Claims:Temporal:Enabled"] = "false",
            ["Claims:Outbox:PollEnabled"] = "false",
            ["Claims:Dispatcher:ScheduleEnabled"] = "false",
            ["Claims:Dispatcher:LocalPollEnabled"] = "false",
        };
        foreach (var (key, value) in Settings) settings[key] = value;
        factory = new WebApplicationFactory<Program>().WithWebHostBuilder(builder =>
        {
            builder.UseEnvironment("Test");
            builder.ConfigureAppConfiguration((_, config) => config.AddInMemoryCollection(settings));
            builder.ConfigureServices(services =>
            {
                services.AddSingleton<IWorkflowLauncher>(Launcher);
                if (ClockStart is { } start)
                {
                    Clock = new SettableClock(start);
                    services.AddSingleton<IClock>(Clock);
                    services.AddSingleton<TimeProvider>(Clock);
                }
                ConfigureServices(services);
            });
        });
        _ = factory.Server;   // starts the host: migrations run here
        await StartedAsync();
    }

    public virtual async ValueTask DisposeAsync()
    {
        if (factory is not null) await factory.DisposeAsync();
    }
}
