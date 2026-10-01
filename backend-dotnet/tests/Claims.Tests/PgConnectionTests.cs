using Claims.Common;

namespace Claims.Tests;

/// <summary>Not a port: CLAIMS_DB_URL and TEST_PG_URL must keep accepting the JDBC form the Java version documented.</summary>
public class PgConnectionTests
{
    [Fact]
    public void AJdbcUrlIsUnderstoodAsBefore()
    {
        var b = PgConnection.Parse("jdbc:postgresql://127.0.0.1:55432/postgres");
        Assert.Equal("127.0.0.1", b.Host);
        Assert.Equal(55432, b.Port);
        Assert.Equal("postgres", b.Database);
    }

    [Fact]
    public void UserAndPasswordFromTheirOwnSettingsFillInWhatTheUrlLacks()
    {
        var b = PgConnection.Parse(PgConnection.Build("jdbc:postgresql://db.example:5432/claims?sslmode=require", "claims", "s3cret"));
        Assert.Equal("db.example", b.Host);
        Assert.Equal("claims", b.Username);
        Assert.Equal("s3cret", b.Password);
        Assert.Equal(Npgsql.SslMode.Require, b.SslMode);
    }

    [Fact]
    public void ANpgsqlConnectionStringPassesThrough()
    {
        var b = PgConnection.Parse("Host=127.0.0.1;Port=55432;Database=postgres;Username=postgres");
        Assert.Equal(55432, b.Port);
        Assert.Equal("postgres", b.Username);
    }
}
