using System.Diagnostics;
using System.Globalization;
using Claims.Common;
using Claims.Gateway;
using Claims.Store;
using Claims.Tests.Support;

namespace Claims.Tests.Postgres;

/// <summary>
/// REQUIRES POSTGRES. The two daily jobs that are hosted services (not Temporal): the nightly overdue check and the bank-returns batch run by themselves once their local time has passed, and doing it again
/// changes nothing. Their intervals are short here; the business clock is set by hand.
/// </summary>
public class OverdueCheckPollerPostgresTests(OverdueCheckPollerPostgresTests.Fixture fixture) : IClassFixture<OverdueCheckPollerPostgresTests.Fixture>
{
    public sealed class Fixture : PostgresApiFixture
    {
        protected override string Hint => "overduepoller";

        protected override DateTimeOffset? ClockStart => DateTimeOffset.Parse("2026-09-25T15:03:00Z", CultureInfo.InvariantCulture);

        protected override IReadOnlyDictionary<string, string?> Settings { get; } = new Dictionary<string, string?>
        {
            ["Claims:Db:DevSeed"] = "true",
            ["Claims:OverdueCheck:ScheduleEnabled"] = "true",
            ["Claims:OverdueCheck:PollInterval"] = "00:00:00.200",
            ["Claims:OverdueCheck:RunTime"] = "02:30:00",
        };
    }

    [PostgresFact]
    public async Task TheHostedServiceRunsTheCheckOncePerBusinessDateFromItsRunTime()
    {
        var claim = await LifeScenario.GatheringAsync(fixture);
        var sql = fixture.Db;
        // First contact was due Mon 28 Sep 08:00. At 01:00 Central on Tue 29 Sep the run time (02:30) has not come, so the job does nothing yet.
        fixture.Clock.Set(DateTimeOffset.Parse("2026-09-29T06:00:00Z", CultureInfo.InvariantCulture));   // Tue 29 Sep 01:00 Central
        await Task.Delay(1200);
        Assert.Equal(0, await sql.SingleAsync<int>("SELECT count(*) FROM work_items WHERE claim_id = @c AND dedupe_key LIKE 'overdue:%'", new { c = claim.ClaimId }));

        fixture.Clock.Set(DateTimeOffset.Parse("2026-09-29T08:00:00Z", CultureInfo.InvariantCulture));   // 03:00 Central: the run time has passed
        var wait = Stopwatch.StartNew();
        while (await sql.SingleAsync<int>("SELECT count(*) FROM work_items WHERE claim_id = @c AND dedupe_key LIKE 'overdue:%'", new { c = claim.ClaimId }) == 0 && wait.Elapsed < TimeSpan.FromSeconds(15))
            await Task.Delay(200);
        Assert.Equal(1, await sql.SingleAsync<int>("SELECT count(*) FROM work_items WHERE claim_id = @c AND dedupe_key LIKE 'overdue:%'", new { c = claim.ClaimId }));   // the first-contact row, once
        await Task.Delay(1200);   // the service keeps polling; the same date is not checked again, and if it were nothing would be added
        Assert.Equal(1, await sql.SingleAsync<int>("SELECT count(*) FROM history_events WHERE claim_id = @c AND title LIKE 'Deadline overdue:%'", new { c = claim.ClaimId }));
    }
}

public class ReturnsPollerPostgresTests(ReturnsPollerPostgresTests.Fixture fixture) : IClassFixture<ReturnsPollerPostgresTests.Fixture>
{
    public sealed class Fixture : PostgresApiFixture
    {
        protected override string Hint => "returnspoller";

        protected override DateTimeOffset? ClockStart => DateTimeOffset.Parse("2026-10-12T16:30:00Z", CultureInfo.InvariantCulture);

        protected override IReadOnlyDictionary<string, string?> Settings { get; } = new Dictionary<string, string?>
        {
            ["Claims:Db:DevSeed"] = "true",
            ["Claims:PaymentRun:ScheduleEnabled"] = "true",   // the in-process daily trigger: the payment run and the returns batch
            ["Claims:PaymentRun:PollInterval"] = "00:00:00.200",
            ["Claims:PaymentRun:ReturnsRunTime"] = "06:30:00",
        };
    }

    [PostgresFact]
    public async Task TheDailyJobReadsTheBanksReturnsFileFromItsRunTimeAndMarksThePaidItemReturned()
    {
        var sql = fixture.Db;
        var (claim, _) = await LifeScenario.ApprovedAsync(fixture);   // decided Mon 12 Oct 11:30: pays Tue 13 Oct
        fixture.Clock.Set(DateTimeOffset.Parse("2026-10-13T07:00:00Z", CultureInfo.InvariantCulture));   // 02:00 Central: the daily payment run (the same trigger) pays
        var wait = Stopwatch.StartNew();
        while (await sql.SingleAsync<string>("SELECT status FROM claims WHERE id = @c", new { c = claim.ClaimId }) != "closed" && wait.Elapsed < TimeSpan.FromSeconds(15)) await Task.Delay(200);
        Assert.Equal("closed", await sql.SingleAsync<string>("SELECT status FROM claims WHERE id = @c", new { c = claim.ClaimId }));
        var mark = await sql.SingleAsync<Guid>("SELECT pi.id FROM payment_items pi JOIN parties p ON p.id = pi.payee_party_id WHERE pi.claim_id = @c AND p.full_name LIKE 'Mark%'", new { c = claim.ClaimId });

        fixture.Clock.Set(DateTimeOffset.Parse("2026-10-15T10:00:00Z", CultureInfo.InvariantCulture));   // Thu 15 Oct 05:00 Central: before the returns job's time
        fixture.Get<StubBankGateway>().EnqueueReturn(mark, "R02", "Account closed", fixture.Clock.UtcNow);
        await Task.Delay(1500);
        Assert.Equal("paid", await sql.SingleAsync<string>("SELECT status FROM payment_items WHERE id = @i", new { i = mark }));   // not yet

        fixture.Clock.Set(DateTimeOffset.Parse("2026-10-15T12:00:00Z", CultureInfo.InvariantCulture));   // 07:00 Central: the job's time has passed
        wait.Restart();
        while (await sql.SingleAsync<string>("SELECT status FROM payment_items WHERE id = @i", new { i = mark }) != "returned" && wait.Elapsed < TimeSpan.FromSeconds(15)) await Task.Delay(200);
        Assert.Equal("returned", await sql.SingleAsync<string>("SELECT status FROM payment_items WHERE id = @i", new { i = mark }));
        Assert.Equal(1, await sql.SingleAsync<int>("SELECT count(*) FROM outbox_events WHERE claim_id = @c AND event_type = 'payment_returned'", new { c = claim.ClaimId }));
        Assert.Equal("closed", await sql.SingleAsync<string>("SELECT status FROM claims WHERE id = @c", new { c = claim.ClaimId }));   // a batch never changes the claim
    }
}
