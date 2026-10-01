using Claims.Common;
using Claims.Store;
using Claims.View;

namespace Claims.Web;

public static class WorkItemsEndpoints
{
    public static void MapWorkItems(this IEndpointRouteBuilder app)
    {
        // GET /work-items?owner={id}&status=open: the mock's getQueue.
        app.MapGet("/work-items", async (HttpRequest request, ClaimQueries queries) =>
        {
            var items = await queries.WorkItemsAsync(Http.QueryGuid(request, "owner"), Http.Query(request, "status"), Http.QueryInt(request, "limit", 100, 1, 500));
            return Results.Json(Page<WorkItemView>.Of(items), Json.Options);
        });

        // Who the owner ids are, and their authority (read-only; the web maps a handle to an id with it).
        app.MapGet("/staff", async (HttpRequest request, ClaimQueries queries) =>
        {
            var role = Http.Query(request, "role");
            if (role is not null && role is not ("life_examiner" or "di_case_manager" or "annuity_specialist" or "team_lead"))
                throw ApiException.BadRequest("malformed_request", "Query parameter role must be life_examiner, di_case_manager, annuity_specialist or team_lead");
            return Results.Json(Page<StaffView>.Of(await queries.StaffAsync(role)), Json.Options);
        });

        // A person marks an item done. If-Match is the item's version from the list (its ETag).
        app.MapPost("/work-items/{workItemId:guid}:complete", async (Guid workItemId, HttpRequest request, WorkItemService service) =>
        {
            var ifMatch = Http.RequireHeader(request, "If-Match");
            var actor = Http.HeaderOr(request, "X-Actor", "examiner.dev");
            var item = await service.CompleteAsync(workItemId, IfMatch.Parse(ifMatch), Actor.User(actor));
            return Http.Ok(request.HttpContext.Response, item, item.Version);
        });
    }
}
