namespace Claims.Gateway;

public sealed record Screening(bool Clear, string Reference);

public interface ISanctionsGateway
{
    /// <summary>Screens payees before anything is sent. Throws on timeout; Temporal retries the activity.</summary>
    Task<Screening> ScreenAsync(IReadOnlyList<string> names);
}
