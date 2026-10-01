namespace Claims.Domain;

/// <summary>
/// One step of a workflow run as the Workflow &amp; SLA section shows it. state: done | retried | skipped | failed. <c>Attempts</c> is how many times Temporal
/// ran the step (1 = the first time); <c>Note</c> is what Temporal did, in plain words. Both have defaults, so run records written before they existed still read.
/// </summary>
public sealed record RunStep(string Label, string Detail, string System, string State, int Attempts = 1, string? Note = null)
{
    public static RunStep Done(string label, string detail, string system) => new(label, detail, system, "done");
    public static RunStep Skipped(string label, string detail, string system) => new(label, detail, system, "skipped");
    public static RunStep Retried(string label, string detail, string system) => new(label, detail, system, "retried");

    /// <summary>A step that ran <paramref name="attempts"/> times: "retried" when it succeeded on a later attempt, "done" when it was the first.</summary>
    public static RunStep Ran(string label, string detail, string system, int attempts, string? note = null) =>
        new(label, detail, system, attempts > 1 ? "retried" : "done", Math.Max(1, attempts), attempts > 1 ? note : null);

    /// <summary>The retries ran out: the run fails after this step.</summary>
    public static RunStep Failed(string label, string detail, string system, int attempts, string? note = null) =>
        new(label, detail, system, "failed", Math.Max(1, attempts), note);
}
