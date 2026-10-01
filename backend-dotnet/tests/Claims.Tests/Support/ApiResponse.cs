using System.Net;
using System.Net.Http.Headers;
using System.Text;
using System.Text.Json.Nodes;

namespace Claims.Tests.Support;

/// <summary>A response with its body parsed, so tests can assert on fields the way the Java tests used MockMvc jsonPath.</summary>
public sealed class ApiResponse(HttpResponseMessage message, string body)
{
    public HttpStatusCode Status => message.StatusCode;
    public int StatusCode => (int)message.StatusCode;
    public string Body => body;
    public JsonNode Json => JsonNode.Parse(body) ?? throw new InvalidOperationException("no JSON body");
    public string? Header(string name) => message.Headers.TryGetValues(name, out var v) ? v.First() : null;
    public string? ContentType => message.Content.Headers.ContentType?.ToString();

    /// <summary>A dotted path with array indexes, e.g. items[0].id, into the body.</summary>
    public JsonNode? At(string path)
    {
        JsonNode? node = Json;
        foreach (var part in path.Split('.'))
        {
            var name = part;
            int? index = null;
            var bracket = part.IndexOf('[', StringComparison.Ordinal);
            if (bracket >= 0)
            {
                name = part[..bracket];
                index = int.Parse(part[(bracket + 1)..^1], System.Globalization.CultureInfo.InvariantCulture);
            }
            if (name.Length > 0) node = node?[name];
            if (index is not null) node = node?[index.Value];
        }
        return node;
    }

    public string? Str(string path) => At(path)?.GetValue<string>();

    public IEnumerable<JsonNode> Items => Json["items"]!.AsArray().Select(n => n!);

    public IEnumerable<JsonNode> ItemsWhere(string field, string value) => Items.Where(i => i[field]?.ToString() == value);
}

public static class ApiClientExtensions
{
    public static async Task<ApiResponse> SendJsonAsync(this HttpClient client, HttpMethod method, string path, string? body = null,
                                                        IReadOnlyDictionary<string, string>? headers = null)
    {
        using var request = new HttpRequestMessage(method, path);
        if (body is not null) request.Content = new StringContent(body, Encoding.UTF8, new MediaTypeHeaderValue("application/json"));
        foreach (var (name, value) in headers ?? new Dictionary<string, string>()) request.Headers.TryAddWithoutValidation(name, value);
        var response = await client.SendAsync(request);
        return new ApiResponse(response, await response.Content.ReadAsStringAsync());
    }

    public static Task<ApiResponse> GetApiAsync(this HttpClient client, string path) => client.SendJsonAsync(HttpMethod.Get, path);

    public static Task<ApiResponse> PostApiAsync(this HttpClient client, string path, string? body = null, IReadOnlyDictionary<string, string>? headers = null) =>
        client.SendJsonAsync(HttpMethod.Post, path, body, headers);
}
