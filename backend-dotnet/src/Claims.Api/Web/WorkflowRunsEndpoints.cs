using Claims.Common;
using Claims.Store;
using Claims.Temporal;
using Claims.View;

namespace Claims.Web;

public static class WorkflowRunsEndpoints
{
    public static void MapWorkflowRuns(this IEndpointRouteBuilder app)
    {
        // The operations view: what failed, across claims.
        app.MapGet("/workflow-runs", async (HttpRequest request, ClaimQueries queries) =>
        {
            var status = Http.Query(request, "status");
            if (status is not null && status is not ("running" or "completed" or "skipped" or "needs_review" or "failed"))
                throw ApiException.BadRequest("malformed_request", "Query parameter status must be running, completed, skipped, needs_review or failed");
            return Results.Json(Page<WorkflowRunView>.Of(await queries.WorkflowRunsAsync(status, Http.QueryInt(request, "limit", 25, 1, 100))), Json.Options);
        });

        app.MapPost("/workflow-runs/{workflowRunId:guid}:rerun", async (Guid workflowRunId, HttpRequest request, WorkflowRerunService service) =>
        {
            var actor = Http.RequireHeader(request, "X-Actor");
            var r = await service.RerunAsync(workflowRunId, actor);
            return Results.Json(r, Json.Options, statusCode: 202);
        });
    }
}
