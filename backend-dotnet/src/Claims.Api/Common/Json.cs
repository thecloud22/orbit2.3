using System.Globalization;
using System.Text.Encodings.Web;
using System.Text.Json;
using System.Text.Json.Serialization;

namespace Claims.Common;

/// <summary>
/// One JSON dialect for the API, the jsonb columns and Temporal payloads: camelCase names, nulls written, timestamps as UTC
/// instants ("2026-09-25T15:03:00Z"), business dates as plain dates. Same shapes Jackson produced in the Java version.
/// </summary>
public static class Json
{
    public static JsonSerializerOptions Options { get; } = Create();

    public static JsonSerializerOptions Create()
    {
        var o = new JsonSerializerOptions(JsonSerializerDefaults.Web)
        {
            DefaultIgnoreCondition = JsonIgnoreCondition.Never,
            // Jackson writes "Life & annuity team", not "Life \u0026 annuity team"; this is an API, not HTML.
            Encoder = JavaScriptEncoder.UnsafeRelaxedJsonEscaping,
        };
        o.Converters.Add(new InstantConverter());
        return o;
    }

    public static string Serialize<T>(T value) => JsonSerializer.Serialize(value, Options);

    public static T? Deserialize<T>(string json) => JsonSerializer.Deserialize<T>(json, Options);
}

/// <summary>DateTimeOffset as java.time.Instant did: always UTC, "Z", and 0, 3, 6 or 9 fraction digits (ISO_INSTANT).</summary>
public sealed class InstantConverter : JsonConverter<DateTimeOffset>
{
    public override DateTimeOffset Read(ref Utf8JsonReader reader, Type typeToConvert, JsonSerializerOptions options) =>
        reader.GetDateTimeOffset().ToUniversalTime();

    public override void Write(Utf8JsonWriter writer, DateTimeOffset value, JsonSerializerOptions options) =>
        writer.WriteStringValue(Format(value));

    public static string Format(DateTimeOffset value)
    {
        var utc = value.UtcDateTime;
        var nanos = (utc.Ticks % TimeSpan.TicksPerSecond) * 100;
        var text = utc.ToString("yyyy-MM-dd'T'HH:mm:ss", CultureInfo.InvariantCulture);
        if (nanos == 0) return text + "Z";
        if (nanos % 1_000_000 == 0) return text + "." + (nanos / 1_000_000).ToString("D3", CultureInfo.InvariantCulture) + "Z";
        if (nanos % 1_000 == 0) return text + "." + (nanos / 1_000).ToString("D6", CultureInfo.InvariantCulture) + "Z";
        return text + "." + nanos.ToString("D9", CultureInfo.InvariantCulture) + "Z";
    }
}
