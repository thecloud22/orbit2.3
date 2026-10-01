using Microsoft.Extensions.Configuration.Memory;

namespace Claims.Config;

/// <summary>
/// Everything tunable, bound from the "Claims" configuration section (appsettings.json, environment variables such as
/// Claims__Dispatcher__BatchSize, or the command line). The Java version's claims.* properties map one to one:
/// claims.dispatcher.batch-size is Claims:Dispatcher:BatchSize. Durations are TimeSpan text ("00:01:00").
/// The eight settings operations already know keep their names (CLAIMS_DB_URL and friends); see <see cref="EnvironmentAliases"/>.
/// </summary>
public sealed class ClaimsOptions
{
    public DbOptions Db { get; set; } = new();
    public BusinessOptions Business { get; set; } = new();
    public DispatcherOptions Dispatcher { get; set; } = new();
    public OutboxOptions Outbox { get; set; } = new();
    public TemporalOptions Temporal { get; set; } = new();
    public PaymentRunOptions PaymentRun { get; set; } = new();
    public OverdueCheckOptions OverdueCheck { get; set; } = new();
    public DevOptions Dev { get; set; } = new();

    public sealed class DbOptions
    {
        /// <summary>CLAIMS_DB_URL: a JDBC URL, a postgres:// URI or an Npgsql connection string.</summary>
        public string Url { get; set; } = "jdbc:postgresql://localhost:5432/claims";
        /// <summary>CLAIMS_DB_USER</summary>
        public string User { get; set; } = "claims";
        /// <summary>CLAIMS_DB_PASSWORD</summary>
        public string Password { get; set; } = "claims";
        /// <summary>Run the SQL migrations (DbUp) at startup, as Spring ran Flyway.</summary>
        public bool Migrate { get; set; } = true;
        /// <summary>Also run Db/Dev/R__dev_staff.sql (two development staff users). The Development environment turns this on.</summary>
        public bool DevSeed { get; set; }
    }

    /// <summary>Date-based deadlines (10 days, 15 days, 30 days) fall due at <see cref="FireTime"/> on the local date.</summary>
    public sealed class BusinessOptions
    {
        /// <summary>Where the mock story is set; the real value is per state rules.</summary>
        public string Zone { get; set; } = "America/Chicago";
        public TimeOnly FireTime { get; set; } = new(8, 0);
    }

    public sealed class DispatcherOptions
    {
        /// <summary>Rows taken per poll.</summary>
        public int BatchSize { get; set; } = 25;
        /// <summary>Declared for parity with the Java version, where it is also not read: the dispatcher workflow caps itself at 20 polls per run.</summary>
        public int MaxBatchesPerRun { get; set; } = 20;
        /// <summary>Backoff after a failed workflow start: RetryBase * attempt, capped at RetryMax.</summary>
        public TimeSpan RetryBase { get; set; } = TimeSpan.FromSeconds(30);
        public TimeSpan RetryMax { get; set; } = TimeSpan.FromMinutes(30);
        /// <summary>Register the Temporal Schedule that runs the dispatcher every minute.</summary>
        public bool ScheduleEnabled { get; set; } = true;
        public TimeSpan ScheduleInterval { get; set; } = TimeSpan.FromMinutes(1);
        /// <summary>Poll from an in-process timer instead (dev, or a platform without Schedules).</summary>
        public bool LocalPollEnabled { get; set; }
        public TimeSpan LocalPollInterval { get; set; } = TimeSpan.FromSeconds(60);
    }

    public sealed class OutboxOptions
    {
        public int BatchSize { get; set; } = 50;
        public bool PollEnabled { get; set; } = true;
        public TimeSpan PollInterval { get; set; } = TimeSpan.FromSeconds(1);
        public TimeSpan RetryBase { get; set; } = TimeSpan.FromSeconds(5);
    }

    public sealed class TemporalOptions
    {
        public bool Enabled { get; set; } = true;
        /// <summary>TEMPORAL_TARGET</summary>
        public string Target { get; set; } = "127.0.0.1:7233";
        /// <summary>TEMPORAL_NAMESPACE</summary>
        public string Namespace { get; set; } = "default";
        /// <summary>TEMPORAL_TASK_QUEUE</summary>
        public string TaskQueue { get; set; } = "claims";
        public bool WorkerEnabled { get; set; } = true;
        /// <summary>
        /// Local runs only: start a real Temporal dev server inside this process at startup (Temporalio.Testing.WorkflowEnvironment.StartLocalAsync;
        /// the SDK downloads the Temporal CLI once and caches it) and point the client, the worker and the Schedule at it. Overrides
        /// <see cref="Target"/>. Off by default; never for a real environment, where the org's Temporal is used.
        /// </summary>
        public bool DevServer { get; set; }
        /// <summary>Port the embedded dev server's gRPC frontend listens on.</summary>
        public int DevServerPort { get; set; } = 7233;
        /// <summary>Port of the embedded server's web UI (http://localhost:8233 by default); 0 turns the UI off.</summary>
        public int DevServerUiPort { get; set; } = 8233;
        /// <summary>An already downloaded Temporal CLI to run instead of downloading one (optional).</summary>
        public string? DevServerPath { get; set; }
        /// <summary>Keep the embedded server's data in this file so workflow history survives an API restart (default: in memory).</summary>
        public string? DevServerDbFile { get; set; }
    }

    /// <summary>The daily payment run: a plain batch, never a Temporal workflow.</summary>
    public sealed class PaymentRunOptions
    {
        /// <summary>Run the daily payment run from an in-process timer. Off by default; Development turns it on. A real deployment would use cron or the platform scheduler and call the same service.</summary>
        public bool ScheduleEnabled { get; set; }
        /// <summary>How often the trigger looks at the (business) clock. The run itself happens once per business date, at or after <see cref="RunTime"/>.</summary>
        public TimeSpan PollInterval { get; set; } = TimeSpan.FromMinutes(1);
        /// <summary>Local time in the business zone after which the day's scheduled run may happen (the mock's 02:00).</summary>
        public TimeOnly RunTime { get; set; } = new(2, 0);
        /// <summary>The returns batch (what the bank sent back) runs once per business date from this local time, from the same in-process trigger (the mock's returns job: 06:30).</summary>
        public TimeOnly ReturnsRunTime { get; set; } = new(6, 30);
    }

    /// <summary>The nightly overdue check (a batch): once per business date, at or after <see cref="RunTime"/>, from an in-process timer. Off by default; a real deployment calls the same service from cron.</summary>
    public sealed class OverdueCheckOptions
    {
        public bool ScheduleEnabled { get; set; }
        public TimeSpan PollInterval { get; set; } = TimeSpan.FromMinutes(1);
        /// <summary>Local time in the business zone after which the day's check runs (the mock's nightly check: 02:00 after the payment run; 02:30 here).</summary>
        public TimeOnly RunTime { get; set; } = new(2, 30);
    }

    /// <summary>Development-only switches. All off in production configuration.</summary>
    public sealed class DevOptions
    {
        /// <summary>Serve /dev/* (the virtual clock) and allow it to move business time. Never true in production.</summary>
        public bool Controls { get; set; }
        /// <summary>Named faults switched on at startup (for example "letters.down", "bank.down"); see <c>Gateway/FaultRegistry</c>. Off by default.</summary>
        public List<string> Faults { get; set; } = [];
        /// <summary>How long the fault worker.stall-once:&lt;activity&gt; hangs: it must be longer than the activity's StartToClose timeout (30 s), so Temporal really times the attempt out.</summary>
        public TimeSpan StallFor { get; set; } = TimeSpan.FromSeconds(35);
    }
}

/// <summary>Maps the environment variables operations already use onto the options, so they need no change.</summary>
public static class EnvironmentAliases
{
    private static readonly (string Variable, string Key)[] Map =
    [
        ("CLAIMS_DB_URL", "Claims:Db:Url"),
        ("CLAIMS_DB_USER", "Claims:Db:User"),
        ("CLAIMS_DB_PASSWORD", "Claims:Db:Password"),
        ("TEMPORAL_TARGET", "Claims:Temporal:Target"),
        ("TEMPORAL_NAMESPACE", "Claims:Temporal:Namespace"),
        ("TEMPORAL_TASK_QUEUE", "Claims:Temporal:TaskQueue"),
        ("TEMPORAL_DEV_SERVER_PATH", "Claims:Temporal:DevServerPath"),
    ];

    /// <summary>Added as the lowest-priority source, so appsettings files, Claims__* variables and the command line still win.</summary>
    public static ConfigurationManager AddClaimsEnvironmentAliases(this ConfigurationManager configuration)
    {
        var data = new Dictionary<string, string?>();
        foreach (var (variable, key) in Map)
        {
            var value = Environment.GetEnvironmentVariable(variable);
            if (!string.IsNullOrEmpty(value)) data[key] = value;
        }
        configuration.Sources.Insert(0, new MemoryConfigurationSource { InitialData = data });
        return configuration;
    }
}
