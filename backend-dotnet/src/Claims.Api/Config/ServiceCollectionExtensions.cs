using Claims.Clock;
using Claims.Common;
using Claims.Decision;
using Claims.Documents;
using Claims.Events;
using Claims.Payment;
using Claims.Deadline;
using Claims.Gateway;
using Claims.Intake;
using Claims.Outbox;
using Claims.Requirement;
using Claims.Store;
using Claims.Temporal;
using Npgsql;
using Temporalio.Client;

namespace Claims.Config;

/// <summary>The composition root: what Spring's component scan and @ConditionalOnProperty did.</summary>
public static class ServiceCollectionExtensions
{
    public static IServiceCollection AddClaims(this IServiceCollection services, IConfiguration configuration)
    {
        // Options are read when first needed (not while the container is built), so configuration added later, such as a test
        // host's overrides, is honoured. The optional pieces below are always registered and switch themselves off from the options.
        services.AddSingleton(sp => sp.GetRequiredService<IConfiguration>().GetSection("Claims").Get<ClaimsOptions>() ?? new ClaimsOptions());
        // One clock object, two faces: IClock is the business clock (real time unless a Development control moved it), and it is also the
        // TimeProvider, whose timers and delays stay on real time. Nothing but /dev/clock changes the offset.
        services.AddSingleton<VirtualClock>();
        services.AddSingleton<IClock>(sp => sp.GetRequiredService<VirtualClock>());
        services.AddSingleton<TimeProvider>(sp => sp.GetRequiredService<VirtualClock>());

        // Data access
        services.AddSingleton(sp =>
        {
            var db = sp.GetRequiredService<ClaimsOptions>().Db;
            return NpgsqlDataSource.Create(PgConnection.Build(db.Url, db.User, db.Password));
        });
        services.AddSingleton<Db>();
        services.AddSingleton(sp =>
        {
            var business = sp.GetRequiredService<ClaimsOptions>().Business;
            return new BusinessCalendar(TimeZoneInfo.FindSystemTimeZoneById(business.Zone), business.FireTime);
        });

        services.AddSingleton<ClaimQueries>();
        services.AddSingleton<StaffRepository>();
        services.AddSingleton<DecisionRepository>();
        services.AddSingleton<PaymentRepository>();
        services.AddSingleton<DeadlineRepository>();
        services.AddSingleton<HistoryRepository>();
        services.AddSingleton<LetterRepository>();
        services.AddSingleton<LetterService>();
        services.AddSingleton<OutboxRepository>();
        services.AddSingleton<RequirementRepository>();
        services.AddSingleton<WorkItemRepository>();
        services.AddSingleton<WorkflowRunRepository>();
        services.AddSingleton<DocumentRepository>();
        services.AddSingleton<IdempotencyRepository>();

        // Outside systems (stubs)
        services.AddSingleton<INotificationGateway, LoggingNotificationGateway>();
        services.AddSingleton<IPolicyAdminGateway, SnapshotPolicyAdminGateway>();
        services.AddSingleton<ISanctionsGateway, StubSanctionsGateway>();
        services.AddSingleton<ITinMatchGateway, StubTinMatchGateway>();
        services.AddSingleton<IFaultRegistry, FaultRegistry>();
        services.AddSingleton<StubBankGateway>();
        services.AddSingleton<IBankGateway>(sp => sp.GetRequiredService<StubBankGateway>());

        // Application services
        services.AddSingleton<LifeIntakeService>();
        services.AddSingleton<IntakeSetupService>();
        services.AddSingleton<RequirementService>();
        services.AddSingleton<DeadlineService>();
        services.AddSingleton<FollowUpService>();
        services.AddSingleton<DeadlineDispatcher>();
        services.AddSingleton<OutboxRelay>();
        services.AddSingleton<DecisionService>();
        services.AddSingleton<PaymentRunService>();
        services.AddSingleton<PaymentItemService>();
        services.AddSingleton<WorkItemService>();
        services.AddSingleton<DecisionEventService>();
        services.AddSingleton<PaymentEventService>();
        services.AddSingleton<DocumentService>();
        services.AddSingleton<DocumentEventService>();
        services.AddSingleton<WorkflowFailureRecorder>();
        services.AddSingleton<PaymentReturnsService>();
        services.AddSingleton<PaymentMethodService>();
        services.AddSingleton<PaymentReturnEventService>();
        services.AddSingleton<OverdueCheckService>();
        services.AddSingleton<WorkflowRerunService>();

        // Temporal
        services.AddSingleton<LifeIntakeActivities>();
        services.AddSingleton<RequirementFollowUpActivities>();
        services.AddSingleton<DispatcherActivities>();
        services.AddSingleton<DecisionRecordedActivities>();
        services.AddSingleton<PaymentConfirmedActivities>();
        services.AddSingleton<DocumentReceivedActivities>();
        services.AddSingleton<DocumentRejectedActivities>();
        services.AddSingleton<PaymentReturnedActivities>();
        services.AddSingleton<PaymentMethodUpdatedActivities>();
        services.AddSingleton<WorkerFaultInterceptor>();
        services.AddSingleton(sp => TemporalSetup.CreateClient(sp.GetRequiredService<ClaimsOptions>().Temporal));
        services.AddSingleton<IWorkflowLauncher>(sp => sp.GetRequiredService<ClaimsOptions>().Temporal.Enabled
            ? new TemporalWorkflowLauncher(sp.GetRequiredService<ITemporalClient>(), sp.GetRequiredService<ClaimsOptions>())
            : new DisabledWorkflowLauncher());

        // Background triggers: the worker, the Schedule registrar, the outbox poller and the optional local dispatcher poller
        services.AddHostedService<TemporalWorkerService>();
        services.AddHostedService<DispatcherScheduleRegistrar>();
        services.AddHostedService<OutboxPoller>();
        services.AddHostedService<LocalDispatcherPoller>();
        services.AddHostedService<PaymentRunPoller>();
        services.AddHostedService<PaymentReturnsPoller>();
        services.AddHostedService<OverdueCheckPoller>();
        return services;
    }
}
