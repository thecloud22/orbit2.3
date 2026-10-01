using System.Globalization;
using System.Text;
using Claims.Common;

namespace Claims.Store;

/// <summary>Opaque keyset cursor: a timestamp (microseconds since the epoch) and a tie-breaker (uuid or sequence number).</summary>
public sealed record Cursor(DateTimeOffset At, string Tie)
{
    public string Encode()
    {
        var micros = (At.UtcTicks - DateTimeOffset.UnixEpoch.UtcTicks) / 10;
        var raw = Encoding.UTF8.GetBytes(micros.ToString(CultureInfo.InvariantCulture) + "|" + Tie);
        return Convert.ToBase64String(raw).TrimEnd('=').Replace('+', '-').Replace('/', '_');
    }

    /// <summary>Malformed input is a 400 invalid_cursor. (The Java version only caught a bad timestamp; a bad tie-breaker was a 500.)</summary>
    public static Cursor Decode(string token, Func<string, bool> validTie)
    {
        try
        {
            var padded = token.Replace('-', '+').Replace('_', '/');
            padded = padded.PadRight(padded.Length + ((4 - padded.Length % 4) % 4), '=');
            var parts = Encoding.UTF8.GetString(Convert.FromBase64String(padded)).Split('|', 2);
            var micros = long.Parse(parts[0], CultureInfo.InvariantCulture);
            if (parts.Length < 2 || !validTie(parts[1])) throw new FormatException("tie-breaker");
            return new Cursor(new DateTimeOffset(DateTimeOffset.UnixEpoch.UtcTicks + micros * 10, TimeSpan.Zero), parts[1]);
        }
        catch (Exception e) when (e is FormatException or ArgumentException or OverflowException or IndexOutOfRangeException)
        {
            throw ApiException.BadRequest("invalid_cursor", "The cursor is not valid");
        }
    }
}
