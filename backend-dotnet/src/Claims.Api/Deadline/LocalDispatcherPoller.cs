using Claims.Config;

namespace Claims.Deadline;

/// <summary>
/// Optional in-process trigger for the dispatcher (Claims:Dispatcher:LocalPollEnabled=true). In production the Temporal Schedule
/// triggers it; this is for local dev and for a platform without Schedules (an open question in the architecture). Safe alongside the
/// Schedule: SKIP LOCKED keeps them from taking the same rows.
/// </summary>
public sealed partial class LocalDispatcherPoller(DeadlineDispatcher dispatcher, ClaimsOptions options, TimeProvider clock,
                                                  ILogger<LocalDispatcherPoller> log) : BackgroundService
{
    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        if (!options.Dispatcher.LocalPollEnabled) return;
        while (!stoppingToken.IsCancellationRequested)
        {
            try
            {
                var r = await dispatcher.DispatchDueAsync();
                if (r.Claimed > 0) LogRan(r);
            }
            catch (Exception e) when (e is not OperationCanceledException)
            {
                LogFailed(e);
            }
            await Task.Delay(options.Dispatcher.LocalPollInterval, clock, stoppingToken);   // fixed delay after each poll, as Spring's fixedDelay
        }
    }

    [LoggerMessage(Level = LogLevel.Information, Message = "Dispatcher: {Result}")]
    private partial void LogRan(DeadlineDispatcher.Result result);

    [LoggerMessage(Level = LogLevel.Error, Message = "Dispatcher poll failed")]
    private partial void LogFailed(Exception e);
}
