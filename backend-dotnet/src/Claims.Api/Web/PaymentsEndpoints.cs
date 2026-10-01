using Claims.Common;
using Claims.Payment;
using Claims.Store;
using Claims.View;

namespace Claims.Web;

public static class PaymentsEndpoints
{
    public sealed record HoldBody(string? Reason);

    public sealed record RunBody(DateOnly? RunDate);

    public static void MapPayments(this IEndpointRouteBuilder app)
    {
        app.MapGet("/claims/{claimId:guid}/payment-items", async (Guid claimId, Db db, ClaimQueries queries) =>
        {
            var exists = await db.SingleAsync<bool>("SELECT EXISTS (SELECT 1 FROM claims WHERE id = @id)", new { id = claimId });
            if (!exists) throw ApiException.NotFound("Claim", claimId);
            return Results.Json(Page<PaymentItemView>.Of(await queries.PaymentItemsAsync(claimId)), Json.Options);
        });

        app.MapPost("/payment-items/{paymentItemId:guid}:hold", async (Guid paymentItemId, HttpRequest request, PaymentItemService service) =>
        {
            var ifMatch = Http.RequireHeader(request, "If-Match");
            var actor = Http.HeaderOr(request, "X-Actor", "examiner.dev");
            var body = await Http.RequiredBodyAsync<HoldBody>(request);
            var item = await service.HoldAsync(paymentItemId, IfMatch.Parse(ifMatch), body.Reason, Actor.User(actor));
            return Http.Ok(request.HttpContext.Response, item, item.Version);
        });

        app.MapPost("/payment-items/{paymentItemId:guid}:release", async (Guid paymentItemId, HttpRequest request, PaymentItemService service) =>
        {
            var ifMatch = Http.RequireHeader(request, "If-Match");
            var actor = Http.HeaderOr(request, "X-Actor", "examiner.dev");
            var item = await service.ReleaseAsync(paymentItemId, IfMatch.Parse(ifMatch), Actor.User(actor));
            return Http.Ok(request.HttpContext.Response, item, item.Version);
        });

        app.MapGet("/payment-runs", async (HttpRequest request, ClaimQueries queries) =>
            Results.Json(Page<PaymentRunView>.Of(await queries.PaymentRunsAsync(Http.QueryInt(request, "limit", 25, 1, 100))), Json.Options));

        app.MapGet("/payment-runs/{paymentRunId:guid}", async (Guid paymentRunId, ClaimQueries queries) =>
            Results.Json(await queries.PaymentRunAsync(paymentRunId) ?? throw ApiException.NotFound("Payment run", paymentRunId), Json.Options));

        // The returns batch: what the bank sent back. Also run by the daily job (PaymentReturnsPoller). Must be mapped before /payment-runs/{id} is ever asked for "returns:process".
        app.MapPost("/payment-runs/returns:process", async (HttpRequest request, PaymentReturnsService service) =>
        {
            var actor = Http.HeaderOr(request, "X-Actor", "operations.dev");
            return Results.Json(await service.ProcessAsync(actor), Json.Options);
        });

        app.MapGet("/claims/{claimId:guid}/payment-methods", async (Guid claimId, Db db, ClaimQueries queries) =>
        {
            var exists = await db.SingleAsync<bool>("SELECT EXISTS (SELECT 1 FROM claims WHERE id = @id)", new { id = claimId });
            if (!exists) throw ApiException.NotFound("Claim", claimId);
            return Results.Json(new PaymentMethodsView(await queries.PaymentMethodsAsync(claimId), await queries.PaymentMethodHoldsAsync(claimId), null), Json.Options);
        });

        app.MapPost("/claims/{claimId:guid}/payees/{partyId:guid}:update-payment-method", async (Guid claimId, Guid partyId, HttpRequest request, PaymentMethodService service) =>
        {
            var key = Http.RequireHeader(request, "Idempotency-Key");
            var actor = Http.HeaderOr(request, "X-Actor", "portal.dev");
            var body = await Http.RequiredBodyAsync<UpdatePaymentMethodRequest>(request);
            var outcome = await service.UpdateAsync(claimId, partyId, body, key, actor);
            var response = request.HttpContext.Response;
            if (outcome.Replayed)
            {
                response.Headers["Idempotent-Replayed"] = "true";
                return Results.Json(outcome.Result, Json.Options, statusCode: 200);
            }
            return Results.Json(outcome.Result, Json.Options, statusCode: 201);
        });

        // The manual trigger. The run is built and finished inside the request (the bank is a stub; a real bank file would make this 202).
        app.MapPost("/payment-runs", async (HttpRequest request, PaymentRunService service) =>
        {
            var key = request.Headers["Idempotency-Key"].ToString();
            var actor = Http.HeaderOr(request, "X-Actor", "operations.dev");
            var body = await Http.RequiredBodyAsync<RunBody>(request);
            if (body.RunDate is null) throw new ApiException(422, "validation_failed", "The request is well formed but not valid", [new FieldError("runDate", "must not be null")]);
            var outcome = await service.RunManualAsync(body.RunDate.Value, string.IsNullOrEmpty(key) ? null : key, actor);
            var response = request.HttpContext.Response;
            response.Headers.Location = "/payment-runs/" + outcome.Run.Id;
            if (outcome.Replayed)
            {
                response.Headers["Idempotent-Replayed"] = "true";
                return Results.Json(outcome.Run, Json.Options, statusCode: 200);
            }
            return Results.Json(outcome.Run, Json.Options, statusCode: 201);
        });
    }
}
