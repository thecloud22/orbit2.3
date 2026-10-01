using System.Globalization;
using Claims.Common;

namespace Claims.Web;

/// <summary>Optimistic concurrency: the ETag of a resource is its row version, quoted ("7"); If-Match echoes it back.</summary>
internal static class IfMatch
{
    public static long Parse(string header)
    {
        var v = header.Trim();
        if (v.StartsWith("W/", StringComparison.Ordinal)) v = v[2..];
        v = v.Replace("\"", "", StringComparison.Ordinal);
        return long.TryParse(v, NumberStyles.AllowLeadingSign, CultureInfo.InvariantCulture, out var version)
            ? version
            : throw ApiException.BadRequest("invalid_if_match", "If-Match must be an ETag returned by a GET, e.g. \"3\"");
    }

    public static string ETag(long version) => "\"" + version.ToString(CultureInfo.InvariantCulture) + "\"";
}
