using Claims.Common;
using Claims.Config;
using Claims.Domain;
using Claims.Gateway;
using Claims.Requirement;

namespace Claims.Tests;

/// <summary>Pure rules of "things bounce back": what the rules do with a document, the fault switchboard (atomic, counted, logged), and the run-step record's shape. No database, no Temporal.</summary>
public class BounceRulesTests
{
    [Theory]
    [InlineData("claimant_statement_w9", null, null, "tin_check")]
    [InlineData("death_certificate", null, null, "accept")]            // a certified original (nothing says otherwise)
    [InlineData("death_certificate", false, true, "accept")]
    [InlineData("death_certificate", true, null, "review")]            // a photocopy
    [InlineData("death_certificate", null, false, "review")]           // no raised seal
    [InlineData("death_certificate", true, true, "review")]            // a photocopy is a photocopy even when a seal shows on it
    [InlineData("police_report", null, null, "accept")]
    [InlineData("other", null, null, "review")]
    public void TheRulesRouteADocumentByKindAndItsAttributes(string kind, bool? photocopy, bool? seal, string route)
    {
        Assert.Equal(route, DocumentRules.RouteFor(kind, photocopy, seal).Route);
        Assert.False(string.IsNullOrWhiteSpace(DocumentRules.RouteFor(kind, photocopy, seal).Reason));
    }

    [Fact]
    public void ADocumentIsForTheRequirementItsKindUsuallySatisfies()
    {
        Assert.Equal("statement", DocumentRules.DefaultRequirementKey("claimant_statement_w9"));
        Assert.Equal("certificate", DocumentRules.DefaultRequirementKey("death_certificate"));
        Assert.Equal("report", DocumentRules.DefaultRequirementKey("police_report"));
        Assert.Null(DocumentRules.DefaultRequirementKey("other"));
    }

    [Fact]
    public void AnUncountedFaultStaysOnUntilClearedAndACountedOneIsUsedUpAndBothAreLogged()
    {
        var faults = new FaultRegistry(new ClaimsOptions());
        Assert.False(faults.Trigger(FaultCatalog.LettersDown));   // nothing is on by default

        faults.Set(FaultCatalog.LettersDown, true);
        Assert.True(faults.Trigger(FaultCatalog.LettersDown));
        Assert.True(faults.Trigger(FaultCatalog.LettersDown));    // still on
        faults.Set(FaultCatalog.LettersDown, false);
        Assert.False(faults.IsOn(FaultCatalog.LettersDown));

        faults.Set(FaultCatalog.TinNoMatch, 2);
        Assert.Equal(2, faults.State.Single().Count);
        Assert.True(faults.Trigger(FaultCatalog.TinNoMatch));
        Assert.True(faults.Trigger(FaultCatalog.TinNoMatch));
        Assert.False(faults.Trigger(FaultCatalog.TinNoMatch));    // used up, and switched itself off
        Assert.Empty(faults.State);

        faults.Set(FaultCatalog.BankRejectNext, true);
        Assert.True(faults.TryConsume(FaultCatalog.BankRejectNext));   // "the next one": once
        Assert.False(faults.TryConsume(FaultCatalog.BankRejectNext));
        Assert.Contains(faults.Log, e => e.Name == FaultCatalog.TinNoMatch && e.Detail.Contains("used", StringComparison.Ordinal));
        Assert.Throws<ArgumentOutOfRangeException>(() => faults.Set(FaultCatalog.TinNoMatch, 0));
    }

    [Fact]
    public async Task ManyThreadsConsumingACountedFaultUseEachUnitExactlyOnce()
    {
        var faults = new FaultRegistry(new ClaimsOptions());
        faults.Set(FaultCatalog.StallOnce("LifeIntake_SendAcknowledgementAndPackets"), 1);
        var hits = await Task.WhenAll(Enumerable.Range(0, 200).Select(_ => Task.Run(() => faults.TryConsume("worker.stall-once:LifeIntake_SendAcknowledgementAndPackets"))));
        Assert.Equal(1, hits.Count(h => h));   // exactly one execution stalls

        faults.Set(FaultCatalog.LettersDown, 10);
        var uses = await Task.WhenAll(Enumerable.Range(0, 200).Select(_ => Task.Run(() => faults.Trigger(FaultCatalog.LettersDown))));
        Assert.Equal(10, uses.Count(h => h));
    }

    [Theory]
    [InlineData("letters.down", true)]
    [InlineData("bank.down", true)]
    [InlineData("bank.reject-next", true)]
    [InlineData("tin.no-match", true)]
    [InlineData("tin.down", true)]
    [InlineData("worker.stall-once:LifeIntake_SendAcknowledgementAndPackets", true)]
    [InlineData("worker.stall-once:DocumentRejected_SendLetter", true)]
    [InlineData("worker.stall-once:", false)]
    [InlineData("worker.stall-once:NoUnderscore", false)]
    [InlineData("letters.dwon", false)]
    [InlineData("", false)]
    public void OnlyFaultsSomethingReadsCanBeSwitched(string name, bool known) => Assert.Equal(known, FaultCatalog.IsKnown(name));

    [Fact]
    public void AStepRecordedBeforeAttemptsAndNotesExistedStillReadsAndTheNewFieldsRoundTrip()
    {
        var old = Json.Deserialize<RunStep>("{\"label\":\"Route the claim\",\"detail\":\"fast track\",\"system\":\"Rules\",\"state\":\"done\"}")!;
        Assert.Equal((1, null), (old.Attempts, old.Note));

        var retried = RunStep.Ran("Send the acknowledgement and claim packets", "4 letters sent", "Letters and notifications", 2, "Temporal ran it again");
        Assert.Equal(("retried", 2, "Temporal ran it again"), (retried.State, retried.Attempts, retried.Note));
        var json = Json.Serialize(retried);
        Assert.Contains("\"attempts\":2", json, StringComparison.Ordinal);
        Assert.Equal(retried, Json.Deserialize<RunStep>(json));

        var first = RunStep.Ran("x", "y", "z", 1, "ignored on a first attempt");
        Assert.Equal(("done", 1, null), (first.State, first.Attempts, first.Note));
        var failed = RunStep.Failed("Send it", "503", "Letters service", 5);
        Assert.Equal(("failed", 5), (failed.State, failed.Attempts));
    }

    [Fact]
    public void TheRetryNoteNamesEveryStepThatRanMoreThanOnceAndNothingElse()
    {
        Assert.Null(RunNotes.Retries([RunStep.Done("a", "b", "c")]));
        Assert.Null(RunNotes.Retries([RunStep.Failed("a", "b", "c", 5)]));   // a failed step has its own note
        var note = RunNotes.Retries([RunStep.Done("a", "b", "c"), RunStep.Ran("Send it", "b", "c", 2)]);
        Assert.Contains("\"Send it\" ran 2 times", note, StringComparison.Ordinal);
        Assert.Contains("replayed the workflow's history", note, StringComparison.Ordinal);
    }
}
