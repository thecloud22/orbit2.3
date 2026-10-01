using System.Globalization;
using Claims.Clock;
using Claims.Common;
using Claims.Config;
using Claims.Gateway;
using Claims.View;

namespace Claims.Web;

/// <summary>
/// Development controls, mapped ONLY when Claims:Dev:Controls is true (Program.cs). In every other configuration these routes do not exist (404).
/// The virtual clock moves business time forward so a demo can play weeks of a claim in minutes. It never edits a deadline row: rows keep their
/// due_at, and the dispatcher simply finds them due once the clock passes them.
/// </summary>
public static class DevEndpoints
{
    public sealed record AdvanceBody(double? Days, string? Until, DateTimeOffset? ToIso);

    public sealed record FaultBody(string? Name, bool? Enabled, int? Count);

    public sealed record BankReturnBody(Guid? PaymentItemId, string? ReasonCode, string? ReasonText);

    public static void MapDev(this IEndpointRouteBuilder app)
    {
        app.MapGet("/dev/clock", (IClock clock, BusinessCalendar calendar) => Results.Json(State(clock, calendar), Json.Options));

        app.MapPost("/dev/clock:advance", async (HttpRequest request, IClock clock, BusinessCalendar calendar, Db db) =>
        {
            var body = await Http.RequiredBodyAsync<AdvanceBody>(request);
            var given = (body.Days is not null ? 1 : 0) + (body.Until is not null ? 1 : 0) + (body.ToIso is not null ? 1 : 0);
            if (given != 1) throw ApiException.Unprocessable("clock_advance_invalid", "Give exactly one of days, until (next_deadline) or toIso");
            if (body.Days is { } days)
            {
                if (days <= 0 || days > 3650) throw ApiException.Unprocessable("clock_cannot_go_backwards", "days must be greater than 0 (time only moves forward) and at most 3650");
                clock.Advance(TimeSpan.FromDays(days));
            }
            else if (body.ToIso is { } to)
            {
                if (to <= clock.UtcNow) throw ApiException.Unprocessable("clock_cannot_go_backwards", $"toIso must be after the current business time ({InstantConverter.Format(clock.UtcNow)})");
                clock.AdvanceTo(to);
            }
            else
            {
                if (body.Until != "next_deadline") throw ApiException.Unprocessable("clock_advance_invalid", "until must be next_deadline");
                var next = (await db.QueryAsync("SELECT min(due_at) AS next FROM deadlines WHERE state = 'open' AND due_at > @now", new { now = clock.UtcNow },
                    r => r.InstantOrNull("next")))[0];
                if (next is null) throw ApiException.Unprocessable("no_next_deadline", "No open deadline is due after the current business time");
                clock.AdvanceTo(next.Value);
            }
            var due = await db.QueryAsync("SELECT id, claim_id, kind, what, due_at FROM deadlines WHERE state = 'open' AND due_at <= @now ORDER BY due_at, id",
                new { now = clock.UtcNow }, r => new DueDeadlineView(r.Guid("id"), r.Guid("claim_id"), r.Text("kind"), r.Text("what"), r.Instant("due_at")));
            var s = State(clock, calendar);
            return Results.Json(new DevClockAdvancedView(s.Now, s.RealNow, s.OffsetSeconds, s.Virtual, s.BusinessDate, s.Zone, due), Json.Options);
        });

        // ---- fault switches: make a stub outside system, or the worker, misbehave on purpose
        app.MapGet("/dev/faults", (IFaultRegistry faults) => Results.Json(FaultsView(faults), Json.Options));

        app.MapPost("/dev/faults", async (HttpRequest request, IFaultRegistry faults) =>
        {
            var body = await Http.RequiredBodyAsync<FaultBody>(request);
            if (string.IsNullOrWhiteSpace(body.Name)) throw new ApiException(422, "validation_failed", "The request is well formed but not valid", [new FieldError("name", "must not be blank")]);
            var name = body.Name.Trim();
            if (!FaultCatalog.IsKnown(name)) throw ApiException.Unprocessable("unknown_fault", $"'{name}' is not a fault this API knows; see GET /dev/faults for the names");
            if ((body.Enabled is null) == (body.Count is null)) throw ApiException.Unprocessable("fault_invalid", "Give exactly one of enabled (true or false) or count (1 or more)");
            if (body.Count is { } count)
            {
                if (count < 1) throw ApiException.Unprocessable("fault_invalid", "count must be at least 1");
                faults.Set(name, count);
            }
            else faults.Set(name, body.Enabled!.Value);
            return Results.Json(FaultsView(faults), Json.Options);
        });

        // ---- the stub bank's returns queue: what its returns file holds. The returns batch reads it.
        app.MapGet("/dev/bank/returns", (StubBankGateway bank) =>
            Results.Json(new { items = bank.Queue.Select(r => new BankReturnView(r.ItemId, r.ReasonCode, r.ReasonText, r.QueuedAt)) }, Json.Options));

        app.MapPost("/dev/bank/returns", async (HttpRequest request, StubBankGateway bank, Db db, IClock clock) =>
        {
            var body = await Http.RequiredBodyAsync<BankReturnBody>(request);
            var errors = new List<FieldError>();
            if (body.PaymentItemId is null) errors.Add(new FieldError("paymentItemId", "must not be null"));
            if (string.IsNullOrWhiteSpace(body.ReasonCode)) errors.Add(new FieldError("reasonCode", "must not be blank"));
            else if (!System.Text.RegularExpressions.Regex.IsMatch(body.ReasonCode, "^R[0-9]{2}$", System.Text.RegularExpressions.RegexOptions.NonBacktracking))
                errors.Add(new FieldError("reasonCode", "must be an ACH return code such as R02"));
            if (errors.Count > 0) throw new ApiException(422, "validation_failed", "The request is well formed but not valid", errors);
            var status = await db.SingleOrDefaultAsync<string>("SELECT status FROM payment_items WHERE id = @id", new { id = body.PaymentItemId })
                ?? throw ApiException.NotFound("Payment item", body.PaymentItemId!);
            if (status != "paid") throw ApiException.Unprocessable("item_not_paid", $"A bank can only return a payment it took: this item is {status}");
            var r = bank.EnqueueReturn(body.PaymentItemId!.Value, body.ReasonCode!, body.ReasonText?.Trim(), clock.UtcNow);
            return Results.Json(new BankReturnView(r.ItemId, r.ReasonCode, r.ReasonText, r.QueuedAt), Json.Options, statusCode: 201);
        });

        app.MapPost("/dev/clock:reset", (IClock clock, BusinessCalendar calendar) =>
        {
            clock.Reset();
            return Results.Json(State(clock, calendar), Json.Options);
        });
    }

    private static DevFaultsView FaultsView(IFaultRegistry faults) => new(
        [.. faults.State.Select(s => new FaultStateView(s.Name, s.Count, s.Since))],
        [.. FaultCatalog.All.Select(f => new FaultAvailableView(f.Name, f.Description))],
        [.. faults.Log.Select(e => new FaultEventView(e.At, e.Name, e.Detail))]);

    private static DevClockView State(IClock clock, BusinessCalendar calendar) =>
        new(clock.UtcNow, clock.RealNow, clock.Offset.TotalSeconds, clock.IsVirtual, calendar.LocalDate(clock.UtcNow), calendar.Zone.Id);
}
