using System.Globalization;
using System.Text;
using Claims.Common;
using Claims.Domain;
using Claims.View;

namespace Claims.Store;

/// <summary>The read side: every GET the API serves. Plain SQL, no writes.</summary>
public sealed class ClaimQueries(Db db)
{
    // ------------------------------------------------------------------ claims

    public async Task<ClaimView?> ClaimAsync(Guid id)
    {
        // Explicit columns: claims and life_claim_details both have generic names, and a positional read must not guess which one wins.
        var head = await db.QueryOptionalAsync("""
            SELECT c.id, c.claim_number, c.family, c.product_code, c.status, c.track, c.route_rule, c.route_reasons, c.owner_id, c.team,
                   c.noticed_at, c.proof_complete_at, c.closed_at, c.insured_party_id, p.full_name AS insured_name,
                   c.version, c.created_at, c.updated_at,
                   d.claim_id AS detail_claim_id, d.date_of_death, d.place_of_death, d.manner_of_death, d.death_outside_us, d.funeral_home,
                   d.caller_party_id, d.caller_relationship, d.contact_by, d.agent_consent, d.other_claimants_possible, d.intake_channel
            FROM claims c
            JOIN parties p ON p.id = c.insured_party_id
            LEFT JOIN life_claim_details d ON d.claim_id = c.id
            WHERE c.id = @id
            """, new { id },
            r => new ClaimView(r.Guid("id"), r.Text("claim_number"), r.Text("family"), r.Text("product_code"), r.Text("status"), r.Str("track"),
                r.Str("route_rule"), r.TextArray("route_reasons"), r.GuidOrNull("owner_id"), r.Text("team"), r.Instant("noticed_at"),
                r.InstantOrNull("proof_complete_at"), r.InstantOrNull("closed_at"), new PartyRef(r.Guid("insured_party_id"), r.Text("insured_name")),
                r.IsNull("detail_claim_id") ? null : Life(r), [], [], r.Long("version"), r.Instant("created_at"), r.Instant("updated_at")));
        if (head is null) return null;
        return head with { BenefitLines = await BenefitLinesAsync(id), Parties = await PartiesAsync(id) };
    }

    private static LifeDetails Life(DbRow r) => new("life", r.Date("date_of_death"), r.Str("place_of_death"), r.Text("manner_of_death"),
        r.Bool("death_outside_us"), r.Str("funeral_home"), r.Guid("caller_party_id"), r.Str("caller_relationship"), r.TextArray("contact_by"),
        r.Bool("agent_consent"), r.Bool("other_claimants_possible"), r.Text("intake_channel"));

    private async Task<IReadOnlyList<BenefitLineView>> BenefitLinesAsync(Guid claimId) => await db.QueryAsync("""
        SELECT b.id, b.kind, b.parent_line_id, b.rider_key, b.name, b.amount, b.currency, b.status, b.waiting_on, b.product_config_version,
               b.version, pol.policy_number
        FROM benefit_lines b JOIN policies pol ON pol.id = b.policy_id
        WHERE b.claim_id = @c ORDER BY b.kind, b.created_at, b.id
        """, new { c = claimId },
        r => new BenefitLineView(r.Guid("id"), r.Text("policy_number"), r.Text("kind"), r.GuidOrNull("parent_line_id"), r.Str("rider_key"),
            r.Text("name"), Money.Of(r.Decimal("amount"), r.Text("currency")), r.Text("status"), r.Str("waiting_on"),
            r.Text("product_config_version"), r.Long("version")));

    private async Task<IReadOnlyList<ClaimPartyView>> PartiesAsync(Guid claimId) => await db.QueryAsync("""
        SELECT cp.party_id, cp.role, cp.relationship, cp.beneficiary_kind, cp.share_percent, cp.payee, cp.packet_channel, cp.access_note,
               p.full_name, p.date_of_death
        FROM claim_parties cp JOIN parties p ON p.id = cp.party_id
        WHERE cp.claim_id = @c ORDER BY cp.created_at, p.full_name, cp.role
        """, new { c = claimId },
        r => new ClaimPartyView(r.Guid("party_id"), r.Text("full_name"), r.Text("role"), r.Str("relationship"), r.Str("beneficiary_kind"),
            r.DecimalOrNull("share_percent")?.ToString(CultureInfo.InvariantCulture), r.Bool("payee"), r.Str("packet_channel"),
            r.Str("access_note"), r.DateOrNull("date_of_death")));

    /// <summary>GET /claims: newest first, keyset paginated.</summary>
    public async Task<Page<ClaimSummary>> ClaimsAsync(Guid? owner, string? status, string? family, string? claimNumber, int limit, string? cursor)
    {
        var sql = new StringBuilder("""
            SELECT c.id, c.claim_number, c.family, c.product_code, c.status, c.track, c.owner_id, c.noticed_at, c.created_at,
                   c.version, p.full_name AS insured_name
            FROM claims c JOIN parties p ON p.id = c.insured_party_id WHERE true
            """);
        var args = new Dictionary<string, object?>();
        if (owner is not null) { sql.Append(" AND c.owner_id = @owner"); args["owner"] = owner; }
        if (status is not null) { sql.Append(" AND c.status = @status"); args["status"] = status; }
        if (family is not null) { sql.Append(" AND c.family = @family"); args["family"] = family; }
        if (claimNumber is not null) { sql.Append(" AND c.claim_number = @claimNumber"); args["claimNumber"] = claimNumber; }
        if (cursor is not null)
        {
            var c = Cursor.Decode(cursor, t => Guid.TryParse(t, out _));
            sql.Append(" AND (c.created_at, c.id) < (@curAt, @curId)");
            args["curAt"] = c.At;
            args["curId"] = Guid.Parse(c.Tie);
        }
        sql.Append(" ORDER BY c.created_at DESC, c.id DESC LIMIT @lim");
        args["lim"] = limit + 1;
        var created = new List<DateTimeOffset>();
        var rows = await db.QueryAsync(sql.ToString(), Params(args), r =>
        {
            created.Add(r.Instant("created_at"));
            return new ClaimSummary(r.Guid("id"), r.Text("claim_number"), r.Text("family"), r.Text("product_code"), r.Text("status"), r.Str("track"),
                r.GuidOrNull("owner_id"), r.Text("insured_name"), r.Instant("noticed_at"), r.Long("version"));
        });
        if (rows.Count <= limit) return new Page<ClaimSummary>(rows, null);
        return new Page<ClaimSummary>(rows.GetRange(0, limit), new Cursor(created[limit - 1], rows[limit - 1].Id.ToString()).Encode());
    }

    // ------------------------------------------------------------------ requirements

    private static RequirementView Requirement(DbRow r) => new(r.Guid("id"), r.Guid("claim_id"), r.GuidOrNull("benefit_line_id"), r.Text("key"),
        r.Text("name"), r.Text("purpose"), new RequirementSource(r.GuidOrNull("from_party_id"), r.Text("from_label"), r.Str("from_detail")),
        r.Text("state"), r.Str("state_note"), r.Instant("requested_at"), r.Int("follow_up_days"), r.Int("follow_up_count"), r.InstantOrNull("last_reminder_at"),
        r.InstantOrNull("received_at"), r.InstantOrNull("accepted_at"), r.Str("satisfied_by"), r.InstantOrNull("waived_at"), r.Str("waive_reason"),
        r.Long("version"));

    public async Task<IReadOnlyList<RequirementView>> RequirementsAsync(Guid claimId) =>
        await db.QueryAsync("SELECT * FROM requirements WHERE claim_id = @c ORDER BY created_at, id", new { c = claimId }, Requirement);

    public Task<RequirementView?> RequirementAsync(Guid id) =>
        db.QueryOptionalAsync("SELECT * FROM requirements WHERE id = @id", new { id }, Requirement);

    // ------------------------------------------------------------------ deadlines

    private static DeadlineView Deadline(DbRow r) => new(r.Guid("id"), r.Guid("claim_id"), r.Text("kind"), r.GuidOrNull("requirement_id"),
        r.GuidOrNull("document_id"), r.GuidOrNull("party_id"), r.Text("what"), r.Str("sla"), r.Instant("due_at"), r.Instant("original_due_at"), r.Str("extension_reason"), r.Text("state"),
        r.Int("attempt"), r.InstantOrNull("dispatched_at"), r.Bool("fired"), r.Str("last_outcome"), r.Str("last_error"), r.Str("workflow_id"),
        r.InstantOrNull("closed_at"), r.Str("closed_by"), r.Str("result"), r.Long("version"));

    public async Task<IReadOnlyList<DeadlineView>> DeadlinesAsync(Guid claimId) =>
        await db.QueryAsync("SELECT * FROM deadlines WHERE claim_id = @c ORDER BY created_at, due_at, id", new { c = claimId }, Deadline);

    public Task<DeadlineView?> DeadlineAsync(Guid id) =>
        db.QueryOptionalAsync("SELECT * FROM deadlines WHERE id = @id", new { id }, Deadline);

    /// <summary>GET /deadlines: the operations view: what is open, overdue or stuck across claims.</summary>
    public async Task<IReadOnlyList<DeadlineView>> DeadlinesAsync(string? state, string? kind, DateTimeOffset? dueBefore, int limit)
    {
        var sql = new StringBuilder("SELECT * FROM deadlines WHERE true");
        var args = new Dictionary<string, object?>();
        if (state is not null) { sql.Append(" AND state = @state"); args["state"] = state; }
        if (kind is not null) { sql.Append(" AND kind = @kind"); args["kind"] = kind; }
        if (dueBefore is not null) { sql.Append(" AND due_at <= @dueBefore"); args["dueBefore"] = dueBefore.Value.ToUniversalTime(); }
        sql.Append(" ORDER BY due_at, id LIMIT @lim");
        args["lim"] = limit;
        return await db.QueryAsync(sql.ToString(), Params(args), Deadline);
    }

    // ------------------------------------------------------------------ letters, history, work, runs

    public async Task<IReadOnlyList<LetterView>> LettersAsync(Guid claimId) => await db.QueryAsync(
        "SELECT * FROM letters WHERE claim_id = @c ORDER BY created_at DESC, id DESC", new { c = claimId },
        r => new LetterView(r.Guid("id"), r.Guid("claim_id"), r.GuidOrNull("benefit_line_id"), r.Text("template_code"), r.Text("channel"),
            r.GuidOrNull("recipient_party_id"), r.Text("recipient_label"), r.Text("subject"), r.Str("summary"), r.Text("status"),
            r.InstantOrNull("sent_at"), r.Str("workflow_id"), r.Instant("created_at"), r.Str("status_reason")));

    /// <summary>GET /claims/{id}/history: newest first, keyset paginated on (occurred_at, seq).</summary>
    public async Task<Page<HistoryEventView>> HistoryAsync(Guid claimId, int limit, string? cursor)
    {
        var sql = new StringBuilder("SELECT *, seq AS s FROM history_events WHERE claim_id = @claim");
        var args = new Dictionary<string, object?> { ["claim"] = claimId };
        if (cursor is not null)
        {
            var c = Cursor.Decode(cursor, t => long.TryParse(t, CultureInfo.InvariantCulture, out _));
            sql.Append(" AND (occurred_at, seq) < (@curAt, @curSeq)");
            args["curAt"] = c.At;
            args["curSeq"] = long.Parse(c.Tie, CultureInfo.InvariantCulture);
        }
        sql.Append(" ORDER BY occurred_at DESC, seq DESC LIMIT @lim");
        args["lim"] = limit + 1;
        var keys = new List<Cursor>();
        var rows = await db.QueryAsync(sql.ToString(), Params(args), r =>
        {
            keys.Add(new Cursor(r.Instant("occurred_at"), r.Long("s").ToString(CultureInfo.InvariantCulture)));
            return new HistoryEventView(r.Guid("id"), r.Guid("claim_id"), r.Instant("occurred_at"), r.Instant("recorded_at"), r.Text("type"),
                r.Text("title"), r.Text("actor_kind"), r.Text("actor"), r.Str("detail"), r.Str("ref"), r.Str("workflow_id"));
        });
        if (rows.Count <= limit) return new Page<HistoryEventView>(rows, null);
        return new Page<HistoryEventView>(rows.GetRange(0, limit), keys[limit - 1].Encode());
    }

    public async Task<IReadOnlyList<WorkItemView>> WorkItemsAsync(Guid? owner, string? status, int limit)
    {
        var sql = new StringBuilder("SELECT * FROM work_items WHERE true");
        var args = new Dictionary<string, object?>();
        if (owner is not null) { sql.Append(" AND owner_id = @owner"); args["owner"] = owner; }
        if (status is not null) { sql.Append(" AND status = @status"); args["status"] = status; }
        sql.Append(" ORDER BY priority, due_on, created_at, id LIMIT @lim");
        args["lim"] = limit;
        return await db.QueryAsync(sql.ToString(), Params(args),
            r => new WorkItemView(r.Guid("id"), r.GuidOrNull("owner_id"), r.Guid("claim_id"), r.Int("priority"), r.Text("action"), r.Text("why"),
                r.Date("due_on"), r.Text("waiting_on"), r.Str("flag"), r.Text("section"), r.Text("status"), r.Long("version")));
    }

    public async Task<IReadOnlyList<StaffView>> StaffAsync(string? role = null) => await db.QueryAsync(
        "SELECT id, handle, display_name, title, team, role, payout_limit FROM staff_users WHERE active AND (cast(@role as text) IS NULL OR role = @role) ORDER BY team, role, handle", new { role },
        r => new StaffView(r.Guid("id"), r.Text("handle"), r.Text("display_name"), r.Str("title"), r.Text("team"), r.Text("role"), Money.Of(r.Decimal("payout_limit"), "USD")));

    public Task<WorkItemView?> WorkItemAsync(Guid id) => db.QueryOptionalAsync("SELECT * FROM work_items WHERE id = @id", new { id },
        r => new WorkItemView(r.Guid("id"), r.GuidOrNull("owner_id"), r.Guid("claim_id"), r.Int("priority"), r.Text("action"), r.Text("why"),
            r.Date("due_on"), r.Text("waiting_on"), r.Str("flag"), r.Text("section"), r.Text("status"), r.Long("version")));

    private const string RunSelect = """
        SELECT w.*, (w.status = 'failed' AND NOT EXISTS (SELECT 1 FROM workflow_runs n WHERE n.workflow_id = w.workflow_id AND n.run_no > w.run_no)) AS can_rerun
        FROM workflow_runs w
        """;

    private static WorkflowRunView WorkflowRun(DbRow r) => new(r.Guid("id"), r.Text("workflow_id"), r.Text("run_id"), r.Text("type"), r.Text("name"), r.GuidOrNull("claim_id"),
        r.Text("started_by"), r.Str("trigger_kind"), r.GuidOrNull("trigger_id"), r.Text("status"), r.Instant("started_at"),
        r.InstantOrNull("finished_at"), Steps(r.Text("steps")), r.TextArray("saved"), r.Str("error"),
        r.Int("run_no"), r.GuidOrNull("rerun_of_id"), r.Str("note"), r.IsNull("elapsed_ms") ? null : r.Int("elapsed_ms"), r.Bool("can_rerun"));

    public async Task<IReadOnlyList<WorkflowRunView>> WorkflowRunsAsync(Guid claimId) => await db.QueryAsync(
        RunSelect + " WHERE w.claim_id = @c ORDER BY w.started_at, w.run_no, w.id", new { c = claimId }, WorkflowRun);

    /// <summary>The operations view: newest first, optionally only one status (failed).</summary>
    public async Task<IReadOnlyList<WorkflowRunView>> WorkflowRunsAsync(string? status, int limit) => await db.QueryAsync(
        RunSelect + " WHERE (cast(@s as text) IS NULL OR w.status = @s) ORDER BY w.started_at DESC, w.run_no DESC, w.id LIMIT @lim", new { s = status, lim = limit }, WorkflowRun);

    public Task<WorkflowRunView?> WorkflowRunAsync(Guid id) => db.QueryOptionalAsync(RunSelect + " WHERE w.id = @id", new { id }, WorkflowRun);

    private static IReadOnlyList<RunStep> Steps(string jsonText) =>
        Json.Deserialize<List<RunStep>>(jsonText) ?? throw new InvalidOperationException("Bad steps json in workflow_runs");

    // ------------------------------------------------------------------ decisions, payment items, payment runs

    private const string DecisionSelect = """
        SELECT d.id, d.claim_id, d.benefit_line_id, d.version, d.supersedes_id, d.outcome, d.outcome_text, d.basis, d.evidence::text AS evidence,
               d.provisions::text AS provisions, d.recorded_at, d.recorded_by, d.authority_note, d.requires_approval, d.letter_template, d.amount,
               d.group_id, bl.name AS line_name, bl.currency, rb.display_name AS recorded_by_name,
               a.approved_by, a.approved_at, ab.display_name AS approved_by_name,
               (SELECT sum(pi.amount) FROM payment_items pi WHERE pi.decision_id = d.id AND pi.kind = 'benefit') AS items_total
        FROM decisions d
        JOIN benefit_lines bl ON bl.id = d.benefit_line_id
        JOIN staff_users rb ON rb.id = d.recorded_by
        LEFT JOIN decision_approvals a ON a.decision_id = d.id
        LEFT JOIN staff_users ab ON ab.id = a.approved_by
        """;

    private static DecisionView Decision(DbRow r)
    {
        var requires = r.Bool("requires_approval");
        var approved = !r.IsNull("approved_by");
        var amount = r.DecimalOrNull("items_total") ?? r.DecimalOrNull("amount");
        var note = r.Text("authority_note");
        // The note is written when the decision is recorded, before anyone approves it: "above $250,000 authority". Once a team lead has
        // approved, it reads as the mock writes it: "approved by Monica Reyes above $250,000 authority".
        if (requires) note = approved ? "approved by " + r.Text("approved_by_name") + " " + note : note + ", awaiting approval";
        return new DecisionView(r.Guid("id"), r.Guid("claim_id"), r.Guid("benefit_line_id"), r.Text("line_name"), r.Int("version"),
            r.GuidOrNull("supersedes_id"), r.Text("outcome"), r.Text("outcome_text"), r.Text("basis"),
            Json.Deserialize<List<string>>(r.Text("evidence")) ?? [], Json.Deserialize<List<string>>(r.Text("provisions")) ?? [],
            amount is null ? null : Money.Of(amount.Value, r.Text("currency")), r.Instant("recorded_at"), r.Guid("recorded_by"),
            r.Text("recorded_by_name"), note, requires, requires && !approved ? "awaiting_approval" : "in_effect",
            r.GuidOrNull("approved_by"), r.Str("approved_by_name"), r.InstantOrNull("approved_at"), r.Str("letter_template"));
    }

    /// <summary>Newest first; <paramref name="asOf"/> keeps the versions recorded at or before that instant.</summary>
    public async Task<IReadOnlyList<DecisionView>> DecisionsAsync(Guid claimId, DateTimeOffset? asOf) => await db.QueryAsync(
        DecisionSelect + " WHERE d.claim_id = @c AND (cast(@asOf as timestamptz) IS NULL OR d.recorded_at <= @asOf) ORDER BY d.recorded_at DESC, d.version DESC, d.id",
        new { c = claimId, asOf = asOf?.ToUniversalTime() }, Decision);

    public Task<DecisionView?> DecisionAsync(Guid id) => db.QueryOptionalAsync(DecisionSelect + " WHERE d.id = @id", new { id }, Decision);

    /// <summary>The decisions recorded in one act (the base line first, then its riders).</summary>
    public async Task<IReadOnlyList<DecisionView>> DecisionGroupAsync(Guid groupId) => await db.QueryAsync(
        DecisionSelect + " WHERE d.group_id = @g ORDER BY bl.kind, bl.created_at, d.id", new { g = groupId }, Decision);

    private const string PaymentItemSelect = """
        SELECT pi.*, p.full_name AS payee_name, (SELECT r.id FROM payment_items r WHERE r.replacement_of_id = pi.id ORDER BY r.created_at LIMIT 1) AS replaced_by_id
        FROM payment_items pi JOIN parties p ON p.id = pi.payee_party_id
        """;

    private static PaymentItemView PaymentItem(DbRow r)
    {
        var cur = r.Text("currency");
        return new PaymentItemView(r.Guid("id"), r.Guid("claim_id"), r.Guid("benefit_line_id"), r.GuidOrNull("decision_id"), r.Text("kind"),
            r.GuidOrNull("adjusts_item_id"), r.GuidOrNull("replacement_of_id"), r.GuidOrNull("replaced_by_id"), r.GuidOrNull("payment_method_id"), r.Guid("payee_party_id"), r.Text("payee_name"), r.Text("basis"),
            Money.Of(r.Decimal("principal_amount"), cur), Money.Of(r.Decimal("interest_amount"), cur), Money.Of(r.Decimal("amount"), cur),
            r.Text("method"), r.Date("pay_on"), r.Text("status"), r.Str("hold_reason"), r.GuidOrNull("run_id"), r.InstantOrNull("paid_at"),
            r.Str("payment_reference"), r.Str("return_code"), r.Str("return_reason"), r.Long("version"));
    }

    public async Task<IReadOnlyList<PaymentItemView>> PaymentItemsAsync(Guid claimId) => await db.QueryAsync(
        PaymentItemSelect + " WHERE pi.claim_id = @c ORDER BY pi.created_at, p.full_name, pi.id", new { c = claimId }, PaymentItem);

    public Task<PaymentItemView?> PaymentItemAsync(Guid id) => db.QueryOptionalAsync(PaymentItemSelect + " WHERE pi.id = @id", new { id }, PaymentItem);

    public async Task<IReadOnlyList<PaymentItemView>> PaymentItemsForDecisionsAsync(IReadOnlyCollection<Guid> decisionIds) => await db.QueryAsync(
        PaymentItemSelect + " WHERE pi.decision_id = ANY (cast(@ids as uuid[])) ORDER BY pi.created_at, p.full_name, pi.id",
        new { ids = Db.ArrayLiteral(decisionIds.Select(i => i.ToString())) }, PaymentItem);

    private static PaymentRunView PaymentRun(DbRow r) => new(r.Guid("id"), r.Date("run_date"), r.Text("status"), r.Text("trigger"), r.Int("item_count"),
        r.Int("paid_count"), r.Int("returned_count"), Money.Of(r.Decimal("total_amount"), r.Text("currency")), r.Str("file_reference"), r.Str("error"),
        r.Instant("started_at"), r.InstantOrNull("finished_at"));

    public async Task<IReadOnlyList<PaymentRunView>> PaymentRunsAsync(int limit) => await db.QueryAsync(
        "SELECT * FROM payment_runs ORDER BY started_at DESC, id DESC LIMIT @lim", new { lim = limit }, PaymentRun);

    public Task<PaymentRunView?> PaymentRunAsync(Guid id) => db.QueryOptionalAsync("SELECT * FROM payment_runs WHERE id = @id", new { id }, PaymentRun);

    // ------------------------------------------------------------------ documents, payment methods

    private const string DocumentSelect = """
        SELECT d.*, r.name AS requirement_name, p.full_name AS party_name,
               (SELECT o.workflow_id FROM outbox_events o WHERE o.id = d.outbox_event_id) AS workflow_id
        FROM documents d LEFT JOIN requirements r ON r.id = d.requirement_id LEFT JOIN parties p ON p.id = d.party_id
        """;

    private static DocumentView Document(DbRow r)
    {
        var a = System.Text.Json.Nodes.JsonNode.Parse(r.Text("attributes"))!.AsObject();
        var tin = a["tin"]?.GetValue<string>();
        var digits = tin is null ? "" : new string(tin.Where(char.IsAsciiDigit).ToArray());
        return new DocumentView(r.Guid("id"), r.Guid("claim_id"), r.GuidOrNull("requirement_id"), r.Str("requirement_name"), r.GuidOrNull("party_id"), r.Str("party_name"),
            r.Text("kind"), r.Text("source"),
            new DocumentAttributesView(digits.Length >= 4 ? "***-**-" + digits[^4..] : null, a["photocopy"]?.GetValue<bool>(), a["sealPresent"]?.GetValue<bool>()),
            r.Text("status"), r.Str("status_note"), r.Instant("received_at"), r.Text("received_by"), r.Str("reviewed_by"), r.InstantOrNull("reviewed_at"),
            r.Str("review_reason"), r.Str("workflow_id"), r.Long("version"));
    }

    public async Task<IReadOnlyList<DocumentView>> DocumentsAsync(Guid claimId) => await db.QueryAsync(
        DocumentSelect + " WHERE d.claim_id = @c ORDER BY d.received_at, d.created_at, d.id", new { c = claimId }, Document);

    public Task<DocumentView?> DocumentAsync(Guid id) => db.QueryOptionalAsync(DocumentSelect + " WHERE d.id = @id", new { id }, Document);

    private static PaymentMethodView PaymentMethod(DbRow r) => new(r.Guid("id"), r.Guid("party_id"), r.Guid("claim_id"), r.Text("kind"), r.Text("routing_last4"),
        r.Text("account_last4"), r.Str("holder_name"), r.Text("status"), r.Instant("created_at"), r.InstantOrNull("verified_at"), r.Long("version"));

    public async Task<IReadOnlyList<PaymentMethodView>> PaymentMethodsAsync(Guid claimId) => await db.QueryAsync(
        "SELECT * FROM payment_methods WHERE claim_id = @c ORDER BY created_at, id", new { c = claimId }, PaymentMethod);

    public Task<PaymentMethodView?> PaymentMethodAsync(Guid id) => db.QueryOptionalAsync("SELECT * FROM payment_methods WHERE id = @id", new { id }, PaymentMethod);

    public async Task<IReadOnlyList<PaymentMethodHoldView>> PaymentMethodHoldsAsync(Guid claimId) => await db.QueryAsync(
        "SELECT * FROM payment_method_holds WHERE claim_id = @c ORDER BY created_at, id", new { c = claimId },
        r => new PaymentMethodHoldView(r.Guid("id"), r.Guid("party_id"), r.Guid("claim_id"), r.Guid("source_item_id"), r.Text("reason"), r.Instant("created_at"),
            r.GuidOrNull("superseded_by_method_id")));

    /// <summary>The dynamic filters build their parameter bag by name; Dapper takes a dictionary as-is.</summary>
    private static Dapper.DynamicParameters Params(Dictionary<string, object?> args) => new(args);
}
