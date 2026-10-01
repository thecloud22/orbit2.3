using System.Text;

namespace Claims.Common;

/// <summary>Domain enums are PascalCase in C# and snake_case in the database and on the wire (GatheringEvidence is gathering_evidence).</summary>
public static class EnumText
{
    public static string Db<T>(this T value) where T : struct, Enum => Cache<T>.ToDb[value];

    public static T Parse<T>(string db) where T : struct, Enum =>
        Cache<T>.FromDb.TryGetValue(db, out var v) ? v : throw new ArgumentException($"'{db}' is not a {typeof(T).Name}");

    private static class Cache<T> where T : struct, Enum
    {
        public static readonly Dictionary<T, string> ToDb = Enum.GetValues<T>().ToDictionary(v => v, v => Snake(v.ToString()));
        public static readonly Dictionary<string, T> FromDb = ToDb.ToDictionary(kv => kv.Value, kv => kv.Key);
    }

    private static string Snake(string pascal)
    {
        var sb = new StringBuilder();
        for (var i = 0; i < pascal.Length; i++)
        {
            if (i > 0 && char.IsUpper(pascal[i])) sb.Append('_');
            sb.Append(char.ToLowerInvariant(pascal[i]));
        }
        return sb.ToString();
    }
}
