using Claims.Clock;
using System.Globalization;
using Claims.Common;
using Claims.Domain;
using Claims.Store;
using Claims.Temporal;
using static Claims.Store.LetterRepository;
using static Claims.Temporal.LifeIntakeActivities;

namespace Claims.Intake;

/// <summary>
/// The database work behind the life intake activities: read the claim back, evaluate the rules that need rows, send the first
/// letters, and save the outcome in one transaction.
/// </summary>
public sealed class IntakeSetupService(Db db, WorkflowRunRepository runs, HistoryRepository history, WorkItemRepository workItems,
                                       LetterService letters, BusinessCalendar calendar, IClock clock)
{
    // ------------------------------------------------------------------ reads

    private sealed record Head(string Number, string Status, string Insured, string Caller, DateOnly Dod, bool Consent, string[] ContactBy);

    public async Task<Facts> LoadFactsAsync(Guid claimId)
    {
        var h = await db.QuerySingleAsync("""
            SELECT c.claim_number, c.status, ip.full_name AS insured, cp.full_name AS caller, d.date_of_death, d.agent_consent, d.contact_by
            FROM claims c JOIN parties ip ON ip.id = c.insured_party_id
            JOIN life_claim_details d ON d.claim_id = c.id JOIN parties cp ON cp.id = d.caller_party_id
            WHERE c.id = @id
            """, new { id = claimId },
            r => new Head(r.Text("claim_number"), r.Text("status"), r.Text("insured"), r.Text("caller"), r.Date("date_of_death"),
                r.Bool("agent_consent"), r.TextArray("contact_by")));
        var payees = await db.QueryAsync("""
            SELECT p.id, p.full_name, p.email, COALESCE(cp.packet_channel, 'portal') AS packet
            FROM claim_parties cp JOIN parties p ON p.id = cp.party_id
            WHERE cp.claim_id = @id AND cp.role = 'beneficiary' AND cp.payee ORDER BY p.full_name
            """, new { id = claimId },
            r => new Payee(r.Guid("id"), r.Text("full_name"), r.Text("packet"), r.Str("email")));
        var policies = await db.ListAsync<string>(
            "SELECT DISTINCT pol.policy_number FROM benefit_lines b JOIN policies pol ON pol.id = b.policy_id WHERE b.claim_id = @id ORDER BY 1",
            new { id = claimId });
        var agent = await db.SingleOrDefaultAsync<string>(
            "SELECT p.full_name FROM claim_parties cp JOIN parties p ON p.id = cp.party_id WHERE cp.claim_id = @id AND cp.role = 'agent_of_record' LIMIT 1",
            new { id = claimId });
        return new Facts(claimId, h.Number, h.Status, h.Insured, h.Caller, h.ContactBy.Contains("email"), payees, policies,
            h.Dod.ToString("yyyy-MM-dd", CultureInfo.InvariantCulture), h.Consent, agent);
    }

    public Task<List<string>> DuplicateClaimsAsync(Guid claimId) => db.ListAsync<string>("""
        SELECT other.claim_number FROM claims me
        JOIN parties mp ON mp.id = me.insured_party_id
        JOIN life_claim_details md ON md.claim_id = me.id
        JOIN claims other ON other.id <> me.id AND other.family = 'life' AND other.status <> 'closed'
        JOIN parties op ON op.id = other.insured_party_id
        JOIN life_claim_details od ON od.claim_id = other.id
        WHERE me.id = @id AND lower(op.full_name) = lower(mp.full_name) AND op.date_of_birth IS NOT DISTINCT FROM mp.date_of_birth
          AND od.date_of_death = md.date_of_death
        ORDER BY other.claim_number
        """, new { id = claimId });

    private sealed record Base(string Manner, bool Outside, bool Others, DateOnly NoticeDate);

    private sealed record Examiner(Guid Id, string Name);

    public async Task<RouteDecision> RouteAsync(Guid claimId)
    {
        var b = await db.QuerySingleAsync(
            "SELECT d.manner_of_death, d.death_outside_us, d.other_claimants_possible, c.noticed_at FROM life_claim_details d JOIN claims c ON c.id = d.claim_id WHERE d.claim_id = @id",
            new { id = claimId },
            r => new Base(r.Text("manner_of_death"), r.Bool("death_outside_us"), r.Bool("other_claimants_possible"), calendar.LocalDate(r.Instant("noticed_at"))));
        var dod = await db.QuerySingleAsync("SELECT date_of_death FROM life_claim_details WHERE claim_id = @id", new { id = claimId }, r => r.Date("date_of_death"));
        var issues = await db.QueryAsync(
            "SELECT DISTINCT pol.issue_date FROM benefit_lines b JOIN policies pol ON pol.id = b.policy_id WHERE b.claim_id = @id AND b.kind = 'base'",
            new { id = claimId }, r => r.Date("issue_date"));
        var total = await db.SingleAsync<decimal>("""
            SELECT COALESCE(sum(amount), 0) FROM benefit_lines WHERE claim_id = @id AND (kind = 'base' OR (kind = 'rider' AND @accident))
            """, new { id = claimId, accident = b.Manner == "accident" });
        var dobs = await db.QueryAsync(
            "SELECT p.date_of_birth FROM claim_parties cp JOIN parties p ON p.id = cp.party_id WHERE cp.claim_id = @id AND cp.role = 'beneficiary' AND cp.payee",
            new { id = claimId }, r => r.DateOrNull("date_of_birth"));
        var past = issues.All(iss => dod >= LifeIntakeRules.TwoYearsAfter(iss));
        var adults = dobs.All(d => LifeIntakeRules.IsAdult(d, b.NoticeDate));
        var r = LifeIntakeRules.RouteFor(new LifeIntakeRules.RouteFacts(b.Manner, past, total, adults, b.Others, b.Outside));

        // Least-loaded examiner. Real assignment (skills, out-of-office, capacity) replaces this.
        var ex = await db.QueryOptionalAsync("""
            SELECT s.id, s.display_name FROM staff_users s WHERE s.role = 'life_examiner' AND s.active
            ORDER BY (SELECT count(*) FROM claims c WHERE c.owner_id = s.id AND c.status <> 'closed'), s.handle LIMIT 1
            """, null, x => new Examiner(x.Guid("id"), x.Text("display_name")));
        return new RouteDecision(r.Track, r.Rule, r.Reasons, ex?.Id, ex?.Name);
    }

    // ------------------------------------------------------------------ letters

    /// <summary>ACK-LIFE-01 to the caller and PKT-LIFE-02 to each payee. Each is sent once per claim, however often this runs.</summary>
    public async Task<int> SendAcknowledgementAndPacketsAsync(Guid claimId, string workflowId)
    {
        var f = await LoadFactsAsync(claimId);
        var sent = 0;
        await letters.SendOnceAsync(new NewLetter(claimId, "ACK-LIFE-01", f.CallerByEmail ? "email" : "letter", null, f.CallerName,
            "Claim " + f.ClaimNumber + " received", "Our condolences; what we need and what happens next",
            "outbox_event", null, workflowId, "intake:" + claimId + ":ack"), f.CallerName);
        sent++;
        foreach (var p in f.Payees)
        {
            var mail = p.Packet == "mail";
            await letters.SendOnceAsync(new NewLetter(claimId, "PKT-LIFE-02", mail ? "letter" : "portal", p.PartyId, p.Name,
                "Claim packet · " + LifeIntakeRules.First(p.Name),
                "Claimant statement with W-9, how the proceeds are paid, and the death certificate we need",
                "outbox_event", null, workflowId, "intake:" + claimId + ":packet:" + p.PartyId), p.Name);
            sent++;
        }
        return sent;
    }

    public async Task<bool> TellAgentAsync(Guid claimId, string workflowId)
    {
        var f = await LoadFactsAsync(claimId);
        if (!f.AgentConsent || f.AgentName is null) return false;
        await letters.SendOnceAsync(new NewLetter(claimId, "AGT-NOTE-01", "email", null, f.AgentName,
            "A claim was filed on " + string.Join(", ", f.PolicyNumbers), "Status only, with the caller's consent",
            "outbox_event", null, workflowId, "intake:" + claimId + ":agent"), f.AgentName);
        return true;
    }

    // ------------------------------------------------------------------ outcomes (one transaction each)

    public Task CompleteSetupAsync(Guid claimId, RouteDecision route, IReadOnlyList<RunStep> steps, string workflowId, string runId) =>
        db.InTransactionAsync(async () =>
        {
            var now = clock.UtcNow;
            var moved = await db.ExecuteAsync("""
                UPDATE claims SET status = 'gathering_evidence', track = @track, route_rule = @rule,
                       route_reasons = cast(@reasons as text[]), owner_id = @owner
                WHERE id = @id AND status = 'received'
                """, new { track = route.Track, rule = route.Rule, reasons = Db.ArrayLiteral(route.Reasons), owner = route.ExaminerId, id = claimId });
            if (moved == 0)
            {   // a repeated call: the first one already did everything below
                await runs.FinishAsync(workflowId, runId, "completed", steps, ["Already set up"], null, now);
                return;
            }
            var closed = await db.ListAsync<Guid>("""
                UPDATE deadlines SET state = 'done', closed_at = @now, closed_by = 'intake', last_outcome = 'closed_early',
                       result = 'Closed by the intake run when the acknowledgement and packets were sent; never had to fire'
                WHERE claim_id = @id AND kind IN ('acknowledge_by', 'forms_by') AND state = 'open' RETURNING id
                """, new { now, id = claimId });
            var contactDue = (await db.QueryAsync(
                "SELECT due_at FROM deadlines WHERE claim_id = @id AND kind = 'first_contact_by' ORDER BY due_at LIMIT 1", new { id = claimId },
                r => r.Instant("due_at"))).Cast<DateTimeOffset?>().FirstOrDefault() ?? now;
            var f = await LoadFactsAsync(claimId);
            var first = LifeIntakeRules.First(f.CallerName);
            var track = route.Track == "fast_track_life" ? "Fast track life" : "Standard life";
            var contactDate = calendar.LocalDate(contactDue);
            await workItems.InsertOnceAsync("welcome-call:" + claimId, route.ExaminerId, claimId, 2, "New life claim: welcome call to " + first,
                "Phone intake · " + track + " · first contact due " + Iso(contactDate), contactDate, "You", "workflow", "workflow", null);
            var wf = Actor.Workflow(workflowId);
            await history.AppendAsync(claimId, now, "data", "Intake run " + workflowId + ": checks passed, claim set up", wf,
                steps.Count + " steps · " + closed.Count + " deadline rows closed at once", null, workflowId);
            await history.AppendAsync(claimId, now, "task", "Routed " + track + " → " + (route.ExaminerName ?? "team queue"),
                Actor.System("routing rule " + route.Rule), string.Join(" · ", route.Reasons), null, workflowId);
            await history.AppendAsync(claimId, now, "communication", "Acknowledgement and claim packets sent", Actor.System("ACK-LIFE-01, PKT-LIFE-02"), null, null, workflowId);
            await runs.FinishAsync(workflowId, runId, "completed", steps, [
                "Claim " + f.ClaimNumber + " → gathering_evidence · " + route.Rule,
                closed.Count + " deadline rows closed at once",
                "Welcome-call work item for " + (route.ExaminerName ?? "the team queue")], null, now, RunNotes.Retries(steps));
        });

    public Task HoldForReviewAsync(Guid claimId, IReadOnlyList<string> reasons, IReadOnlyList<RunStep> steps, string workflowId, string runId) =>
        db.InTransactionAsync(async () =>
        {
            var now = clock.UtcNow;
            var f = await LoadFactsAsync(claimId);
            await workItems.InsertOnceAsync("intake-review:" + claimId, null, claimId, 1, "Intake checks need a person: " + f.ClaimNumber,
                string.Join(" · ", reasons), calendar.LocalDate(now), "You", "workflow", "workflow", null);
            await history.AppendAsync(claimId, now, "task",
                "Intake checks stopped: " + reasons.Count + (reasons.Count == 1 ? " thing needs" : " things need") + " a person",
                Actor.Workflow(workflowId), string.Join(" · ", reasons), null, workflowId);
            await runs.FinishAsync(workflowId, runId, "needs_review", steps, ["Claim stays received", "Task opened in the team queue"], null, now);
        });

    public Task RecordFailureAsync(Guid claimId, string error, IReadOnlyList<RunStep> steps, string workflowId, string runId) =>
        db.InTransactionAsync(async () =>
        {
            var now = clock.UtcNow;
            var f = await LoadFactsAsync(claimId);
            await workItems.InsertOnceAsync("workflow-failed:" + workflowId, null, claimId, 1, "Intake run failed: " + f.ClaimNumber,
                "Workflow " + workflowId + " gave up: " + error, calendar.LocalDate(now), "You", "workflow", "workflow", null);
            await history.AppendAsync(claimId, now, "task", "Intake run failed after retries", Actor.Workflow(workflowId), error, null, workflowId);
            await runs.FinishAsync(workflowId, runId, "failed", steps, ["Ops task opened"], error, now);
        });

    public Task BeginRunAsync(Guid claimId, Guid eventId, string workflowId, string runId) =>
        runs.BeginAsync(workflowId, runId, "orchestration", "Intake checks and set-up", claimId,
            "Outbox relay · event " + eventId + " (notice of death saved)", "outbox_event", eventId, clock.UtcNow);

    private static string Iso(DateOnly d) => d.ToString("yyyy-MM-dd", CultureInfo.InvariantCulture);
}
