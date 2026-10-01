using System.Globalization;
using System.Text.Json;
using Claims.Common;

namespace Claims.Web;

/// <summary>Small request/response helpers shared by the endpoint groups. Failures are ApiExceptions, so they come out as problem+json.</summary>
internal static class Http
{
    public static string RequireHeader(HttpRequest request, string name)
    {
        var value = request.Headers[name].ToString();
        if (!string.IsNullOrEmpty(value)) return value;
        // Same rule as before: a missing If-Match is 428 (state-changing calls need it), any other missing header is 400.
        if (name.Equals("If-Match", StringComparison.OrdinalIgnoreCase))
            throw new ApiException(428, "precondition_required", "Header If-Match is required");
        throw ApiException.BadRequest("missing_header", $"Header {name} is required");
    }

    public static string HeaderOr(HttpRequest request, string name, string fallback)
    {
        var value = request.Headers[name].ToString();
        return string.IsNullOrEmpty(value) ? fallback : value;
    }

    /// <summary>The JSON body as T, or null when there is no body. Unreadable JSON is a 400 malformed_request.</summary>
    public static async Task<T?> BodyAsync<T>(HttpRequest request) where T : class
    {
        using var buffer = new MemoryStream();
        await request.Body.CopyToAsync(buffer);
        if (buffer.Length == 0) return null;
        try
        {
            return JsonSerializer.Deserialize<T>(buffer.ToArray(), Json.Options);
        }
        catch (JsonException)
        {
            throw ApiException.BadRequest("malformed_request", "The request body could not be read");
        }
    }

    public static async Task<T> RequiredBodyAsync<T>(HttpRequest request) where T : class =>
        await BodyAsync<T>(request) ?? throw ApiException.BadRequest("malformed_request", "The request body could not be read");

    public static string? Query(HttpRequest request, string name)
    {
        var v = request.Query[name].ToString();
        return string.IsNullOrEmpty(v) ? null : v;
    }

    public static Guid? QueryGuid(HttpRequest request, string name) =>
        Query(request, name) is { } v
            ? Guid.TryParse(v, out var g) ? g : throw ApiException.BadRequest("malformed_request", $"Query parameter {name} must be a UUID")
            : null;

    public static int QueryInt(HttpRequest request, string name, int fallback, int min, int max)
    {
        if (Query(request, name) is not { } v) return fallback;
        if (!int.TryParse(v, NumberStyles.Integer, CultureInfo.InvariantCulture, out var n))
            throw ApiException.BadRequest("malformed_request", $"Query parameter {name} must be an integer");
        return Math.Max(min, Math.Min(n, max));
    }

    public static DateTimeOffset? QueryInstant(HttpRequest request, string name) =>
        Query(request, name) is { } v
            ? DateTimeOffset.TryParse(v, CultureInfo.InvariantCulture, DateTimeStyles.AssumeUniversal, out var t)
                ? t.ToUniversalTime()
                : throw ApiException.BadRequest("malformed_request", $"Query parameter {name} must be an ISO-8601 date-time")
            : null;

    /// <summary>
    /// 200 with the resource and its ETag. A GET or HEAD whose If-None-Match already has that ETag gets 304 and no body, as Spring's
    /// ResponseEntity.eTag() did implicitly.
    /// </summary>
    public static IResult Ok<T>(HttpResponse response, T body, long version)
    {
        var etag = IfMatch.ETag(version);
        response.Headers.ETag = etag;
        var request = response.HttpContext.Request;
        if ((HttpMethods.IsGet(request.Method) || HttpMethods.IsHead(request.Method)) && MatchesIfNoneMatch(request, etag))
            return Results.StatusCode(StatusCodes.Status304NotModified);
        return Results.Json(body, Json.Options);
    }

    private static bool MatchesIfNoneMatch(HttpRequest request, string etag) =>
        request.Headers.IfNoneMatch.SelectMany(v => (v ?? "").Split(','))
            .Select(t => t.Trim())
            .Any(t => t == "*" || (t.StartsWith("W/", StringComparison.Ordinal) ? t[2..] : t) == etag);
}
