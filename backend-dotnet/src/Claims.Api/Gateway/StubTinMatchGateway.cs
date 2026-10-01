using System.Security.Cryptography;
using System.Text;

namespace Claims.Gateway;

/// <summary>
/// STUB. Answers "match" for a number of nine digits (dashes allowed) and "no match" otherwise or when the fault <c>tin.no-match</c> is on (each check uses one
/// unit of a counted fault). The fault <c>tin.down</c> makes it fail like a 503, which Temporal retries. The real gateway calls the IRS TIN matching service.
/// </summary>
public sealed partial class StubTinMatchGateway(IFaultRegistry faults, ILogger<StubTinMatchGateway> log) : ITinMatchGateway
{
    public Task<TinMatchAnswer> CheckAsync(string name, string? tin)
    {
        if (faults.Trigger(FaultCatalog.TinDown)) throw new InvalidOperationException("The IRS TIN matching service returned 503 (fault tin.down)");
        var digits = new string((tin ?? "").Where(char.IsAsciiDigit).ToArray());
        var reference = "irs-stub-" + Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(name + "|" + digits)))[..8].ToLowerInvariant();
        if (faults.Trigger(FaultCatalog.TinNoMatch))
        {
            LogAnswer(reference, false);
            return Task.FromResult(new TinMatchAnswer(false, reference, "The name and taxpayer number do not match IRS records (fault tin.no-match)"));
        }
        var ok = digits.Length == 9;
        LogAnswer(reference, ok);
        return Task.FromResult(new TinMatchAnswer(ok, reference, ok ? "The name and taxpayer number match IRS records" : "The taxpayer number is not nine digits"));
    }

    [LoggerMessage(Level = LogLevel.Information, Message = "STUB IRS TIN match {Reference}: match={Match}")]
    private partial void LogAnswer(string reference, bool match);
}
