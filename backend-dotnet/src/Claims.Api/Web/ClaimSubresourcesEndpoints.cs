using Claims.Common;
using Claims.Store;
using Claims.View;

namespace Claims.Web;

/// <summary>Read-only collections that hang off a claim. The claim must exist (404 otherwise, not an empty list).</summary>
public static class ClaimSubresourcesEndpoints
{
    public static void MapClaimSubresources(this IEndpointRouteBuilder app)
    {
        app.MapGet("/claims/{claimId:guid}/requirements", async (Guid claimId, Db db, ClaimQueries queries) =>
        {
            await RequireClaimAsync(db, claimId);
            return Results.Json(Page<RequirementView>.Of(await queries.RequirementsAsync(claimId)), Json.Options);
        });

        app.MapGet("/claims/{claimId:guid}/deadlines", async (Guid claimId, Db db, ClaimQueries queries) =>
        {
            await RequireClaimAsync(db, claimId);
            return Results.Json(Page<DeadlineView>.Of(await queries.DeadlinesAsync(claimId)), Json.Options);
        });

        app.MapGet("/claims/{claimId:guid}/letters", async (Guid claimId, Db db, ClaimQueries queries) =>
        {
            await RequireClaimAsync(db, claimId);
            return Results.Json(Page<LetterView>.Of(await queries.LettersAsync(claimId)), Json.Options);
        });

        app.MapGet("/claims/{claimId:guid}/workflow-runs", async (Guid claimId, Db db, ClaimQueries queries) =>
        {
            await RequireClaimAsync(db, claimId);
            return Results.Json(Page<WorkflowRunView>.Of(await queries.WorkflowRunsAsync(claimId)), Json.Options);
        });

        app.MapGet("/claims/{claimId:guid}/history", async (Guid claimId, HttpRequest request, Db db, ClaimQueries queries) =>
        {
            await RequireClaimAsync(db, claimId);
            var page = await queries.HistoryAsync(claimId, Http.QueryInt(request, "limit", 50, 1, 200), Http.Query(request, "cursor"));
            return Results.Json(page, Json.Options);
        });
    }

    private static async Task RequireClaimAsync(Db db, Guid id)
    {
        var exists = await db.SingleAsync<bool>("SELECT EXISTS (SELECT 1 FROM claims WHERE id = @id)", new { id });
        if (!exists) throw ApiException.NotFound("Claim", id);
    }
}
