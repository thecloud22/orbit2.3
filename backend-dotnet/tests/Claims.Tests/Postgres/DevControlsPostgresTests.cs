using System.Globalization;
using Claims.Common;
using Claims.Gateway;
using Claims.Tests.Support;
using Microsoft.Extensions.DependencyInjection;

namespace Claims.Tests.Postgres;

/// <summary>
/// REQUIRES POSTGRES. The Development controls that drive the complex scenario without a script: the fault switches (`POST /dev/faults`) and the stub bank's returns queue
/// (`POST /dev/bank/returns`). They exist only when Claims:Dev:Controls is on, and a fault switched through them is really read by the stubs.
/// </summary>
public class DevControlsPostgresTests(DevControlsPostgresTests.Fixture fixture) : IClassFixture<DevControlsPostgresTests.Fixture>, IAsyncLifetime
{
    public sealed class Fixture : PostgresApiFixture
    {
        protected override string Hint => "devcontrols";

        protected override DateTimeOffset? ClockStart => DateTimeOffset.Parse("2026-10-12T16:30:00Z", CultureInfo.InvariantCulture);

        protected override IReadOnlyDictionary<string, string?> Settings { get; } = new Dictionary<string, string?> { ["Claims:Dev:Controls"] = "true", ["Claims:Db:DevSeed"] = "true" };
    }

    private HttpClient Client => fixture.CreateClient();
    private IFaultRegistry Faults => fixture.Get<IFaultRegistry>();

    public ValueTask InitializeAsync()
    {
        if (!PostgresSupport.Available) return ValueTask.CompletedTask;
        foreach (var f in Faults.Active) Faults.Set(f, false);
        return ValueTask.CompletedTask;
    }

    public ValueTask DisposeAsync() => ValueTask.CompletedTask;

    private static string Fault(string name, string what) => $"{{\"name\":\"{name}\",{what}}}";

    [PostgresFact]
    public async Task FaultsAreSwitchedOnCountedAndOffThroughTheEndpointAndUnknownOnesAreRefused()
    {
        var client = Client;
        var start = await client.GetApiAsync("/dev/faults");
        Assert.Equal(200, start.StatusCode);
        Assert.Empty(start.Json["active"]!.AsArray());
        var available = start.Json["available"]!.AsArray().Select(a => a!["name"]!.ToString()).ToList();
        Assert.Contains("letters.down", available);
        Assert.Contains("tin.no-match", available);
        Assert.Contains("worker.stall-once:<activity type>", available);

        var on = await client.PostApiAsync("/dev/faults", Fault("letters.down", "\"enabled\":true"));
        Assert.Equal(200, on.StatusCode);
        Assert.Equal(("letters.down", null), (on.Str("active[0].name"), on.At("active[0].count")?.ToString()));
        Assert.True(Faults.IsOn("letters.down"));

        var counted = await client.PostApiAsync("/dev/faults", Fault("worker.stall-once:LifeIntake_SendAcknowledgementAndPackets", "\"count\":1"));
        Assert.Equal(2, counted.Json["active"]!.AsArray().Count);
        Assert.Contains(counted.Json["log"]!.AsArray(), e => e!["name"]!.ToString().StartsWith("worker.stall-once:", StringComparison.Ordinal));

        var off = await client.PostApiAsync("/dev/faults", Fault("letters.down", "\"enabled\":false"));
        Assert.Equal(["worker.stall-once:LifeIntake_SendAcknowledgementAndPackets"], off.Json["active"]!.AsArray().Select(a => a!["name"]!.ToString()));

        Assert.Equal((422, "unknown_fault"), Pair(await client.PostApiAsync("/dev/faults", Fault("letters.dwon", "\"enabled\":true"))));
        Assert.Equal((422, "fault_invalid"), Pair(await client.PostApiAsync("/dev/faults", Fault("letters.down", "\"enabled\":true,\"count\":2"))));
        Assert.Equal((422, "fault_invalid"), Pair(await client.PostApiAsync("/dev/faults", "{\"name\":\"letters.down\"}")));
        Assert.Equal((422, "fault_invalid"), Pair(await client.PostApiAsync("/dev/faults", Fault("letters.down", "\"count\":0"))));
        Assert.Equal(422, (await client.PostApiAsync("/dev/faults", "{\"enabled\":true}")).StatusCode);
    }

    private static (int, string?) Pair(ApiResponse r) => (r.StatusCode, r.Str("code"));

    [PostgresFact]
    public async Task ASwitchedFaultIsReallyReadByTheStubsAndACountedOneRunsOut()
    {
        var client = Client;
        var letters = fixture.Get<INotificationGateway>();
        var msg = new NotificationMessage("key-1", "email", "diane@example.com", "REQ-LIFE-03", "Certified copy needed");
        Assert.StartsWith("stub-msg-", await letters.SendAsync(msg), StringComparison.Ordinal);

        await client.PostApiAsync("/dev/faults", Fault("letters.down", "\"count\":3"));
        for (var i = 0; i < 3; i++) await Assert.ThrowsAsync<InvalidOperationException>(() => letters.SendAsync(msg));   // each attempt is a use
        Assert.StartsWith("stub-msg-", await letters.SendAsync(msg), StringComparison.Ordinal);   // the fourth goes: the service is "back"

        var tin = fixture.Get<ITinMatchGateway>();
        Assert.True((await tin.CheckAsync("Diane Castellano", "123-45-6789")).Match);
        Assert.False((await tin.CheckAsync("Diane Castellano", "123-45")).Match);   // not nine digits
        await client.PostApiAsync("/dev/faults", Fault("tin.no-match", "\"count\":1"));
        var answer = await tin.CheckAsync("Diane Castellano", "123-45-6789");
        Assert.False(answer.Match);   // an answer, not an exception
        Assert.True((await tin.CheckAsync("Diane Castellano", "123-45-6789")).Match);
        await client.PostApiAsync("/dev/faults", Fault("tin.down", "\"count\":1"));
        await Assert.ThrowsAsync<InvalidOperationException>(() => tin.CheckAsync("Diane Castellano", "123-45-6789"));   // a failure: Temporal would retry it
        Assert.True((await tin.CheckAsync("Diane Castellano", "123-45-6789")).Match);
        var log = (await client.GetApiAsync("/dev/faults")).Json["log"]!.AsArray().Select(e => e!["name"]!.ToString()).ToList();
        Assert.Contains("letters.down", log);
        Assert.Contains("tin.no-match", log);
    }

    [PostgresFact]
    public async Task TheStubBanksReturnsQueueTakesOnlyPaidItemsAndIsReadBackInOrder()
    {
        var client = Client;
        fixture.Clock.Set(DateTimeOffset.Parse("2026-10-12T16:30:00Z", CultureInfo.InvariantCulture));
        var (claim, _) = await LifeScenario.ApprovedAsync(fixture);
        var items = await fixture.Db.ListAsync<Guid>("SELECT id FROM payment_items WHERE claim_id = @c ORDER BY id", new { c = claim.ClaimId });
        // Cleared, not paid: a bank can only return a payment it took.
        Assert.Equal((422, "item_not_paid"), Pair(await client.PostApiAsync("/dev/bank/returns", $"{{\"paymentItemId\":\"{items[0]}\",\"reasonCode\":\"R02\",\"reasonText\":\"Account closed\"}}")));
        Assert.Equal(404, (await client.PostApiAsync("/dev/bank/returns", $"{{\"paymentItemId\":\"{Guid.NewGuid()}\",\"reasonCode\":\"R02\"}}")).StatusCode);
        Assert.Equal(422, (await client.PostApiAsync("/dev/bank/returns", $"{{\"paymentItemId\":\"{items[0]}\",\"reasonCode\":\"oops\"}}")).StatusCode);
        Assert.Equal(422, (await client.PostApiAsync("/dev/bank/returns", "{\"reasonCode\":\"R02\"}")).StatusCode);

        fixture.Clock.Set(DateTimeOffset.Parse("2026-10-13T07:00:00Z", CultureInfo.InvariantCulture));
        await fixture.Get<Claims.Payment.PaymentRunService>().RunManualAsync(new DateOnly(2026, 10, 13), "run-" + Guid.NewGuid(), "ops");
        var q = await client.PostApiAsync("/dev/bank/returns", $"{{\"paymentItemId\":\"{items[1]}\",\"reasonCode\":\"R02\",\"reasonText\":\"Account closed\"}}");
        Assert.Equal(201, q.StatusCode);
        Assert.Equal(("R02", "Account closed"), (q.Str("reasonCode"), q.Str("reasonText")));
        var queue = await client.GetApiAsync("/dev/bank/returns");
        Assert.Equal([items[1].ToString()], queue.Json["items"]!.AsArray().Select(i => i!["paymentItemId"]!.ToString()));
        // Enqueueing changes nothing else: the item is still paid until the returns batch reads the queue.
        Assert.Equal("paid", await fixture.Db.SingleAsync<string>("SELECT status FROM payment_items WHERE id = @i", new { i = items[1] }));
        await fixture.Get<StubBankGateway>().AcknowledgeReturnsAsync(fixture.Get<StubBankGateway>().Queue.Select(r => r.ReturnId));
    }
}
