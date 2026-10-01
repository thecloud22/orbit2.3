using System.Text.Json;
using Claims.Common;
using Microsoft.AspNetCore.Http.Extensions;

namespace Claims.Web;

/// <summary>One error model for the whole API: RFC 9457 problem+json plus a stable machine <c>code</c>.</summary>
public sealed partial class ApiExceptionMiddleware(RequestDelegate next, ILogger<ApiExceptionMiddleware> log)
{
    public async Task InvokeAsync(HttpContext context)
    {
        try
        {
            await next(context);
            // A bare 404 / 405 from routing gets the same body as every other error.
            if (!context.Response.HasStarted && context.Response.ContentLength is null or 0 && context.Response.ContentType is null)
            {
                var (code, detail) = context.Response.StatusCode switch
                {
                    404 => ("not_found", "No such resource"),
                    405 => ("method_not_allowed", "That method is not supported here"),
                    415 => ("unsupported_media_type", "That media type is not supported"),
                    _ => (null, null),
                };
                if (code is not null) await WriteAsync(context, context.Response.StatusCode, code, detail!, []);
            }
        }
        catch (ApiException e)
        {
            await WriteAsync(context, e.Status, e.Code, e.Message, e.Errors);
        }
        catch (Exception e) when (e is JsonException or BadHttpRequestException)
        {
            await WriteAsync(context, 400, "malformed_request", "The request body could not be read", []);
        }
        catch (Exception e) when (e is not OperationCanceledException)
        {
            LogUnhandled(e);
            await WriteAsync(context, 500, "internal_error", "Something went wrong on our side", []);
        }
    }

    public static async Task WriteAsync(HttpContext context, int status, string code, string detail, IReadOnlyList<FieldError> errors)
    {
        if (context.Response.HasStarted) return;
        context.Response.Clear();
        context.Response.StatusCode = status;
        context.Response.ContentType = "application/problem+json";
        var problem = new Dictionary<string, object?>
        {
            ["type"] = "https://claims.example.com/problems/" + code,
            ["title"] = ApiException.ReasonPhrase(status),
            ["status"] = status,
            ["detail"] = detail,
            ["code"] = code,
        };
        if (errors.Count > 0) problem["errors"] = errors;
        await context.Response.WriteAsync(JsonSerializer.Serialize(problem, Json.Options));
    }

    [LoggerMessage(Level = LogLevel.Error, Message = "Unhandled error")]
    private partial void LogUnhandled(Exception e);
}
