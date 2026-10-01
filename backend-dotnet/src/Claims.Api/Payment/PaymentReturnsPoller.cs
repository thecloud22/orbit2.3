using Claims.Clock;
using Claims.Common;
using Claims.Config;

namespace Claims.Payment;

/// <summary>
/// The daily job that runs the returns batch (<see cref="PaymentReturnsService"/>), in-process like <see cref="PaymentRunPoller"/> (Claims:PaymentRun:ScheduleEnabled; on in Development):
/// from <c>ReturnsRunTime</c> (local business time, 06:30) on, once per business date. Running it more often would be harmless (an item already returned is skipped); the once-a-day
/// guard only keeps the log quiet. In production cron or the platform scheduler calls the same service; Temporal is not involved.
/// </summary>
public sealed partial class PaymentReturnsPoller(PaymentReturnsService service, IClock clock, BusinessCalendar calendar, ClaimsOptions options, TimeProvider delays,
                                                 ILogger<PaymentReturnsPoller> log) : BackgroundService
{
    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        if (!options.PaymentRun.ScheduleEnabled) return;
        DateOnly? lastDate = null;
        while (!stoppingToken.IsCancellationRequested)
        {
            try
            {
                var local = TimeZoneInfo.ConvertTime(clock.UtcNow, calendar.Zone);
                var today = calendar.LocalDate(clock.UtcNow);
                if (TimeOnly.FromDateTime(local.DateTime) >= options.PaymentRun.ReturnsRunTime && lastDate != today)
                {
                    var r = await service.ProcessAsync("returns job");
                    lastDate = today;
                    if (r.Read > 0) LogRan(r.Read, r.Processed.Count, r.Skipped.Count);
                }
            }
            catch (Exception e) when (e is not OperationCanceledException)
            {
                LogFailed(e);
            }
            await Task.Delay(options.PaymentRun.PollInterval, delays, stoppingToken);
        }
    }

    [LoggerMessage(Level = LogLevel.Information, Message = "Returns batch: {Read} read, {Processed} processed, {Skipped} skipped")]
    private partial void LogRan(int read, int processed, int skipped);

    [LoggerMessage(Level = LogLevel.Error, Message = "Returns batch failed")]
    private partial void LogFailed(Exception e);
}
