using Claims.Common;
using Claims.Decision;
using Claims.Store;
using Claims.View;

namespace Claims.Web;

public static class DecisionsEndpoints
{
    public sealed record ApproveBody(string? Note);

    public static void MapDecisions(this IEndpointRouteBuilder app)
    {
        app.MapGet("/claims/{claimId:guid}/decisions", async (Guid claimId, HttpRequest request, Db db, ClaimQueries queries) =>
        {
            var exists = await db.SingleAsync<bool>("SELECT EXISTS (SELECT 1 FROM claims WHERE id = @id)", new { id = claimId });
            if (!exists) throw ApiException.NotFound("Claim", claimId);
            return Results.Json(DecisionList.Of(await queries.DecisionsAsync(claimId, Http.QueryInstant(request, "asOf"))), Json.Options);
        });

        // 201: recorded and in force. 202: above the recorder's authority, awaiting a team lead. 200: the same Idempotency-Key and body again.
        app.MapPost("/claims/{claimId:guid}/decisions", async (Guid claimId, HttpRequest request, DecisionService service) =>
        {
            var key = Http.RequireHeader(request, "Idempotency-Key");
            var actor = Http.RequireHeader(request, "X-Actor");
            var body = await Http.RequiredBodyAsync<RecordDecisionRequest>(request);
            var outcome = await service.RecordAsync(claimId, body, key, actor);
            var result = outcome.Result;
            var response = request.HttpContext.Response;
            response.Headers.Location = "/decisions/" + result.Decision.Id;
            if (outcome.Replayed)
            {
                response.Headers["Idempotent-Replayed"] = "true";
                return Results.Json(result, Json.Options, statusCode: 200);
            }
            return Results.Json(result, Json.Options, statusCode: result.Kind == "awaiting_approval" ? 202 : 201);
        });

        app.MapGet("/decisions/{decisionId:guid}", async (Guid decisionId, ClaimQueries queries) =>
            Results.Json(await queries.DecisionAsync(decisionId) ?? throw ApiException.NotFound("Decision", decisionId), Json.Options));

        app.MapPost("/decisions/{decisionId:guid}:approve", async (Guid decisionId, HttpRequest request, DecisionService service) =>
        {
            var actor = Http.RequireHeader(request, "X-Actor");
            var body = await Http.BodyAsync<ApproveBody>(request);
            return Results.Json(await service.ApproveAsync(decisionId, actor, body?.Note), Json.Options);
        });
    }
}
