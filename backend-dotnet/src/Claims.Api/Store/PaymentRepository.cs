using Claims.Common;

namespace Claims.Store;

/// <summary>Every SQL statement that touches payment items and payment runs.</summary>
public sealed class PaymentRepository(Db db)
{
    public sealed record NewItem(Guid ClaimId, Guid BenefitLineId, Guid DecisionId, Guid PayeePartyId, string Basis, decimal Principal, decimal Interest,
                                 string Method, DateOnly PayOn);

    public sealed record RunItem(Guid Id, Guid ClaimId, Guid BenefitLineId, Guid PayeePartyId, string PayeeName, decimal Amount, string Currency, string Method);

    public sealed record ItemRow(Guid Id, Guid ClaimId, string Status, long Version, DateOnly PayOn);

    /// <summary>Written already `cleared`: the decision has checked everything that could stop it.</summary>
    public Task<Guid> InsertClearedAsync(NewItem i) => db.SingleAsync<Guid>("""
        INSERT INTO payment_items (claim_id, benefit_line_id, decision_id, payee_party_id, basis, principal_amount, interest_amount, method, pay_on, status)
        VALUES (@claim, @line, @decision, @payee, @basis, @principal, @interest, @method, @payOn, 'cleared')
        RETURNING id
        """, new
    {
        claim = i.ClaimId,
        line = i.BenefitLineId,
        decision = i.DecisionId,
        payee = i.PayeePartyId,
        basis = i.Basis,
        principal = i.Principal,
        interest = i.Interest,
        method = i.Method,
        payOn = i.PayOn,
    });

    /// <summary>
    /// THE statement of the payment run: cleared items due on or before the run date become <c>in_run</c>, stamped with the run id, in one
    /// statement. <c>FOR UPDATE SKIP LOCKED</c> means two runs (a scheduled one and a manual one, or two instances) never take the same
    /// item: each skips what the other holds, and a row the other run has just committed no longer matches <c>status = 'cleared'</c>.
    /// An item that pays to the account on file is left alone while the payee has a hold on it (the bank returned a payment to that closed account);
    /// an item that pays to a new account the payee gave (<c>payment_method_id</c>) is not affected.
    /// A test proves it with a second connection holding a row lock, and shows the same statement without SKIP LOCKED blocking.
    /// </summary>
    public const string ClaimClearedSql = """
        WITH picked AS (
            SELECT id FROM payment_items
            WHERE status = 'cleared' AND pay_on <= @runDate
              AND (payment_method_id IS NOT NULL OR NOT EXISTS (
                     SELECT 1 FROM payment_method_holds h WHERE h.claim_id = payment_items.claim_id AND h.party_id = payment_items.payee_party_id))
            ORDER BY pay_on, id
            FOR UPDATE SKIP LOCKED
        )
        UPDATE payment_items p SET status = 'in_run', run_id = @run
        FROM picked WHERE p.id = picked.id
        RETURNING p.id
        """;

    public Task<List<Guid>> ClaimClearedAsync(Guid runId, DateOnly runDate) => db.ListAsync<Guid>(ClaimClearedSql, new { run = runId, runDate });

    public Task<List<RunItem>> ItemsOfRunAsync(Guid runId) => db.QueryAsync("""
        SELECT pi.id, pi.claim_id, pi.benefit_line_id, pi.payee_party_id, p.full_name, pi.amount, pi.currency, pi.method
        FROM payment_items pi JOIN parties p ON p.id = pi.payee_party_id
        WHERE pi.run_id = @r AND pi.status = 'in_run' ORDER BY p.full_name, pi.id
        """, new { r = runId },
        r => new RunItem(r.Guid("id"), r.Guid("claim_id"), r.Guid("benefit_line_id"), r.Guid("payee_party_id"), r.Text("full_name"),
            r.Decimal("amount"), r.Text("currency"), r.Text("method")));

    public Task<int> MarkPaidAsync(Guid id, Guid runId, string reference, DateTimeOffset at) => db.ExecuteAsync(
        "UPDATE payment_items SET status = 'paid', paid_at = @at, payment_reference = @ref WHERE id = @id AND run_id = @run AND status = 'in_run'",
        new { id, run = runId, @ref = reference, at = at.ToUniversalTime() });

    public Task<int> MarkReturnedAsync(Guid id, Guid runId, string code, string reason) => db.ExecuteAsync(
        "UPDATE payment_items SET status = 'returned', return_code = @code, return_reason = @reason WHERE id = @id AND run_id = @run AND status = 'in_run'",
        new { id, run = runId, code, reason });

    /// <summary>The run failed before the bank had the file: its items go back to being cleared, unstamped.</summary>
    public Task<List<Guid>> ReleaseRunAsync(Guid runId) => db.ListAsync<Guid>(
        "UPDATE payment_items SET status = 'cleared', run_id = NULL WHERE run_id = @r AND status = 'in_run' RETURNING id", new { r = runId });

    // ------------------------------------------------------------------ hold / release

    public Task<ItemRow?> LockItemAsync(Guid id) => db.QueryOptionalAsync(
        "SELECT id, claim_id, status, version, pay_on FROM payment_items WHERE id = @id FOR UPDATE", new { id },
        r => new ItemRow(r.Guid("id"), r.Guid("claim_id"), r.Text("status"), r.Long("version"), r.Date("pay_on")));

    public Task<int> HoldAsync(Guid id, string reason) => db.ExecuteAsync(
        "UPDATE payment_items SET status = 'held', hold_reason = @reason WHERE id = @id AND status IN ('awaiting_proof', 'cleared')", new { id, reason });

    public Task<int> ReleaseAsync(Guid id) => db.ExecuteAsync(
        "UPDATE payment_items SET status = 'cleared', hold_reason = NULL WHERE id = @id AND status = 'held'", new { id });

    // ------------------------------------------------------------------ runs

    /// <summary>The scheduled run of a date. The partial unique index makes it one per date: a second insert does nothing and returns null.</summary>
    public Task<Guid?> InsertScheduledRunAsync(DateOnly runDate) => db.SingleOrDefaultAsync<Guid?>("""
        INSERT INTO payment_runs (run_date, trigger) VALUES (@d, 'schedule')
        ON CONFLICT (run_date) WHERE trigger = 'schedule' DO NOTHING RETURNING id
        """, new { d = runDate });

    /// <summary>A manual run, keyed: a repeat of the key does nothing and returns null.</summary>
    public Task<Guid?> InsertManualRunAsync(DateOnly runDate, string key) => db.SingleOrDefaultAsync<Guid?>("""
        INSERT INTO payment_runs (run_date, trigger, idempotency_key) VALUES (@d, 'manual', @k)
        ON CONFLICT (idempotency_key) WHERE idempotency_key IS NOT NULL DO NOTHING RETURNING id
        """, new { d = runDate, k = key });

    public Task<Guid?> RunByKeyAsync(string key) =>
        db.SingleOrDefaultAsync<Guid?>("SELECT id FROM payment_runs WHERE idempotency_key = @k", new { k = key });

    public Task<Guid?> ScheduledRunOfAsync(DateOnly runDate) =>
        db.SingleOrDefaultAsync<Guid?>("SELECT id FROM payment_runs WHERE run_date = @d AND trigger = 'schedule'", new { d = runDate });

    public Task<int> SetRunStartedAsync(Guid runId, DateTimeOffset at) =>
        db.ExecuteAsync("UPDATE payment_runs SET started_at = @at WHERE id = @id", new { id = runId, at = at.ToUniversalTime() });

    public Task<int> SetRunTotalsAsync(Guid runId, int count, decimal total) => db.ExecuteAsync(
        "UPDATE payment_runs SET item_count = @n, total_amount = @t WHERE id = @id", new { id = runId, n = count, t = total });

    public Task<int> FinishRunAsync(Guid runId, string status, string? fileReference, int paid, int returned, string? error, DateTimeOffset at) => db.ExecuteAsync("""
        UPDATE payment_runs SET status = @status, file_reference = @file, paid_count = @paid, returned_count = @returned, error = @error, finished_at = @at
        WHERE id = @id
        """, new { id = runId, status, file = fileReference, paid, returned, error = error is null ? null : error[..Math.Min(error.Length, 1000)], at = at.ToUniversalTime() });

    // ------------------------------------------------------------------ claim and line effects of a run

    /// <summary>
    /// Locks claim rows in id order. Every place that touches several claims in one transaction does this first, so two runs that share a claim (one
    /// took Diane's item, the other Mark's) queue up instead of deadlocking, and whoever finishes second sees the other's paid items when it decides
    /// whether the claim can close. Without this, both could look, each see the other's item still in a run, and leave a fully paid claim open.
    /// </summary>
    public Task<int> LockClaimsAsync(IEnumerable<Guid> claimIds) => db.ExecuteAsync(
        "SELECT id FROM claims WHERE id = ANY (cast(@ids as uuid[])) ORDER BY id FOR UPDATE",
        new { ids = Db.ArrayLiteral(claimIds.Select(i => i.ToString())) });

    public Task<int> SetClaimsPayingAsync(IEnumerable<Guid> claimIds) => db.ExecuteAsync(
        "UPDATE claims SET status = 'paying' WHERE id = ANY (cast(@ids as uuid[])) AND status = 'approved'",
        new { ids = Db.ArrayLiteral(claimIds.Select(i => i.ToString())) });

    public Task<int> SetClaimApprovedAgainAsync(Guid claimId) => db.ExecuteAsync(
        """
        UPDATE claims SET status = 'approved'
        WHERE id = @id AND status = 'paying'
          AND NOT EXISTS (SELECT 1 FROM payment_items WHERE claim_id = @id AND status IN ('in_run', 'paid', 'returned'))
        """, new { id = claimId });

    /// <summary>A benefit line is paid when every one of its items is.</summary>
    public Task<int> MarkPaidLinesAsync(Guid claimId) => db.ExecuteAsync("""
        UPDATE benefit_lines b SET status = 'paid', waiting_on = NULL
        WHERE b.claim_id = @c AND b.status = 'approved'
          AND EXISTS (SELECT 1 FROM payment_items pi WHERE pi.benefit_line_id = b.id)
          AND NOT EXISTS (SELECT 1 FROM payment_items pi WHERE pi.benefit_line_id = b.id AND pi.status NOT IN ('paid', 'cancelled')
                          AND NOT (pi.status = 'returned' AND EXISTS (SELECT 1 FROM payment_items r WHERE r.replacement_of_id = pi.id)))
        """, new { c = claimId });

    /// <summary>
    /// The claim closes when every item is paid and no benefit line is still waiting on anything. True when this call closed it. A returned item that has a
    /// replacement is settled (the replacement is the one that has to be paid); a returned item without one still keeps the claim open. A `reopened` claim closes
    /// again this way.
    /// </summary>
    public async Task<bool> TryCloseClaimAsync(Guid claimId, DateTimeOffset now) => await db.ExecuteAsync("""
        UPDATE claims c SET status = 'closed', closed_at = @now
        WHERE c.id = @c AND c.status IN ('approved', 'paying', 'reopened')
          AND EXISTS (SELECT 1 FROM payment_items WHERE claim_id = c.id AND status = 'paid')
          AND NOT EXISTS (SELECT 1 FROM payment_items pi WHERE pi.claim_id = c.id AND pi.status NOT IN ('paid', 'cancelled')
                          AND NOT (pi.status = 'returned' AND EXISTS (SELECT 1 FROM payment_items r WHERE r.replacement_of_id = pi.id)))
          AND NOT EXISTS (SELECT 1 FROM benefit_lines WHERE claim_id = c.id AND status IN ('gathering_evidence', 'cause_pending', 'ready_to_decide', 'approved'))
        """, new { c = claimId, now = now.ToUniversalTime() }) == 1;

    // ------------------------------------------------------------------ the bank's returns (the returns batch) and the replacement

    public sealed record PaidItem(Guid Id, Guid ClaimId, Guid BenefitLineId, Guid PayeePartyId, string PayeeName, decimal Amount, string Currency, string Status);

    /// <summary>
    /// THE statement of the returns batch: of the items a returns file names, the ones that are `paid`, locked <c>FOR UPDATE SKIP LOCKED</c>. A second batch at
    /// the same time skips what the first holds instead of waiting or processing it twice, and once the first has committed the item is `returned`, so it no longer
    /// matches. A test holds a row lock in another connection to show it, and shows the same statement without SKIP LOCKED blocking.
    /// </summary>
    public const string LockPaidForReturnSql = """
        SELECT pi.id, pi.claim_id, pi.benefit_line_id, pi.payee_party_id, p.full_name, pi.amount, pi.currency, pi.status
        FROM payment_items pi JOIN parties p ON p.id = pi.payee_party_id
        WHERE pi.id = ANY (cast(@ids as uuid[])) AND pi.status = 'paid'
        ORDER BY pi.id
        FOR UPDATE OF pi SKIP LOCKED
        """;

    public Task<List<PaidItem>> LockPaidForReturnAsync(IEnumerable<Guid> ids) => db.QueryAsync(LockPaidForReturnSql,
        new { ids = Db.ArrayLiteral(ids.Select(i => i.ToString())) },
        r => new PaidItem(r.Guid("id"), r.Guid("claim_id"), r.Guid("benefit_line_id"), r.Guid("payee_party_id"), r.Text("full_name"), r.Decimal("amount"),
            r.Text("currency"), r.Text("status")));

    /// <summary>Which of these items exist, and their status: how a return that was not processed is explained (never paid, already returned, unknown).</summary>
    public async Task<Dictionary<Guid, string>> StatusesAsync(IEnumerable<Guid> ids) =>
        (await db.QueryAsync("SELECT id, status FROM payment_items WHERE id = ANY (cast(@ids as uuid[]))", new { ids = Db.ArrayLiteral(ids.Select(i => i.ToString())) },
            r => (Id: r.Guid("id"), Status: r.Text("status")))).ToDictionary(x => x.Id, x => x.Status);

    /// <summary>The paid item becomes `returned`, with the bank's code and reason. Nothing else about it changes (a trigger guarantees it).</summary>
    public async Task<bool> MarkReturnedAfterPaidAsync(Guid id, string code, string? reason) => await db.ExecuteAsync(
        "UPDATE payment_items SET status = 'returned', return_code = @code, return_reason = @reason WHERE id = @id AND status = 'paid'",
        new { id, code, reason }) == 1;

    /// <summary>The payee's account on file is closed: no item that pays to it is paid while this hold exists. One per returned item (repeat is harmless).</summary>
    public async Task<bool> InsertHoldAsync(Guid claimId, Guid partyId, Guid sourceItemId, string reason, DateTimeOffset at) => await db.ExecuteAsync("""
        INSERT INTO payment_method_holds (claim_id, party_id, source_item_id, reason, created_at) VALUES (@c, @p, @i, @reason, @at)
        ON CONFLICT (source_item_id) DO NOTHING
        """, new { c = claimId, p = partyId, i = sourceItemId, reason, at = at.ToUniversalTime() }) == 1;

    public sealed record ReturnedItem(Guid Id, Guid ClaimId, Guid BenefitLineId, Guid? DecisionId, Guid PayeePartyId, string Basis, decimal Principal, decimal Interest,
                                      string Currency, string ReturnCode);

    /// <summary>The payee's returned items on the claim that have no replacement yet, locked.</summary>
    public Task<List<ReturnedItem>> LockReturnedWithoutReplacementAsync(Guid claimId, Guid partyId) => db.QueryAsync("""
        SELECT pi.id, pi.claim_id, pi.benefit_line_id, pi.decision_id, pi.payee_party_id, pi.basis, pi.principal_amount, pi.interest_amount, pi.currency,
               COALESCE(pi.return_code, '') AS return_code
        FROM payment_items pi
        WHERE pi.claim_id = @c AND pi.payee_party_id = @p AND pi.status = 'returned'
          AND NOT EXISTS (SELECT 1 FROM payment_items r WHERE r.replacement_of_id = pi.id)
        ORDER BY pi.created_at, pi.id
        FOR UPDATE OF pi
        """, new { c = claimId, p = partyId },
        r => new ReturnedItem(r.Guid("id"), r.Guid("claim_id"), r.Guid("benefit_line_id"), r.GuidOrNull("decision_id"), r.Guid("payee_party_id"), r.Text("basis"),
            r.Decimal("principal_amount"), r.Decimal("interest_amount"), r.Text("currency"), r.Text("return_code")));

    public sealed record NewReplacement(ReturnedItem Of, Guid MethodId, DateOnly PayOn, string Basis);

    /// <summary>
    /// A NEW item for the same decision, line and payee, the same principal and interest (interest stopped at the first payment date), cleared for the next run and
    /// linked to the returned item it replaces. The returned item is never edited. Once per returned item: the unique index on replacement_of_id stops a second.
    /// </summary>
    public Task<Guid> InsertReplacementAsync(NewReplacement n) => db.SingleAsync<Guid>("""
        INSERT INTO payment_items (claim_id, benefit_line_id, decision_id, payee_party_id, basis, principal_amount, interest_amount, currency, method, pay_on, status,
                                   replacement_of_id, payment_method_id)
        VALUES (@claim, @line, @decision, @payee, @basis, @principal, @interest, @currency, 'eft', @payOn, 'cleared', @of, @method)
        RETURNING id
        """, new
    {
        claim = n.Of.ClaimId,
        line = n.Of.BenefitLineId,
        decision = n.Of.DecisionId,
        payee = n.Of.PayeePartyId,
        basis = n.Basis,
        principal = n.Of.Principal,
        interest = n.Of.Interest,
        currency = n.Of.Currency,
        payOn = n.PayOn,
        of = n.Of.Id,
        method = n.MethodId,
    });

    public Task<Guid> InsertPaymentMethodAsync(Guid claimId, Guid partyId, string routingLast4, string accountLast4, string? holder, DateTimeOffset at) => db.SingleAsync<Guid>("""
        INSERT INTO payment_methods (claim_id, party_id, routing_last4, account_last4, holder_name, created_at) VALUES (@c, @p, @r, @a, @h, @at) RETURNING id
        """, new { c = claimId, p = partyId, r = routingLast4, a = accountLast4, h = holder, at = at.ToUniversalTime() });

    public Task<int> SupersedeHoldsAsync(Guid claimId, Guid partyId, Guid methodId) => db.ExecuteAsync(
        "UPDATE payment_method_holds SET superseded_by_method_id = @m, updated_at = now() WHERE claim_id = @c AND party_id = @p AND superseded_by_method_id IS NULL",
        new { c = claimId, p = partyId, m = methodId });

    public sealed record MethodRow(Guid Id, Guid ClaimId, Guid PartyId, string Status, string RoutingLast4, string AccountLast4, string? HolderName);

    public Task<MethodRow?> FindMethodAsync(Guid id) => db.QueryOptionalAsync(
        "SELECT id, claim_id, party_id, status, routing_last4, account_last4, holder_name FROM payment_methods WHERE id = @id", new { id },
        r => new MethodRow(r.Guid("id"), r.Guid("claim_id"), r.Guid("party_id"), r.Text("status"), r.Text("routing_last4"), r.Text("account_last4"), r.Str("holder_name")));

    public async Task<bool> SetMethodStatusAsync(Guid id, string status, DateTimeOffset now) => await db.ExecuteAsync(
        "UPDATE payment_methods SET status = @status, verified_at = CASE WHEN @status = 'verified' THEN @now ELSE NULL END WHERE id = @id AND status = 'pending_verification'",
        new { id, status, now = now.ToUniversalTime() }) == 1;

    /// <summary>Items still `cleared` that pay to this method: holding them stops them going in a run (an item already in a run cannot be stopped).</summary>
    public Task<List<Guid>> HoldClearedForMethodAsync(Guid methodId, string reason) => db.ListAsync<Guid>(
        "UPDATE payment_items SET status = 'held', hold_reason = @reason WHERE payment_method_id = @m AND status = 'cleared' RETURNING id", new { m = methodId, reason });

    public Task<List<Guid>> ItemsOfMethodAsync(Guid methodId) => db.ListAsync<Guid>("SELECT id FROM payment_items WHERE payment_method_id = @m ORDER BY created_at, id", new { m = methodId });
}
