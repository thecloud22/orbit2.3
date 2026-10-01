using Claims.Common;
using Claims.Intake;
using Claims.Store;

namespace Claims.Web;

public static class ClaimsEndpoints
{
    public static void MapClaims(this IEndpointRouteBuilder app)
    {
        // Commits the claim, requirements and first deadline rows in one transaction and returns; the intake workflow runs afterwards.
        // 201 with the claim (status received); 200 with the same claim when the Idempotency-Key repeats.
        app.MapPost("/claims/life-intake", async (HttpRequest request, LifeIntakeService intake) =>
        {
            var key = Http.RequireHeader(request, "Idempotency-Key");
            var actor = Http.HeaderOr(request, "X-Actor", "intake.dev");
            var body = await Http.RequiredBodyAsync<LifeIntakeRequest>(request);
            var errors = LifeIntakeValidator.Validate(body);
            if (errors.Count > 0) throw new ApiException(422, "validation_failed", "The request is well formed but not valid", errors);
            if (key.Length is < 8 or > 128) throw ApiException.BadRequest("invalid_idempotency_key", "Idempotency-Key must be 8 to 128 characters");

            var result = await intake.SubmitAsync(body, key, Actor.User(actor));
            var claim = result.Claim;
            request.HttpContext.Response.Headers.ETag = IfMatch.ETag(claim.Version);
            if (result.Replayed)
            {
                request.HttpContext.Response.Headers["Idempotent-Replayed"] = "true";
                return Results.Json(claim, Json.Options, statusCode: 200);
            }
            request.HttpContext.Response.Headers.Location = "/claims/" + claim.Id;
            return Results.Json(claim, Json.Options, statusCode: 201);
        });

        app.MapGet("/claims/{claimId:guid}", async (Guid claimId, HttpResponse response, ClaimQueries queries) =>
        {
            var c = await queries.ClaimAsync(claimId) ?? throw ApiException.NotFound("Claim", claimId);
            return Http.Ok(response, c, c.Version);
        });

        app.MapGet("/claims", async (HttpRequest request, ClaimQueries queries) =>
        {
            var page = await queries.ClaimsAsync(Http.QueryGuid(request, "owner"), Http.Query(request, "status"), Http.Query(request, "family"),
                Http.Query(request, "claimNumber"), Http.QueryInt(request, "limit", 25, 1, 100), Http.Query(request, "cursor"));
            return Results.Json(page, Json.Options);
        });
    }
}
