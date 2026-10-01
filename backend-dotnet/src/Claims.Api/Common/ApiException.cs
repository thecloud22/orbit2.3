namespace Claims.Common;

public sealed record FieldError(string Field, string Message);

/// <summary>An error the API reports as application/problem+json (RFC 9457) with a stable <c>code</c>.</summary>
public sealed class ApiException : Exception
{
    public int Status { get; }
    public string Code { get; }
    public IReadOnlyList<FieldError> Errors { get; }

    public ApiException(int status, string code, string message, IReadOnlyList<FieldError>? errors = null) : base(message)
    {
        Status = status;
        Code = code;
        Errors = errors ?? [];
    }

    public static ApiException BadRequest(string code, string message) => new(400, code, message);

    public static ApiException NotFound(string what, object id) => new(404, "not_found", $"{what} {id} not found");

    public static ApiException Conflict(string code, string message) => new(409, code, message);

    public static ApiException VersionConflict(string what) =>
        new(412, "version_conflict", $"{what} changed since you read it; fetch it again and retry with the new ETag");

    public static ApiException Unprocessable(string code, string message) => new(422, code, message);

    /// <summary>The reason phrases Spring used, so "title" is the same on both backends.</summary>
    public static string ReasonPhrase(int status) => status switch
    {
        400 => "Bad Request",
        404 => "Not Found",
        405 => "Method Not Allowed",
        409 => "Conflict",
        412 => "Precondition Failed",
        415 => "Unsupported Media Type",
        422 => "Unprocessable Entity",
        428 => "Precondition Required",
        _ => status >= 500 ? "Internal Server Error" : "Error",
    };
}
