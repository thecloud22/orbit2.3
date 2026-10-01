using System.Runtime.CompilerServices;

namespace Claims.Tests.Support;

/// <summary>
/// A test that needs a real PostgreSQL (TEST_PG_URL, or Docker for Testcontainers). Skipped, with the reason, when there is none.
/// The equivalent of the Java @RequiresPostgres.
/// </summary>
[AttributeUsage(AttributeTargets.Method)]
public sealed class PostgresFactAttribute : FactAttribute
{
    public PostgresFactAttribute([CallerFilePath] string? sourceFilePath = null, [CallerLineNumber] int sourceLineNumber = -1)
        : base(sourceFilePath, sourceLineNumber)
    {
        if (!PostgresSupport.Available) Skip = PostgresSupport.SkipReason;
    }
}
