using Claims.Common;
using Claims.Requirement;
using Claims.Store;

namespace Claims.Web;

public static class RequirementsEndpoints
{
    public sealed record AcceptBody(string? SatisfiedBy);

    public sealed record WaiveBody(string? Reason);

    public static void MapRequirements(this IEndpointRouteBuilder app)
    {
        app.MapGet("/requirements/{requirementId:guid}", async (Guid requirementId, HttpResponse response, ClaimQueries queries) =>
        {
            var r = await queries.RequirementAsync(requirementId) ?? throw ApiException.NotFound("Requirement", requirementId);
            return Http.Ok(response, r, r.Version);
        });

        app.MapPost("/requirements/{requirementId:guid}:accept", async (Guid requirementId, HttpRequest request, RequirementService service) =>
        {
            var ifMatch = Http.RequireHeader(request, "If-Match");
            var actor = Http.HeaderOr(request, "X-Actor", "examiner.dev");
            var body = await Http.BodyAsync<AcceptBody>(request);   // the body is optional
            var r = await service.AcceptAsync(requirementId, IfMatch.Parse(ifMatch), body?.SatisfiedBy, Actor.User(actor));
            return Http.Ok(request.HttpContext.Response, r, r.Version);
        });

        app.MapPost("/requirements/{requirementId:guid}:waive", async (Guid requirementId, HttpRequest request, RequirementService service) =>
        {
            var ifMatch = Http.RequireHeader(request, "If-Match");
            var actor = Http.HeaderOr(request, "X-Actor", "examiner.dev");
            var body = await Http.RequiredBodyAsync<WaiveBody>(request);
            var r = await service.WaiveAsync(requirementId, IfMatch.Parse(ifMatch), body.Reason, Actor.User(actor));
            return Http.Ok(request.HttpContext.Response, r, r.Version);
        });
    }
}
