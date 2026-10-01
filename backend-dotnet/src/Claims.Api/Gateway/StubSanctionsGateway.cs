namespace Claims.Gateway;

/// <summary>STUB. Clear for everyone except a name containing "OFAC-HIT", which makes demos of the hold path possible.</summary>
public sealed class StubSanctionsGateway : ISanctionsGateway
{
    public Task<Screening> ScreenAsync(IReadOnlyList<string> names)
    {
        var hit = names.Any(n => n.Contains("OFAC-HIT", StringComparison.OrdinalIgnoreCase));
#pragma warning disable RS0030 // a stub reference, not workflow code; the real gateway returns the vendor's reference
        return Task.FromResult(new Screening(!hit, "stub-" + Guid.NewGuid()));
#pragma warning restore RS0030
    }
}
