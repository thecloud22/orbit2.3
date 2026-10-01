using Claims.Clock;
using Claims.Common;
using Claims.Config;

namespace Claims.Payment;

/// <summary>
/// The daily trigger of the payment run, in-process (Claims:PaymentRun:ScheduleEnabled; off by default, on in Development). Every PollInterval of
/// REAL time it reads the business clock: from RunTime on, the business date's scheduled run happens once (the unique index makes a second attempt
/// a no-op, so a restart or a second instance is harmless). In production the same <see cref="PaymentRunService.RunScheduledAsync"/> is called by cron or the
/// platform scheduler; Temporal is not involved.
/// </summary>
public sealed partial class PaymentRunPoller(PaymentRunService service, IClock clock, BusinessCalendar calendar, ClaimsOptions options, TimeProvider delays,
                                             ILogger<PaymentRunPoller> log) : BackgroundService
{
    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        if (!options.PaymentRun.ScheduleEnabled) return;
        while (!stoppingToken.IsCancellationRequested)
        {
            try
            {
                var local = TimeZoneInfo.ConvertTime(clock.UtcNow, calendar.Zone);
                if (TimeOnly.FromDateTime(local.DateTime) >= options.PaymentRun.RunTime)
                {
                    var run = await service.RunScheduledAsync(calendar.LocalDate(clock.UtcNow));
                    if (run is not null) LogRan(run.RunDate.ToString("yyyy-MM-dd", System.Globalization.CultureInfo.InvariantCulture), run.ItemCount, run.PaidCount, run.Status);
                }
            }
            catch (Exception e) when (e is not OperationCanceledException)
            {
                LogFailed(e);
            }
            await Task.Delay(options.PaymentRun.PollInterval, delays, stoppingToken);
        }
    }

    [LoggerMessage(Level = LogLevel.Information, Message = "Scheduled payment run {Date}: {Items} items, {Paid} paid, {Status}")]
    private partial void LogRan(string date, int items, int paid, string status);

    [LoggerMessage(Level = LogLevel.Error, Message = "Scheduled payment run failed")]
    private partial void LogFailed(Exception e);
}
