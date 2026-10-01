using Claims.Clock;
using Claims.Common;
using Claims.Config;

namespace Claims.Deadline;

/// <summary>
/// The nightly overdue check's trigger, in-process (Claims:OverdueCheck:ScheduleEnabled; off by default): from <c>RunTime</c> (local business time, 02:30) on, once per business date, it runs
/// <see cref="OverdueCheckService"/>. The check itself is idempotent (a work item exists once per overdue row), so a restart or a second instance is harmless. In production cron or the
/// platform scheduler calls the same service. (A Temporal Schedule around the same call is possible and not built: nothing here needs Temporal.)
/// </summary>
public sealed partial class OverdueCheckPoller(OverdueCheckService service, IClock clock, BusinessCalendar calendar, ClaimsOptions options, TimeProvider delays,
                                               ILogger<OverdueCheckPoller> log) : BackgroundService
{
    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        if (!options.OverdueCheck.ScheduleEnabled) return;
        DateOnly? lastDate = null;
        while (!stoppingToken.IsCancellationRequested)
        {
            try
            {
                var local = TimeZoneInfo.ConvertTime(clock.UtcNow, calendar.Zone);
                var today = calendar.LocalDate(clock.UtcNow);
                if (TimeOnly.FromDateTime(local.DateTime) >= options.OverdueCheck.RunTime && lastDate != today)
                {
                    var r = await service.RunAsync();
                    lastDate = today;
                    if (r.Items.Count > 0) LogRan(r.Raised, r.AlreadyRaised);
                }
            }
            catch (Exception e) when (e is not OperationCanceledException)
            {
                LogFailed(e);
            }
            await Task.Delay(options.OverdueCheck.PollInterval, delays, stoppingToken);
        }
    }

    [LoggerMessage(Level = LogLevel.Information, Message = "Overdue check: {Raised} raised, {AlreadyRaised} already raised")]
    private partial void LogRan(int raised, int alreadyRaised);

    [LoggerMessage(Level = LogLevel.Error, Message = "Overdue check failed")]
    private partial void LogFailed(Exception e);
}
