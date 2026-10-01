using Claims.Config;
using Temporalio.Api.Enums.V1;
using Temporalio.Client;
using Temporalio.Client.Schedules;
using Temporalio.Exceptions;

namespace Claims.Temporal;

/// <summary>
/// Creates the Temporal Schedule that runs the dispatcher workflow every minute, once per namespace. Creating it again is a no-op.
/// Overlap policy Skip: if a run is still going when the next tick arrives, the tick is dropped (the next one will pick the rows up),
/// so runs never pile up.
/// NOT verified against a real server in this repo: the in-process test server does not implement Schedules.
/// Unlike the Java ApplicationRunner (which failed startup when Temporal was unreachable), this retries in the background.
/// </summary>
public sealed partial class DispatcherScheduleRegistrar(IServiceProvider services, ClaimsOptions options, TimeProvider clock,
                                                        ILogger<DispatcherScheduleRegistrar> log) : BackgroundService
{
    public const string ScheduleId = "claims-deadline-dispatcher";
    public const string WorkflowId = "deadline-dispatcher";

    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        if (!options.Temporal.Enabled || !options.Dispatcher.ScheduleEnabled) return;
        while (!stoppingToken.IsCancellationRequested)
        {
            try
            {
                await RegisterAsync();
                return;
            }
            catch (Exception e) when (e is not OperationCanceledException)
            {
                LogRetry(e.Message);
                await Task.Delay(TimeSpan.FromSeconds(10), clock, stoppingToken);
            }
        }
    }

    public async Task RegisterAsync()
    {
        var client = services.GetRequiredService<ITemporalClient>();
        var schedule = new Schedule(
            Action: ScheduleActionStartWorkflow.Create(
                (DeadlineDispatcherWorkflow wf) => wf.RunAsync(),
                new WorkflowOptions(WorkflowId, options.Temporal.TaskQueue)),
            Spec: new ScheduleSpec { Intervals = [new ScheduleIntervalSpec(options.Dispatcher.ScheduleInterval)] })
        {
            Policy = new SchedulePolicy { Overlap = ScheduleOverlapPolicy.Skip },
        };
        try
        {
            await client.CreateScheduleAsync(ScheduleId, schedule);
            LogCreated(ScheduleId, options.Dispatcher.ScheduleInterval);
        }
        catch (ScheduleAlreadyRunningException)
        {
            LogExists(ScheduleId);
        }
    }

    [LoggerMessage(Level = LogLevel.Information, Message = "Created Temporal Schedule {Id} every {Interval}")]
    private partial void LogCreated(string id, TimeSpan interval);

    [LoggerMessage(Level = LogLevel.Information, Message = "Temporal Schedule {Id} already exists")]
    private partial void LogExists(string id);

    [LoggerMessage(Level = LogLevel.Warning, Message = "Could not register the dispatcher Schedule, will retry: {Error}")]
    private partial void LogRetry(string error);
}
