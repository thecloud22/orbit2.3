using Claims.Config;
using Temporalio.Testing;

namespace Claims.Temporal;

/// <summary>
/// LOCAL RUNS ONLY (Claims:Temporal:DevServer=true): a real Temporal dev server started inside this process, so a laptop demo needs no Docker and no
/// Homebrew. It is <c>WorkflowEnvironment.StartLocalAsync</c>, the SDK's own way of running the Temporal CLI's dev server: the first start downloads
/// the CLI (cached in the temp directory afterwards; or point Claims:Temporal:DevServerPath / TEMPORAL_DEV_SERVER_PATH at one you already have),
/// then it runs in memory (Claims:Temporal:DevServerDbFile keeps it across restarts). The client, the worker and the dispatcher Schedule are pointed at it
/// through <c>Claims:Temporal:Target</c>. It has the web UI on Claims:Temporal:DevServerUiPort (8233). Real environments use the organisation's Temporal.
/// </summary>
public sealed class TemporalDevServer(WorkflowEnvironment environment, string target, int? uiPort) : IAsyncDisposable
{
    public string Target { get; } = target;

    public int? UiPort { get; } = uiPort;

    public static async Task<TemporalDevServer> StartAsync(ClaimsOptions.TemporalOptions t)
    {
        var host = "127.0.0.1:" + t.DevServerPort;
        var env = await WorkflowEnvironment.StartLocalAsync(new WorkflowEnvironmentStartLocalOptions
        {
            TargetHost = host,
            Namespace = t.Namespace,
            DataConverter = TemporalSetup.DataConverterFor(),
            UI = t.DevServerUiPort > 0,
            UIPort = t.DevServerUiPort > 0 ? t.DevServerUiPort : 0,
            DevServerOptions = new DevServerOptions
            {
                ExistingPath = string.IsNullOrWhiteSpace(t.DevServerPath) ? null : t.DevServerPath,
                DatabaseFilename = string.IsNullOrWhiteSpace(t.DevServerDbFile) ? null : t.DevServerDbFile,
            },
        });
        return new TemporalDevServer(env, env.Client.Connection.Options.TargetHost ?? host, t.DevServerUiPort > 0 ? t.DevServerUiPort : null);
    }

    public async ValueTask DisposeAsync() => await environment.ShutdownAsync();
}

/// <summary>Stops the embedded dev server when the host stops (registered first, so it stops last: after the worker has drained).</summary>
public sealed class TemporalDevServerLifetime(TemporalDevServer server) : IHostedService
{
    public Task StartAsync(CancellationToken cancellationToken) => Task.CompletedTask;

    public async Task StopAsync(CancellationToken cancellationToken) => await server.DisposeAsync();
}
