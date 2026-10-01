using Claims.Common;
using Claims.Deadline;
using Claims.Store;
using Claims.View;

namespace Claims.Web;

public static class DeadlinesEndpoints
{
    public sealed record ExtendBody(DateTimeOffset? NewDueAt, string? Reason);

    public static void MapDeadlines(this IEndpointRouteBuilder app)
    {
        // The operations view across claims: what is open, overdue, or dispatched and stuck.
        app.MapGet("/deadlines", async (HttpRequest request, ClaimQueries queries) =>
        {
            var items = await queries.DeadlinesAsync(Http.Query(request, "state"), Http.Query(request, "kind"), Http.QueryInstant(request, "dueBefore"),
                Http.QueryInt(request, "limit", 100, 1, 500));
            return Results.Json(Page<DeadlineView>.Of(items), Json.Options);
        });

        app.MapGet("/deadlines/{deadlineId:guid}", async (Guid deadlineId, HttpResponse response, ClaimQueries queries) =>
        {
            var d = await queries.DeadlineAsync(deadlineId) ?? throw ApiException.NotFound("Deadline", deadlineId);
            return Http.Ok(response, d, d.Version);
        });

        // The nightly overdue check, by hand (the daily job calls the same service).
        app.MapPost("/deadlines:check-overdue", async (OverdueCheckService service) => Results.Json(await service.RunAsync(), Json.Options));

        app.MapPost("/deadlines/{deadlineId:guid}:extend", async (Guid deadlineId, HttpRequest request, DeadlineService service) =>
        {
            var ifMatch = Http.RequireHeader(request, "If-Match");
            var actor = Http.HeaderOr(request, "X-Actor", "examiner.dev");
            var body = await Http.RequiredBodyAsync<ExtendBody>(request);
            if (body.NewDueAt is null) throw ApiException.Unprocessable("validation_failed", "newDueAt is required");
            var d = await service.ExtendAsync(deadlineId, IfMatch.Parse(ifMatch), body.NewDueAt.Value, body.Reason, Actor.User(actor));
            return Http.Ok(request.HttpContext.Response, d, d.Version);
        });
    }
}
