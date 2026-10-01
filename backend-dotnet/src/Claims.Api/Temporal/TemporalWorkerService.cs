using Claims.Config;
using Temporalio.Client;
using Temporalio.Worker;
using Temporalio.Worker.Interceptors;

namespace Claims.Temporal;

/// <summary>
/// Runs the worker for the whole life of the host and lets running activities finish on shutdown. Does nothing when
/// Claims:Temporal:Enabled or Claims:Temporal:WorkerEnabled is false. A worker needs a connected client (a lazy one is refused), so this
/// connects itself and, if Temporal is down, keeps trying every 10 seconds instead of stopping the host: the API and the pollers stay up.
/// </summary>
public sealed partial class TemporalWorkerService(IServiceProvider services, ClaimsOptions options, TimeProvider clock,
                                                  ILogger<TemporalWorkerService> log) : BackgroundService
{
    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        if (!options.Temporal.Enabled || !options.Temporal.WorkerEnabled) return;
        while (!stoppingToken.IsCancellationRequested)
        {
            try
            {
                var client = await TemporalClient.ConnectAsync(TemporalSetup.ClientOptions(options.Temporal));
                using var worker = new TemporalWorker(client, WorkerOptions(options.Temporal.TaskQueue,
                    services.GetRequiredService<LifeIntakeActivities>(), services.GetRequiredService<RequirementFollowUpActivities>(),
                    services.GetRequiredService<DispatcherActivities>(), services.GetRequiredService<DecisionRecordedActivities>(),
                    services.GetRequiredService<PaymentConfirmedActivities>(), services.GetRequiredService<DocumentReceivedActivities>(),
                    services.GetRequiredService<DocumentRejectedActivities>(), services.GetRequiredService<PaymentReturnedActivities>(),
                    services.GetRequiredService<PaymentMethodUpdatedActivities>(), services.GetRequiredService<WorkerFaultInterceptor>()));
                await worker.ExecuteAsync(stoppingToken);
                return;
            }
            catch (Exception e) when (e is not OperationCanceledException)
            {
                LogRetry(options.Temporal.Target, e.Message);
                await Task.Delay(TimeSpan.FromSeconds(10), clock, stoppingToken);
            }
        }
    }

    /// <summary>Shared with the tests, which register the same classes on a test environment's worker.</summary>
    public static TemporalWorkerOptions WorkerOptions(string taskQueue, LifeIntakeActivities? intake, RequirementFollowUpActivities? followUp,
                                                      DispatcherActivities? dispatcher = null, DecisionRecordedActivities? decision = null,
                                                      PaymentConfirmedActivities? paymentConfirmed = null, DocumentReceivedActivities? documentReceived = null,
                                                      DocumentRejectedActivities? documentRejected = null, PaymentReturnedActivities? paymentReturned = null,
                                                      PaymentMethodUpdatedActivities? paymentMethodUpdated = null, IWorkerInterceptor? interceptor = null)
    {
        var o = new TemporalWorkerOptions(taskQueue)
            .AddWorkflow<LifeIntakeWorkflow>()
            .AddWorkflow<RequirementFollowUpWorkflow>()
            .AddWorkflow<DeadlineDispatcherWorkflow>()
            .AddWorkflow<DecisionRecordedWorkflow>()
            .AddWorkflow<PaymentConfirmedWorkflow>()
            .AddWorkflow<DocumentReceivedWorkflow>()
            .AddWorkflow<DocumentRejectedWorkflow>()
            .AddWorkflow<PaymentReturnedWorkflow>()
            .AddWorkflow<PaymentMethodUpdatedWorkflow>();
        if (interceptor is not null) o.Interceptors = [interceptor];
        if (documentReceived is not null) o.AddAllActivities(documentReceived);
        if (documentRejected is not null) o.AddAllActivities(documentRejected);
        if (paymentReturned is not null) o.AddAllActivities(paymentReturned);
        if (paymentMethodUpdated is not null) o.AddAllActivities(paymentMethodUpdated);
        if (decision is not null) o.AddAllActivities(decision);
        if (paymentConfirmed is not null) o.AddAllActivities(paymentConfirmed);
        if (intake is not null) o.AddAllActivities(intake);
        if (followUp is not null) o.AddAllActivities(followUp);
        if (dispatcher is not null) o.AddAllActivities(dispatcher);
        return o;
    }

    [LoggerMessage(Level = LogLevel.Warning, Message = "Temporal worker could not run against {Target}, will retry: {Error}")]
    private partial void LogRetry(string target, string error);
}
