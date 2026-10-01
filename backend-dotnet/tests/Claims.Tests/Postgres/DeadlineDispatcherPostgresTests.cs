using Claims.Common;
using Claims.Deadline;
using Claims.Intake;
using Claims.Tests.Support;
using Npgsql;

namespace Claims.Tests.Postgres;

/// <summary>
/// REQUIRES POSTGRES (TEST_PG_URL, or Docker for Testcontainers). The FOR UPDATE SKIP LOCKED behaviour cannot be faked: this runs the real
/// dispatcher SQL against a real server, with Temporal replaced by a recording launcher.
/// </summary>
public class DeadlineDispatcherPostgresTests(DeadlineDispatcherPostgresTests.Fixture fixture) : IClassFixture<DeadlineDispatcherPostgresTests.Fixture>, IAsyncLifetime
{
    public sealed class Fixture : PostgresApiFixture
    {
        protected override string Hint => "dispatcher";

        protected override IReadOnlyDictionary<string, string?> Settings { get; } = new Dictionary<string, string?> { ["Claims:Dispatcher:BatchSize"] = "5" };
    }

    private Common.Db Sql => fixture.Db;
    private DeadlineDispatcher Dispatcher => fixture.Get<DeadlineDispatcher>();
    private RecordingLauncher Launcher => fixture.Launcher;

    public async ValueTask InitializeAsync()
    {
        if (!PostgresSupport.Available) return;
        Launcher.Reset();
        // deadline_attempts is append-only (by trigger), so earlier tests' rows stay; close what they left live instead.
        await Sql.ExecuteAsync("""
            UPDATE deadlines SET state = 'skipped', closed_at = now(), closed_by = 'user', result = 'test cleanup'
            WHERE state IN ('open', 'dispatched')
            """);
    }

    public ValueTask DisposeAsync() => ValueTask.CompletedTask;

    /// <summary>One life intake writes 3 requirement follow-ups (plus 4 other rows the dispatcher has no workflow for).</summary>
    private async Task<List<Guid>> NewFollowUpsAsync(int claims)
    {
        var intake = fixture.Get<LifeIntakeService>();
        for (var i = 0; i < claims; i++)
            await intake.SubmitAsync(TestData.Castellano("natural", "WL-" + Guid.NewGuid().ToString()[..8], "Person " + i, true), "key-" + Guid.NewGuid(), Actor.User("test"));
        return await Sql.ListAsync<Guid>("SELECT id FROM deadlines WHERE kind = 'requirement_follow_up' AND state = 'open' ORDER BY id");
    }

    private async Task MakeDueAsync(IEnumerable<Guid> ids, DateTimeOffset due)
    {
        foreach (var id in ids) await Sql.ExecuteAsync("UPDATE deadlines SET due_at = @d, original_due_at = @d WHERE id = @id", new { d = due, id });
    }

    private Task<string> StateAsync(Guid id) => Sql.SingleAsync<string>("SELECT state FROM deadlines WHERE id = @id", new { id });

    private static string ArrayOf(IEnumerable<Guid> ids) => Common.Db.ArrayLiteral(ids.Select(i => i.ToString()));

    [PostgresFact]
    public async Task FiresOnlyDueRowsOfKindsThatHaveAWorkflowAndMarksThemDispatched()
    {
        var followUps = await NewFollowUpsAsync(1);
        Assert.Equal(3, followUps.Count);
        await MakeDueAsync(followUps.Take(2), DateTimeOffset.UtcNow.AddMinutes(-1));   // third is due in 10 days
        // A due row of a kind without a workflow in this slice must be left alone, not lost.
        await Sql.ExecuteAsync("UPDATE deadlines SET due_at = now() - interval '1 hour', original_due_at = now() - interval '1 hour' WHERE kind = 'first_contact_by' AND state = 'open'");

        var r = await Dispatcher.DispatchDueAsync();

        Assert.Equal(2, r.Claimed);
        Assert.Equal(2, r.Started);
        Assert.Equivalent(followUps.Take(2).ToList(), Launcher.StartedDeadlines.ToList(), strict: false);
        Assert.Equal("dispatched", await StateAsync(followUps[0]));
        Assert.Equal("open", await StateAsync(followUps[2]));
        Assert.Equal("open", await Sql.SingleAsync<string>("SELECT state FROM deadlines WHERE kind = 'first_contact_by' AND due_at < now() AND closed_at IS NULL"));
        // Attempt and outcome are recorded on the row and in the append-only attempts log.
        Assert.Equal($"1:started:deadline-{followUps[0]}",
            await Sql.SingleAsync<string>("SELECT attempt || ':' || last_outcome || ':' || workflow_id FROM deadlines WHERE id = @id", new { id = followUps[0] }));
        Assert.Equal(2, await Sql.SingleAsync<int>("SELECT count(*) FROM deadline_attempts WHERE outcome = 'started' AND deadline_id = ANY (cast(@ids as uuid[]))",
            new { ids = ArrayOf(followUps.Take(2)) }));
        // Polling again finds nothing: a dispatched row is never dispatched twice.
        Assert.Equal(0, (await Dispatcher.DispatchDueAsync()).Claimed);
        Assert.Equal(2, Launcher.StartedDeadlines.Count);
    }

    [PostgresFact]
    public async Task RowsLockedByAnotherTransactionAreSkippedNotWaitedOnAndPickedUpLater()
    {
        var rows = await NewFollowUpsAsync(2);   // 6 follow-ups
        await MakeDueAsync(rows, DateTimeOffset.UtcNow.AddMinutes(-1));
        var held = new HashSet<Guid>();

        await using (var other = await Sql.DataSource.OpenConnectionAsync())
        {
            await using var tx = await other.BeginTransactionAsync();
            await using (var cmd = new NpgsqlCommand("SELECT id FROM deadlines WHERE kind = 'requirement_follow_up' AND state = 'open' ORDER BY due_at, id LIMIT 2 FOR UPDATE", other, tx))
            await using (var reader = await cmd.ExecuteReaderAsync())
                while (await reader.ReadAsync()) held.Add(reader.GetGuid(0));
            Assert.Equal(2, held.Count);

            var watch = System.Diagnostics.Stopwatch.StartNew();
            var r = await Dispatcher.DispatchDueAsync();      // must not block on the two held rows
            watch.Stop();

            Assert.Equal(4, r.Claimed);
            Assert.Equal(4, Launcher.StartedDeadlines.Count);
            Assert.DoesNotContain(Launcher.StartedDeadlines, held.Contains);
            Assert.True(watch.ElapsedMilliseconds < 5_000, "SKIP LOCKED must not wait for the other transaction");
            await tx.RollbackAsync();
        }

        var later = await Dispatcher.DispatchDueAsync();
        Assert.Equal(2, later.Claimed);
        Assert.Equivalent(rows, Launcher.StartedDeadlines.ToList(), strict: false);
    }

    [PostgresFact]
    public async Task TwoDispatchersRunningTogetherStartEveryDeadlineExactlyOnce()
    {
        var rows = await NewFollowUpsAsync(10);   // 30 rows, batch size 5
        await MakeDueAsync(rows, DateTimeOffset.UtcNow.AddMinutes(-1));
        Launcher.StartDelayMillis = 10;           // widen the window in which they overlap

        var tasks = Enumerable.Range(0, 4).Select(_ => Task.Run(async () =>
        {
            var claimed = 0;
            for (int n; (n = (await Dispatcher.DispatchDueAsync()).Claimed) > 0;) claimed += n;
            return claimed;
        })).ToList();
        var total = (await Task.WhenAll(tasks)).Sum();

        Assert.Equal(30, total);
        Assert.Equal(30, Launcher.StartedDeadlines.Count);
        Assert.Equal(30, Launcher.StartedDeadlines.Distinct().Count());
        Assert.Equal(30, await Sql.SingleAsync<int>("SELECT count(*) FROM deadlines WHERE kind = 'requirement_follow_up' AND state = 'dispatched' AND attempt = 1"));
    }

    [PostgresFact]
    public async Task AFailedStartStaysOpenWithBackoffAndIsRetriedLater()
    {
        var rows = await NewFollowUpsAsync(1);
        await MakeDueAsync(rows, DateTimeOffset.UtcNow.AddMinutes(-1));
        var bad = rows[0];
        Launcher.FailFor[bad] = true;

        var first = await Dispatcher.DispatchDueAsync();

        Assert.Equal(1, first.Failed);
        Assert.Equal(2, first.Started);      // the others still went out
        Assert.Equal("open", await StateAsync(bad));
        Assert.Equal("1:start_failed:true",
            await Sql.SingleAsync<string>("SELECT attempt || ':' || last_outcome || ':' || (retry_after > now()) FROM deadlines WHERE id = @id", new { id = bad }));
        Assert.Contains("Temporal unavailable", await Sql.SingleAsync<string>("SELECT last_error FROM deadlines WHERE id = @id", new { id = bad }));
        Assert.Equal(0, (await Dispatcher.DispatchDueAsync()).Claimed);   // backing off: not polled again yet

        // Temporal comes back and the backoff passes.
        Launcher.FailFor.Clear();
        await Sql.ExecuteAsync("UPDATE deadlines SET retry_after = now() - interval '1 second' WHERE id = @id", new { id = bad });
        var second = await Dispatcher.DispatchDueAsync();

        Assert.Equal(1, second.Started);
        Assert.Equal("dispatched", await StateAsync(bad));
        Assert.Equal(2, await Sql.SingleAsync<int>("SELECT attempt FROM deadlines WHERE id = @id", new { id = bad }));
        Assert.Equal("start_failed,started",
            await Sql.SingleAsync<string>("SELECT string_agg(outcome, ',' ORDER BY attempt) FROM deadline_attempts WHERE deadline_id = @id", new { id = bad }));
    }

    [PostgresFact]
    public async Task AWorkflowThatWasAlreadyStartedCountsAsDispatchedSoRepeatsAreHarmless()
    {
        var rows = await NewFollowUpsAsync(1);
        await MakeDueAsync(rows.Take(1), DateTimeOffset.UtcNow.AddMinutes(-1));
        Launcher.AlreadyStarted[rows[0]] = true;      // e.g. the dispatcher crashed after starting it, before committing

        var r = await Dispatcher.DispatchDueAsync();

        Assert.Equal(1, r.AlreadyStarted);
        Assert.Equal(0, r.Started);
        Assert.Equal("dispatched", await StateAsync(rows[0]));
        Assert.Equal("already_started", await Sql.SingleAsync<string>("SELECT last_outcome FROM deadlines WHERE id = @id", new { id = rows[0] }));
    }

    [PostgresFact]
    public async Task ThePollUsesThePartialIndexOnOpenRows()
    {
        await NewFollowUpsAsync(1);
        await using var c = await Sql.DataSource.OpenConnectionAsync();
        await using (var set = new NpgsqlCommand("SET enable_seqscan = off", c)) await set.ExecuteNonQueryAsync();   // tiny table: make the planner show which index it would use
        var plan = new System.Text.StringBuilder();
        await using (var explain = new NpgsqlCommand("EXPLAIN SELECT id FROM deadlines WHERE state = 'open' AND due_at <= now() ORDER BY due_at, id LIMIT 25", c))
        await using (var reader = await explain.ExecuteReaderAsync())
            while (await reader.ReadAsync()) plan.Append(reader.GetString(0)).Append('\n');
        await using (var reset = new NpgsqlCommand("RESET enable_seqscan", c)) await reset.ExecuteNonQueryAsync();
        Assert.Contains("deadlines_dispatch_idx", plan.ToString());
    }
}
