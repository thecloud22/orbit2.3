using System.Globalization;
using Npgsql;

namespace Claims.Common;

/// <summary>
/// Turns the database settings into an Npgsql connection string. CLAIMS_DB_URL and TEST_PG_URL keep working exactly as they did for
/// the Java version, so operations docs stay valid: a JDBC URL (<c>jdbc:postgresql://host:5432/db?sslmode=require</c>), a
/// <c>postgres://</c> URI, or an Npgsql key=value string (<c>Host=..;Port=..;Database=..</c>) are all accepted. A user and password
/// given separately (CLAIMS_DB_USER / CLAIMS_DB_PASSWORD) fill in whatever the URL does not carry.
/// </summary>
public static class PgConnection
{
    public static string Build(string url, string? user, string? password)
    {
        var b = Parse(url);
        if (string.IsNullOrEmpty(b.Username) && !string.IsNullOrEmpty(user)) b.Username = user;
        if (string.IsNullOrEmpty(b.Password) && password is not null) b.Password = password;
        return b.ConnectionString;
    }

    public static NpgsqlConnectionStringBuilder Parse(string url)
    {
        var text = url.Trim();
        if (text.StartsWith("jdbc:", StringComparison.OrdinalIgnoreCase)) text = text["jdbc:".Length..];
        if (text.StartsWith("postgresql://", StringComparison.OrdinalIgnoreCase) || text.StartsWith("postgres://", StringComparison.OrdinalIgnoreCase))
        {
            var uri = new Uri(text);
            var b = new NpgsqlConnectionStringBuilder { Host = uri.Host, Port = uri.IsDefaultPort || uri.Port < 0 ? 5432 : uri.Port };
            var db = uri.AbsolutePath.Trim('/');
            if (db.Length > 0) b.Database = Uri.UnescapeDataString(db);
            if (!string.IsNullOrEmpty(uri.UserInfo))
            {
                var parts = uri.UserInfo.Split(':', 2);
                b.Username = Uri.UnescapeDataString(parts[0]);
                if (parts.Length > 1) b.Password = Uri.UnescapeDataString(parts[1]);
            }
            foreach (var pair in uri.Query.TrimStart('?').Split('&', StringSplitOptions.RemoveEmptyEntries))
            {
                var kv = pair.Split('=', 2);
                var key = Uri.UnescapeDataString(kv[0]).ToLowerInvariant();
                var value = kv.Length > 1 ? Uri.UnescapeDataString(kv[1]) : "";
                switch (key)
                {
                    case "user": b.Username = value; break;
                    case "password": b.Password = value; break;
                    case "sslmode": b.SslMode = Enum.Parse<SslMode>(value.Replace("-", "", StringComparison.Ordinal), ignoreCase: true); break;
                    case "applicationname": b.ApplicationName = value; break;
                    case "connecttimeout": b.Timeout = int.Parse(value, CultureInfo.InvariantCulture); break;
                    // Other JDBC-only options (currentSchema, ...) are ignored.
                }
            }
            return b;
        }
        return new NpgsqlConnectionStringBuilder(text);
    }

    /// <summary>The same server, another database (the tests create one database per test class).</summary>
    public static string WithDatabase(string connectionString, string database) =>
        new NpgsqlConnectionStringBuilder(connectionString) { Database = database }.ConnectionString;
}
