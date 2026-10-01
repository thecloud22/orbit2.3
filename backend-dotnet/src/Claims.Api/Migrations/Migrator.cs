using System.Reflection;
using DbUp;
using DbUp.Engine;
using DbUp.Helpers;

namespace Claims.Migrations;

/// <summary>
/// Runs the SQL migrations with DbUp. The scripts are the Flyway files V1..V5, unchanged, plus V6 (added for the simple scenario); each runs in its own transaction, in name
/// order, and is recorded once in the <c>schemaversions</c> table (Flyway used <c>flyway_schema_history</c>). The development staff
/// seed (Scripts/Dev/R__dev_staff.sql, a Flyway "repeatable" migration) is run on every start when requested, and is idempotent (ON CONFLICT DO NOTHING).
/// </summary>
public static class Migrator
{
    private static readonly Assembly Scripts = typeof(Migrator).Assembly;

    public static void Run(string connectionString, bool devSeed, Action<string> log)
    {
        var migrate = DeployChanges.To
            .PostgresqlDatabase(connectionString)
            .WithScriptsEmbeddedInAssembly(Scripts, name => name.Contains(".Migrations.Scripts.", StringComparison.Ordinal) && !name.Contains(".Scripts.Dev.", StringComparison.Ordinal))
            .WithTransactionPerScript()
            .WithVariablesDisabled()   // the scripts contain $$ ... $$ function bodies; nothing in them is a DbUp variable
            .LogTo(new LogAdapter(log))
            .Build();
        Check(migrate.PerformUpgrade());

        if (!devSeed) return;
        var seed = DeployChanges.To
            .PostgresqlDatabase(connectionString)
            .WithScriptsEmbeddedInAssembly(Scripts, name => name.Contains(".Migrations.Scripts.Dev.", StringComparison.Ordinal))
            .WithTransactionPerScript()
            .WithVariablesDisabled()
            .JournalTo(new NullJournal())   // repeatable: run every time
            .LogTo(new LogAdapter(log))
            .Build();
        Check(seed.PerformUpgrade());
    }

    private static void Check(DatabaseUpgradeResult result)
    {
        if (!result.Successful) throw new InvalidOperationException("Database migration failed: " + result.Error?.Message, result.Error);
    }

    private sealed class LogAdapter(Action<string> log) : DbUp.Engine.Output.IUpgradeLog
    {
        public void LogTrace(string format, params object[] args) { }
        public void LogDebug(string format, params object[] args) { }
        public void LogInformation(string format, params object[] args) => log(string.Format(System.Globalization.CultureInfo.InvariantCulture, format, args));
        public void LogWarning(string format, params object[] args) => log("WARN " + string.Format(System.Globalization.CultureInfo.InvariantCulture, format, args));
        public void LogError(string format, params object[] args) => log("ERROR " + string.Format(System.Globalization.CultureInfo.InvariantCulture, format, args));
        public void LogError(Exception ex, string format, params object[] args) => log("ERROR " + string.Format(System.Globalization.CultureInfo.InvariantCulture, format, args) + " " + ex.Message);
    }
}
