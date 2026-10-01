using Claims.Temporal;
using Temporalio.Client;
using Temporalio.Testing;
using Temporalio.Worker;

namespace Claims.Tests.Workflow;

/// <summary>
/// A Temporal test environment with time skipping: activity retry back-offs cost no wall-clock time. It uses the same data converter as
/// production, so the payloads on the wire are the real ones. One test server per test class; each test gets its own task queue and worker.
/// </summary>
public sealed class WorkflowEnvironmentFixture : IAsyncLifetime
{
    public WorkflowEnvironment Env { get; private set; } = null!;

    public async ValueTask InitializeAsync() =>
        Env = await WorkflowEnvironment.StartTimeSkippingAsync(new WorkflowEnvironmentStartTimeSkippingOptions
        {
            DataConverter = TemporalSetup.DataConverterFor(),
        });

    public async ValueTask DisposeAsync() => await Env.ShutdownAsync();
}

public abstract class WorkflowTestBase(WorkflowEnvironmentFixture fixture) : IClassFixture<WorkflowEnvironmentFixture>
{
    protected WorkflowEnvironment Env => fixture.Env;

    protected ITemporalClient Client => fixture.Env.Client;

    /// <summary>Runs <paramref name="body"/> (which starts workflows on the given task queue) while a worker with the registered types is up.</summary>
    protected async Task<T> WithWorkerAsync<T>(Action<TemporalWorkerOptions> register, Func<string, Task<T>> body)
    {
        var queue = "claims-test-" + Guid.NewGuid();
        var options = new TemporalWorkerOptions(queue);
        register(options);
        using var worker = new TemporalWorker(Client, options);
        return await worker.ExecuteAsync(() => body(queue));
    }

    protected static WorkflowOptions Options(string workflowId, string queue) => new(workflowId + "-" + Guid.NewGuid(), queue);
}
