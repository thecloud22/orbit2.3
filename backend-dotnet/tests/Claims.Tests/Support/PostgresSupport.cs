using System.Diagnostics;
using Claims.Common;
using Npgsql;
using Testcontainers.PostgreSql;

namespace Claims.Tests.Support;

/// <summary>
/// Where the Postgres-backed tests get a real PostgreSQL (never an in-memory stand-in: SKIP LOCKED, partial indexes, triggers and
/// jsonb must behave like production). In order:
///   1. TEST_PG_URL (+ TEST_PG_USER, TEST_PG_PASSWORD): an existing server, e.g. a throwaway `initdb` cluster. Each test class gets its
///      own freshly created database on it. The URL may be the JDBC form the Java tests used
///      (jdbc:postgresql://127.0.0.1:55432/postgres) or an Npgsql connection string (Host=127.0.0.1;Port=55432;Database=postgres).
///   2. Testcontainers (postgres:16-alpine), when a Docker daemon is reachable.
///   3. Neither: <see cref="Available"/> is false and the tests are skipped with a message that says why.
/// </summary>
public static class PostgresSupport
{
    private sealed record Resolution(string? AdminConnectionString, bool UseContainer, string? SkipReason);

    private static readonly Lazy<Resolution> Resolved = new(Resolve);
    private static readonly SemaphoreSlim ContainerLock = new(1, 1);
    private static PostgreSqlContainer? container;

    public static bool Available => Resolved.Value.SkipReason is null;

    public static string SkipReason => "REQUIRES POSTGRES/DOCKER: " + Resolved.Value.SkipReason;

    private static Resolution Resolve()
    {
        var env = Environment.GetEnvironmentVariable("TEST_PG_URL");
        if (!string.IsNullOrWhiteSpace(env))
        {
            var user = Environment.GetEnvironmentVariable("TEST_PG_USER");
            var password = Environment.GetEnvironmentVariable("TEST_PG_PASSWORD");
            return new Resolution(PgConnection.Build(env, string.IsNullOrEmpty(user) ? "postgres" : user, password ?? ""), false, null);
        }
        return DockerDaemonRunning()
            ? new Resolution(null, true, null)
            : new Resolution(null, false, "TEST_PG_URL is not set and no Docker daemon is running");
    }

    /// <summary>The same probe as `docker info` in claims.sh: is a daemon answering?</summary>
    private static bool DockerDaemonRunning()
    {
        try
        {
            using var p = Process.Start(new ProcessStartInfo("docker", "info") { RedirectStandardOutput = true, RedirectStandardError = true })!;
            if (!p.WaitForExit(15_000))
            {
                p.Kill();
                return false;
            }
            return p.ExitCode == 0;
        }
        catch (System.ComponentModel.Win32Exception)
        {
            return false;   // no docker CLI
        }
    }

    private static async Task<string> AdminConnectionStringAsync()
    {
        var r = Resolved.Value;
        if (r.SkipReason is not null) throw new InvalidOperationException(SkipReason);
        if (!r.UseContainer) return r.AdminConnectionString!;
        await ContainerLock.WaitAsync();
        try
        {
            if (container is null)
            {
                var started = new PostgreSqlBuilder("postgres:16-alpine").Build();
                await started.StartAsync();
                container = started;
            }
            return container.GetConnectionString();
        }
        finally
        {
            ContainerLock.Release();
        }
    }

    /// <summary>Creates an empty database for one test class and returns its Npgsql connection string; the app's migrations fill it.</summary>
    public static async Task<string> NewDatabaseAsync(string hint)
    {
        var admin = await AdminConnectionStringAsync();
        var name = "claims_" + new string(hint.ToLowerInvariant().Where(char.IsAsciiLetterOrDigit).ToArray()) + "_" + Guid.NewGuid().ToString("N")[..8];
        await using (var connection = new NpgsqlConnection(admin))
        {
            await connection.OpenAsync();
            await using var command = new NpgsqlCommand("CREATE DATABASE " + name, connection);
            await command.ExecuteNonQueryAsync();
        }
        return PgConnection.WithDatabase(admin, name);
    }
}
