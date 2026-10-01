namespace Claims.Domain;

/// <summary>"What Temporal did", in plain words, for a run record. Pure.</summary>
public static class RunNotes
{
    /// <summary>
    /// A line for every step that Temporal ran more than once and that then succeeded, or null when none did. The wording is about the step, not about why it needed a
    /// second attempt (a fault, a real timeout): the fault that caused it adds its own line to the run.
    /// </summary>
    public static string? Retries(IEnumerable<RunStep> steps)
    {
        var retried = steps.Where(s => s.Attempts > 1 && s.State != "failed").ToList();
        if (retried.Count == 0) return null;
        return string.Join(" ", retried.Select(s =>
            $"\"{s.Label}\" ran {s.Attempts} times: when the first attempt did not finish in time Temporal scheduled it again, and it went to whichever worker was free. " +
            "That worker first replayed the workflow's history, so the steps before it used their recorded results and did not run again."));
    }
}
