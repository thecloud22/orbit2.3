namespace Claims.Gateway;

/// <summary>
/// The IRS taxpayer-number match. <c>Match</c> false is an ANSWER ("no match": the number and name do not agree), returned normally; the workflow takes its
/// not-enough branch and Temporal does not retry it. A real failure (a timeout, a 503) is an exception, and Temporal retries the activity.
/// </summary>
public sealed record TinMatchAnswer(bool Match, string Reference, string Detail);

public interface ITinMatchGateway
{
    /// <summary>Checks the name and taxpayer number. Throws when the service cannot be reached.</summary>
    Task<TinMatchAnswer> CheckAsync(string name, string? tin);
}
