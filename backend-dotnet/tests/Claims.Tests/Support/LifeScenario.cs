using System.Text.Json;
using Claims.Common;
using Claims.Decision;
using Claims.Intake;
using Claims.Requirement;
using Claims.View;

namespace Claims.Tests.Support;

/// <summary>A claim that is ready for a decision: proof of loss complete, status in_review.</summary>
public sealed record ReadyClaim(Guid ClaimId, string ClaimNumber, Guid BaseLineId, Guid? RiderLineId);

/// <summary>Builds the mock's Castellano claim up to a given point, for the tests that do not need the intake workflow (no Temporal).</summary>
public static class LifeScenario
{
    public const string DecideBasis = "In force and past the contestable period. Diane 50% and Mark 50% as contingent beneficiaries; interest from 19 Sep to the pay date.";

    /// <summary>
    /// Intake through the real service, the intake workflow's final step done by hand (status, route, owner), then every open requirement accepted through
    /// the real requirement service: proof of loss completes, so the claim ends in_review with its decision rows and the examiner's work item.
    /// </summary>
    public static async Task<ReadyClaim> InReviewAsync(PostgresApiFixture f, string manner = "natural", bool agentConsent = true)
    {
        var claim = (await f.Get<LifeIntakeService>().SubmitAsync(TestData.Castellano(manner, TestData.NewPolicy(), "Robert Castellano", agentConsent),
            "scn-" + Guid.NewGuid(), Actor.User("intake.test"))).Claim;
        await f.Db.ExecuteAsync("""
            UPDATE claims SET status = 'gathering_evidence', track = 'standard_life', route_rule = 'LF-02',
                   owner_id = (SELECT id FROM staff_users WHERE handle = 'rachel') WHERE id = @c
            """, new { c = claim.Id });
        var requirements = f.Get<RequirementService>();
        foreach (var r in (await f.Get<Claims.Store.ClaimQueries>().RequirementsAsync(claim.Id)).Where(r => r.State is "requested" or "not_enough"))
            await requirements.AcceptAsync(r.Id, r.Version, "Received", Actor.User("rachel"));
        var lines = (await f.Get<Claims.Store.ClaimQueries>().ClaimAsync(claim.Id))!.BenefitLines;
        return new ReadyClaim(claim.Id, claim.ClaimNumber, lines.First(l => l.Kind == "base").Id, lines.FirstOrDefault(l => l.Kind == "rider")?.Id);
    }

    /// <summary>
    /// Intake through the real service and the intake workflow's final step done by hand (status, route, owner rachel), with every requirement still open: the state a claim is
    /// in while evidence is being gathered. The four requirements are: certificate, Diane's statement, Mark's statement, and "primary died first" (already met from our records at intake).
    /// </summary>
    public static async Task<ReadyClaim> GatheringAsync(PostgresApiFixture f, string manner = "natural", bool agentConsent = true)
    {
        var claim = (await f.Get<LifeIntakeService>().SubmitAsync(TestData.Castellano(manner, TestData.NewPolicy(), "Robert Castellano", agentConsent),
            "scn-" + Guid.NewGuid(), Actor.User("intake.test"))).Claim;
        await f.Db.ExecuteAsync("""
            UPDATE claims SET status = 'gathering_evidence', track = 'standard_life', route_rule = 'LF-02',
                   owner_id = (SELECT id FROM staff_users WHERE handle = 'rachel') WHERE id = @c
            """, new { c = claim.Id });
        var lines = (await f.Get<Claims.Store.ClaimQueries>().ClaimAsync(claim.Id))!.BenefitLines;
        return new ReadyClaim(claim.Id, claim.ClaimNumber, lines.First(l => l.Kind == "base").Id, lines.FirstOrDefault(l => l.Kind == "rider")?.Id);
    }

    /// <summary>The request the web app sends: approve the base line.</summary>
    public static RecordDecisionRequest Approve(Guid lineId, string basis = DecideBasis) => new(lineId, "approve", basis, null, null, null);

    public static string ApproveJson(Guid lineId, string basis = DecideBasis) =>
        JsonSerializer.Serialize(new { benefitLineId = lineId, outcome = "approve", basis });

    public static Dictionary<string, string> Headers(string actor, string? key = null) => new()
    {
        ["X-Actor"] = actor,
        ["Idempotency-Key"] = key ?? "key-" + Guid.NewGuid(),
    };

    /// <summary>A claim in review, decided by Rachel within her authority: two items cleared for the next run.</summary>
    public static async Task<(ReadyClaim Claim, RecordDecisionResult Result)> ApprovedAsync(PostgresApiFixture f, string manner = "natural", string actor = "rachel")
    {
        var claim = await InReviewAsync(f, manner);
        var outcome = await f.Get<DecisionService>().RecordAsync(claim.ClaimId, Approve(claim.BaseLineId), "key-" + Guid.NewGuid(), actor);
        return (claim, outcome.Result);
    }
}
