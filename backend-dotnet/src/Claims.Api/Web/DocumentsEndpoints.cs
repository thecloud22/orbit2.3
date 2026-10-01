using Claims.Common;
using Claims.Documents;
using Claims.Store;
using Claims.View;

namespace Claims.Web;

public static class DocumentsEndpoints
{
    public sealed record ReviewBody(string? Decision, string? Reason);

    public static void MapDocuments(this IEndpointRouteBuilder app)
    {
        app.MapGet("/claims/{claimId:guid}/documents", async (Guid claimId, Db db, ClaimQueries queries) =>
        {
            var exists = await db.SingleAsync<bool>("SELECT EXISTS (SELECT 1 FROM claims WHERE id = @id)", new { id = claimId });
            if (!exists) throw ApiException.NotFound("Claim", claimId);
            return Results.Json(Page<DocumentView>.Of(await queries.DocumentsAsync(claimId)), Json.Options);
        });

        app.MapPost("/claims/{claimId:guid}/documents", async (Guid claimId, HttpRequest request, DocumentService service) =>
        {
            var key = Http.RequireHeader(request, "Idempotency-Key");
            var actor = Http.HeaderOr(request, "X-Actor", "portal.dev");
            var body = await Http.RequiredBodyAsync<ReceiveDocumentRequest>(request);
            var outcome = await service.ReceiveAsync(claimId, body, key, actor);
            var response = request.HttpContext.Response;
            response.Headers.Location = "/documents/" + outcome.Document.Id;
            if (outcome.Replayed)
            {
                response.Headers["Idempotent-Replayed"] = "true";
                response.Headers.ETag = IfMatch.ETag(outcome.Document.Version);
                return Results.Json(outcome.Document, Json.Options, statusCode: 200);
            }
            response.Headers.ETag = IfMatch.ETag(outcome.Document.Version);
            return Results.Json(outcome.Document, Json.Options, statusCode: 201);
        });

        app.MapGet("/documents/{documentId:guid}", async (Guid documentId, HttpResponse response, ClaimQueries queries) =>
        {
            var d = await queries.DocumentAsync(documentId) ?? throw ApiException.NotFound("Document", documentId);
            return Http.Ok(response, d, d.Version);
        });

        app.MapPost("/documents/{documentId:guid}:review", async (Guid documentId, HttpRequest request, DocumentService service) =>
        {
            var ifMatch = Http.RequireHeader(request, "If-Match");
            var actor = Http.RequireHeader(request, "X-Actor");
            var body = await Http.RequiredBodyAsync<ReviewBody>(request);
            var d = await service.ReviewAsync(documentId, IfMatch.Parse(ifMatch), body.Decision, body.Reason, actor);
            return Http.Ok(request.HttpContext.Response, d, d.Version);
        });
    }
}
