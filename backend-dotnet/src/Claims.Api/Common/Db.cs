using System.Data.Common;
using System.Globalization;
using Dapper;
using Npgsql;

namespace Claims.Common;

/// <summary>
/// The data access seam: Dapper over an NpgsqlDataSource, with Spring-style transactions. Inside <see cref="InTransactionAsync{T}"/>
/// every call on this class (from any repository) uses the same connection and transaction, and a nested call joins the outer one
/// (REQUIRED); outside a transaction each call gets its own pooled connection and autocommits. Any exception rolls back.
/// </summary>
public sealed class Db(NpgsqlDataSource dataSource)
{
    static Db()
    {
        SqlMapper.AddTypeHandler(new DateOnlyHandler());
    }

    private static readonly AsyncLocal<Scope?> Ambient = new();

    private sealed class Scope(NpgsqlConnection connection, NpgsqlTransaction transaction)
    {
        public NpgsqlConnection Connection { get; } = connection;
        public NpgsqlTransaction Transaction { get; } = transaction;
    }

    public NpgsqlDataSource DataSource => dataSource;

    // ------------------------------------------------------------------ transactions

    public async Task<T> InTransactionAsync<T>(Func<Task<T>> work)
    {
        if (Ambient.Value is not null) return await work();
        await using var connection = await dataSource.OpenConnectionAsync();
        await using var transaction = await connection.BeginTransactionAsync();
        Ambient.Value = new Scope(connection, transaction);
        try
        {
            var result = await work();
            await transaction.CommitAsync();
            return result;
        }
        catch
        {
            await transaction.RollbackAsync();
            throw;
        }
        finally
        {
            Ambient.Value = null;
        }
    }

    public async Task InTransactionAsync(Func<Task> work) =>
        await InTransactionAsync(async () =>
        {
            await work();
            return true;
        });

    // ------------------------------------------------------------------ statements

    private async Task<TResult> WithConnectionAsync<TResult>(Func<NpgsqlConnection, NpgsqlTransaction?, Task<TResult>> run)
    {
        if (Ambient.Value is { } scope) return await run(scope.Connection, scope.Transaction);
        await using var connection = await dataSource.OpenConnectionAsync();
        return await run(connection, null);
    }

    public Task<int> ExecuteAsync(string sql, object? param = null) =>
        WithConnectionAsync((c, t) => c.ExecuteAsync(new CommandDefinition(sql, param, t)));

    /// <summary>Exactly one row, one column (Spring's <c>.query(T.class).single()</c>).</summary>
    public Task<T> SingleAsync<T>(string sql, object? param = null) =>
        WithConnectionAsync((c, t) => c.QuerySingleAsync<T>(new CommandDefinition(sql, param, t)));

    /// <summary>Zero or one row, one column (<c>.optional()</c>). A NULL value comes back as default.</summary>
    public Task<T?> SingleOrDefaultAsync<T>(string sql, object? param = null) =>
        WithConnectionAsync((c, t) => c.QuerySingleOrDefaultAsync<T>(new CommandDefinition(sql, param, t)));

    /// <summary>All rows of one column (<c>.list()</c>).</summary>
    public async Task<List<T>> ListAsync<T>(string sql, object? param = null) =>
        (await WithConnectionAsync((c, t) => c.QueryAsync<T>(new CommandDefinition(sql, param, t)))).AsList();

    /// <summary>All rows through an explicit row mapper: the equivalent of Spring's <c>(rs, n) -&gt; new View(...)</c> lambdas.</summary>
    public Task<List<T>> QueryAsync<T>(string sql, object? param, Func<DbRow, T> map) =>
        WithConnectionAsync(async (c, t) =>
        {
            await using var reader = await c.ExecuteReaderAsync(new CommandDefinition(sql, param, t));
            var rows = new List<T>();
            while (await reader.ReadAsync()) rows.Add(map(new DbRow(reader)));
            return rows;
        });

    public async Task<T?> QueryOptionalAsync<T>(string sql, object? param, Func<DbRow, T> map) where T : class
    {
        var rows = await QueryAsync(sql, param, map);
        return rows.Count switch
        {
            0 => null,
            1 => rows[0],
            _ => throw new InvalidOperationException($"Expected at most one row, got {rows.Count}"),
        };
    }

    public async Task<T> QuerySingleAsync<T>(string sql, object? param, Func<DbRow, T> map)
    {
        var rows = await QueryAsync(sql, param, map);
        return rows.Count == 1 ? rows[0] : throw new InvalidOperationException($"Expected exactly one row, got {rows.Count}");
    }

    // ------------------------------------------------------------------ small helpers

    /// <summary>A Postgres array literal (<c>{"a","b"}</c>) for use as <c>cast(@x as text[])</c>. Same trick as the Java version.</summary>
    public static string ArrayLiteral(IEnumerable<string> values) =>
        "{" + string.Join(",", values.Select(v => "\"" + v.Replace("\\", "\\\\", StringComparison.Ordinal).Replace("\"", "\\\"", StringComparison.Ordinal) + "\"")) + "}";

    private sealed class DateOnlyHandler : SqlMapper.TypeHandler<DateOnly>
    {
        public override DateOnly Parse(object value) => value switch
        {
            DateOnly d => d,
            DateTime dt => DateOnly.FromDateTime(dt),
            _ => DateOnly.Parse(Convert.ToString(value, CultureInfo.InvariantCulture)!, CultureInfo.InvariantCulture),
        };

        public override void SetValue(System.Data.IDbDataParameter parameter, DateOnly value)
        {
            parameter.Value = value;
            if (parameter is NpgsqlParameter p) p.NpgsqlDbType = NpgsqlTypes.NpgsqlDbType.Date;
        }
    }
}

/// <summary>Named column access over a <see cref="DbDataReader"/>, so a row mapper reads like the Java <c>rs.getString("x")</c> lambdas.</summary>
public readonly struct DbRow(DbDataReader reader)
{
    private int O(string column) => reader.GetOrdinal(column);

    public bool IsNull(string column) => reader.IsDBNull(O(column));

    public Guid Guid(string column) => reader.GetFieldValue<Guid>(O(column));
    public Guid? GuidOrNull(string column) => IsNull(column) ? null : Guid(column);

    public string? Str(string column) => IsNull(column) ? null : reader.GetString(O(column));
    public string Text(string column) => Str(column) ?? throw new InvalidOperationException($"{column} is null");

    public int Int(string column) => Convert.ToInt32(reader.GetValue(O(column)), CultureInfo.InvariantCulture);
    public long Long(string column) => Convert.ToInt64(reader.GetValue(O(column)), CultureInfo.InvariantCulture);
    public bool Bool(string column) => reader.GetBoolean(O(column));
    public decimal Decimal(string column) => reader.GetDecimal(O(column));
    public decimal? DecimalOrNull(string column) => IsNull(column) ? null : Decimal(column);

    public DateTimeOffset Instant(string column) => reader.GetFieldValue<DateTimeOffset>(O(column));
    public DateTimeOffset? InstantOrNull(string column) => IsNull(column) ? null : Instant(column);

    public DateOnly Date(string column) => reader.GetFieldValue<DateOnly>(O(column));
    public DateOnly? DateOrNull(string column) => IsNull(column) ? null : Date(column);

    public string[] TextArray(string column) => IsNull(column) ? [] : reader.GetFieldValue<string[]>(O(column));
}
