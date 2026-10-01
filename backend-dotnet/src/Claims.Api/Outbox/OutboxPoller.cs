using Claims.Config;

namespace Claims.Outbox;

/// <summary>Runs the outbox relay every Claims:Outbox:PollInterval (a fixed delay after each pass, as Spring's fixedDelay).</summary>
public sealed partial class OutboxPoller(OutboxRelay relay, ClaimsOptions options, TimeProvider clock, ILogger<OutboxPoller> log) : BackgroundService
{
    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        if (!options.Outbox.PollEnabled) return;
        while (!stoppingToken.IsCancellationRequested)
        {
            try
            {
                await relay.PublishPendingAsync();
            }
            catch (Exception e) when (e is not OperationCanceledException)
            {
                LogFailed(e);
            }
            await Task.Delay(options.Outbox.PollInterval, clock, stoppingToken);
        }
    }

    [LoggerMessage(Level = LogLevel.Error, Message = "Outbox relay pass failed")]
    private partial void LogFailed(Exception e);
}
