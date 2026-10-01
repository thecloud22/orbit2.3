namespace Claims.Requirement;

/// <summary>What the rules say to do with an arriving document. Pure: the workflow's first step calls it, and it is unit-tested.</summary>
public static class DocumentRules
{
    public const string TinCheck = "tin_check";
    public const string Accept = "accept";
    public const string Review = "review";

    /// <summary>
    /// The route a document takes:
    /// a claimant statement with a W-9 goes to the IRS taxpayer-number check; a death certificate is accepted when it is a certified original and goes to a
    /// person when it is a photocopy (<c>photocopy: true</c>, or <c>sealPresent: false</c>: no raised seal to read); a police report is accepted; anything else
    /// goes to a person. The reason is what the person (and the run record) is told.
    /// </summary>
    public static (string Route, string Reason) RouteFor(string kind, bool? photocopy, bool? sealPresent) => kind switch
    {
        "claimant_statement_w9" => (TinCheck, "Claimant statement with a W-9: the taxpayer number is checked with the IRS"),
        "death_certificate" when photocopy == true => (Review, "A photocopy: the rules accept only a certified original"),
        "death_certificate" when sealPresent == false => (Review, "No raised seal found: it cannot be confirmed as certified"),
        "death_certificate" => (Accept, "A certified original: the rules accept it"),
        "police_report" => (Accept, "A report from the investigating agency: the rules accept it"),
        _ => (Review, "The rules have no way to accept this kind of document"),
    };

    /// <summary>The requirement a document is for when the sender did not name one.</summary>
    public static string? DefaultRequirementKey(string kind) => kind switch
    {
        "claimant_statement_w9" => "statement",
        "death_certificate" => "certificate",
        "police_report" => "report",
        _ => null,
    };

    public static string Title(string kind) => kind switch
    {
        "claimant_statement_w9" => "Claimant statement and W-9",
        "death_certificate" => "Death certificate",
        "police_report" => "Police report",
        _ => "Document",
    };
}
