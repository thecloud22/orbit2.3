using Claims.Clock;
using System.Globalization;
using System.Security.Cryptography;
using System.Text;
using Claims.Common;
using Claims.Domain;
using Claims.Store;
using Claims.View;
using static Claims.Intake.LifeIntakeRules;
using static Claims.Store.DeadlineRepository;

namespace Claims.Intake;

/// <summary>
/// The synchronous half of life intake. ONE transaction saves the claim, its parties, policy snapshot, benefit lines, requirements,
/// the first deadline rows, history and an outbox event, then returns. No workflow runs here: the outbox relay starts
/// <c>orch-&lt;claim&gt;-intake</c> after the commit, and that workflow does everything that talks to another system.
/// (The mock does all of it inline.)
/// </summary>
public sealed class LifeIntakeService(Db db, ClaimQueries queries, DeadlineRepository deadlines, HistoryRepository history,
                                      OutboxRepository outbox, BusinessCalendar calendar, IClock clock)
{
    public sealed record Result(ClaimView Claim, bool Replayed);

    private sealed record Seen(string Hash, Guid ClaimId);

    private sealed record PolicyRow(Guid Id, PolicyClaimed P);

    public Task<Result> SubmitAsync(LifeIntakeRequest r, string idempotencyKey, Actor actor) => db.InTransactionAsync(async () =>
    {
        var scope = "life-intake:" + actor.Name;
        var hash = Hash(r);

        // Serialise concurrent requests with the same key, then replay or reject a repeat.
        await db.SingleAsync<int>("SELECT 1 FROM (SELECT pg_advisory_xact_lock(hashtextextended(@k, 0))) AS locked",
            new { k = scope + "|" + idempotencyKey });
        var seen = await db.QueryOptionalAsync("SELECT request_hash, claim_id FROM idempotency_keys WHERE scope = @s AND key = @k",
            new { s = scope, k = idempotencyKey }, x => new Seen(x.Text("request_hash"), x.Guid("claim_id")));
        if (seen is not null)
        {
            if (seen.Hash != hash)
                throw ApiException.Conflict("idempotency_key_reuse", "This Idempotency-Key was already used with a different request body");
            return new Result((await queries.ClaimAsync(seen.ClaimId))!, true);
        }

        var now = clock.UtcNow;
        var noticeAt = r.NoticeReceivedAt?.ToUniversalTime() ?? now;
        Validate(r, noticeAt);

        var payees = PayeesOf(r.Designation.Beneficiaries);
        var insured = r.Insured;

        // ---- parties
        var insuredId = await PartyAsync("person", insured.Name, insured.DateOfBirth, r.Death.DateOfDeath, null, insured.SsnLast4, null, null, null);
        var beneficiaryParty = new Dictionary<string, Guid>();
        foreach (var b in r.Designation.Beneficiaries)
        {
            var c = b.Contact;
            beneficiaryParty[b.Ref] = await PartyAsync("person", b.Name, b.DateOfBirth, b.DiedOn, b.DiedSource, null, c?.Email, c?.Phone, c?.Address);
        }
        var caller = r.Caller;
        var callerId = caller.BeneficiaryRef is not null
            ? beneficiaryParty[caller.BeneficiaryRef]
            : await PartyAsync("person", caller.Name, null, null, null, null, caller.Email, caller.Phone, null);

        // ---- policy snapshot
        var policies = new List<PolicyRow>();
        foreach (var p in r.Policies) policies.Add(new PolicyRow(await UpsertPolicyAsync(p, now), p));

        // ---- claim
        var seq = await db.SingleAsync<long>("SELECT nextval('claim_number_seq')");
        var year = TimeZoneInfo.ConvertTime(noticeAt, calendar.Zone).Year;
        var claimNumber = string.Create(CultureInfo.InvariantCulture, $"L-{year % 100:D2}-{seq:D6}");
        var claimId = await db.SingleAsync<Guid>("""
            INSERT INTO claims (claim_number, family, product_code, insured_party_id, status, noticed_at, created_by)
            VALUES (@n, 'life', @product, @insured, 'received', @noticed, @by) RETURNING id
            """, new { n = claimNumber, product = policies[0].P.ProductCode, insured = insuredId, noticed = noticeAt, by = actor.Kind + ":" + actor.Name });

        var d = r.Death;
        await db.ExecuteAsync("""
            INSERT INTO life_claim_details (claim_id, date_of_death, place_of_death, manner_of_death, death_outside_us, funeral_home,
                caller_party_id, caller_relationship, contact_by, identity_verified, agent_consent, other_claimants_possible)
            VALUES (@c, @dod, @place, @manner, @outside, @fh, @caller, @rel, cast(@contact as text[]), true, @consent, @others)
            """, new
        {
            c = claimId,
            dod = d.Date,
            place = d.PlaceOfDeath,
            manner = d.Manner,
            outside = d.OutsideUs,
            fh = BlankToNull(d.FuneralHome),
            caller = callerId,
            rel = caller.Relationship,
            contact = Db.ArrayLiteral(caller.ContactBy.Distinct()),
            consent = caller.AgentConsent,
            others = r.OtherClaimantsPossible,
        });

        // ---- who is on the claim
        await ClaimPartyAsync(claimId, insuredId, "insured", "Insured", null, null, false, null, null, "Died " + Iso(d.Date));
        await ClaimPartyAsync(claimId, insuredId, "owner", "Owner", null, null, false, null, null, null);
        await ClaimPartyAsync(claimId, callerId, "caller", caller.Relationship, null, null, false, null, null, null);
        foreach (var b in r.Designation.Beneficiaries)
        {
            var payee = payees.Members.Contains(b);
            var status = b.DiedOn is not null ? "died " + Iso(b.DiedOn.Value) : payee ? "packet_sent_pending" : null;
            await ClaimPartyAsync(claimId, beneficiaryParty[b.Ref], "beneficiary", b.Relationship, b.Kind, b.Share, payee,
                b.Contact?.Packet, b.DiedSource, status);
            if (payee && b.Ref == caller.BeneficiaryRef)
                await ClaimPartyAsync(claimId, beneficiaryParty[b.Ref], "claimant", b.Relationship, null, null, false, null, null, null);
        }
        if (r.Agent is not null)
        {
            var agentId = await PartyAsync("person", r.Agent.Name, null, null, null, null, null, null, null);
            await ClaimPartyAsync(claimId, agentId, "agent_of_record", "Agent of record", null, null, false, null,
                caller.AgentConsent ? "Status only, with the caller's consent" : "None: caller declined", r.Agent.Agency);
        }
        if (!string.IsNullOrWhiteSpace(d.FuneralHome))
        {
            var fh = await PartyAsync("organisation", d.FuneralHome.Split(',')[0].Trim(), null, null, null, null, null, null, null);
            await ClaimPartyAsync(claimId, fh, "funeral_home", null, null, null, false, null, "No assignment filed", null);
        }

        // ---- benefit lines: the base coverage and each rider as its own line
        Guid? firstBase = null;
        Guid? firstRiderLine = null;
        foreach (var pr in policies)
        {
            var p = pr.P;
            var baseId = await InsertBenefitLineAsync(claimId, pr.Id, "base", null, null, p.ProductName, p.FaceAmount.Amount, p.FaceAmount.Currency,
                "gathering_evidence", "Death certificate · claimant statements");
            firstBase ??= baseId;
            foreach (var rd in p.Riders ?? [])
            {
                var status = d.Manner switch
                {
                    "accident" => "gathering_evidence",
                    "pending" => "cause_pending",
                    _ => "not_payable",
                };
                var riderLine = await InsertBenefitLineAsync(claimId, pr.Id, "rider", baseId, rd.Key, rd.Name, rd.Amount.Amount,
                    rd.Amount.Currency, status, status == "gathering_evidence" ? "Report" : status == "cause_pending" ? "Medical examiner" : null);
                firstRiderLine ??= riderLine;
            }
        }

        // ---- requirements (one row each) and the first deadlines
        var plan = RequirementSet(r);
        var reqIds = new Guid[plan.Count];
        for (var i = 0; i < plan.Count; i++)
        {
            var q = plan[i];
            var line = q.ForRider && firstRiderLine is not null ? firstRiderLine : firstBase;
            Guid? fromParty = q.BeneficiaryRef is not null ? beneficiaryParty[q.BeneficiaryRef] : q.Key == RequirementKey.Certificate ? callerId : null;
            reqIds[i] = await db.SingleAsync<Guid>("""
                INSERT INTO requirements (claim_id, benefit_line_id, key, name, purpose, from_party_id, from_label, from_detail, state,
                                          requested_at, follow_up_days, accepted_at, received_at, satisfied_by)
                VALUES (@c, @line, @key, @name, @purpose, @fromParty, @label, @detail, @state, @at, @days, @accepted, @accepted, @by)
                RETURNING id
                """, new
            {
                c = claimId,
                line,
                key = q.Key.Db(),
                name = q.Name,
                purpose = q.Purpose,
                fromParty,
                label = q.FromLabel,
                detail = q.FromDetail,
                state = q.IsOnFile ? "accepted" : "requested",
                at = noticeAt,
                days = q.FollowUpDays,
                accepted = q.IsOnFile ? noticeAt : (DateTimeOffset?)null,
                by = q.OnFile,
            });
        }
        foreach (var pd in FirstDeadlines(r, plan, noticeAt, calendar))
        {
            await deadlines.InsertAsync(new NewDeadline(claimId, pd.Kind, pd.RequirementIndex >= 0 ? reqIds[pd.RequirementIndex] : null, pd.What, pd.Sla, pd.DueAt));
        }

        // ---- history and the outbox event, same transaction
        var first = First(insured.Name);
        await history.AppendAsync(claimId, noticeAt, "access", "Caller confirmed " + first + "'s date of birth and policy number", actor,
            "Caller: " + caller.Name, null, null);
        await history.AppendAsync(claimId, noticeAt, "data", "Notice of death saved · event to the outbox", actor,
            "Died " + Iso(d.Date) + " · " + d.Manner, null, null);
        await outbox.InsertAsync(claimId, "notice_of_death_received", Json.Serialize(new { claimId = claimId.ToString(), claimNumber }));

        await db.ExecuteAsync("INSERT INTO idempotency_keys (scope, key, request_hash, claim_id) VALUES (@s, @k, @h, @c)",
            new { s = scope, k = idempotencyKey, h = hash, c = claimId });

        return new Result((await queries.ClaimAsync(claimId))!, false);
    });

    // ------------------------------------------------------------------ validation

    private void Validate(LifeIntakeRequest r, DateTimeOffset noticeAt)
    {
        var c = r.Caller;
        if (!c.VerifiedDateOfBirth || !c.VerifiedPolicyNumber)
            throw ApiException.Unprocessable("identity_not_verified", "The caller's date of birth and policy number must both be confirmed before submit");
        if (r.Death.Date > calendar.LocalDate(noticeAt))
            throw ApiException.Unprocessable("date_of_death_in_future", "The date of death is after the notice date");
        var refs = new HashSet<string>();
        foreach (var b in r.Designation.Beneficiaries)
        {
            if (!refs.Add(b.Ref)) throw ApiException.Unprocessable("duplicate_beneficiary_ref", "Beneficiary ref " + b.Ref + " is used twice");
        }
        if (c.BeneficiaryRef is not null && !refs.Contains(c.BeneficiaryRef))
            throw ApiException.Unprocessable("unknown_beneficiary_ref", "caller.beneficiaryRef does not match a designated beneficiary");
        var payees = PayeesOf(r.Designation.Beneficiaries).Members;
        if (payees.Count == 0)
            throw ApiException.Unprocessable("no_payees", "No living beneficiary is designated; this needs a person to look at it");
        var shares = payees.Sum(b => b.Share);
        if (shares != 100m)
            throw ApiException.Unprocessable("payee_shares_invalid",
                "The payees' shares add up to " + shares.ToString("0.############################", CultureInfo.InvariantCulture) + "%, not 100%");
        foreach (var p in r.Policies)
        {
            if (p.InForce != (p.LapsedOn is null))
                throw ApiException.Unprocessable("policy_lapse_inconsistent", "Policy " + p.PolicyNumber + ": inForce and lapsedOn disagree");
            var usd = p.FaceAmount.Currency == "USD" && (p.Riders is null || p.Riders.All(x => x.Amount.Currency == "USD"));
            if (!usd) throw ApiException.Unprocessable("currency_not_supported", "Only USD is supported");
        }
    }

    // ------------------------------------------------------------------ inserts

    private Task<Guid> PartyAsync(string kind, string name, DateOnly? dob, DateOnly? died, string? deathSource, string? ssn,
                                  string? email, string? phone, string? address) => db.SingleAsync<Guid>("""
        INSERT INTO parties (kind, full_name, date_of_birth, date_of_death, death_source, ssn_last4, email, phone, address)
        VALUES (@kind, @name, @dob, @died, @src, @ssn, @email, @phone, @address) RETURNING id
        """, new { kind, name, dob, died, src = deathSource, ssn, email = BlankToNull(email), phone = BlankToNull(phone), address = BlankToNull(address) });

    private Task<int> ClaimPartyAsync(Guid claimId, Guid partyId, string role, string? relationship, string? beneficiaryKind, decimal? share,
                                      bool payee, string? packet, string? accessNote, string? status) => db.ExecuteAsync("""
        INSERT INTO claim_parties (claim_id, party_id, role, relationship, beneficiary_kind, share_percent, payee, packet_channel, access_note, status)
        VALUES (@c, @p, @role, @rel, @kind, @share, @payee, @packet, @note, @status)
        ON CONFLICT DO NOTHING
        """, new { c = claimId, p = partyId, role, rel = relationship, kind = beneficiaryKind, share, payee, packet, note = accessNote, status });

    private async Task<Guid> UpsertPolicyAsync(PolicyClaimed p, DateTimeOffset now)
    {
        var id = await db.SingleAsync<Guid>("""
            INSERT INTO policies (policy_number, family, product_code, product_name, issue_date, paid_to_date, in_force, lapsed_on, face_amount, currency, as_of)
            VALUES (@num, 'life', @code, @name, @issue, @paid, @inforce, @lapsed, @face, @cur, @now)
            ON CONFLICT (policy_number) DO UPDATE SET product_code = EXCLUDED.product_code, product_name = EXCLUDED.product_name,
                issue_date = EXCLUDED.issue_date, paid_to_date = EXCLUDED.paid_to_date, in_force = EXCLUDED.in_force,
                lapsed_on = EXCLUDED.lapsed_on, face_amount = EXCLUDED.face_amount, as_of = EXCLUDED.as_of
            RETURNING id
            """, new
        {
            num = p.PolicyNumber,
            code = p.ProductCode,
            name = p.ProductName,
            issue = p.IssueDate,
            paid = p.PaidToDate,
            inforce = p.InForce,
            lapsed = p.LapsedOn,
            face = Amount(p.FaceAmount.Amount),
            cur = p.FaceAmount.Currency,
            now,
        });
        foreach (var rd in p.Riders ?? [])
        {
            await db.ExecuteAsync("""
                INSERT INTO policy_riders (policy_id, rider_key, name, amount) VALUES (@p, @k, @n, @a)
                ON CONFLICT (policy_id, rider_key) DO UPDATE SET name = EXCLUDED.name, amount = EXCLUDED.amount
                """, new { p = id, k = rd.Key, n = rd.Name, a = Amount(rd.Amount.Amount) });
        }
        return id;
    }

    private Task<Guid> InsertBenefitLineAsync(Guid claimId, Guid policyId, string kind, Guid? parent, string? riderKey, string name, string amount,
                                              string currency, string status, string? waitingOn) => db.SingleAsync<Guid>("""
        INSERT INTO benefit_lines (claim_id, policy_id, kind, parent_line_id, rider_key, name, amount, currency, status, waiting_on, product_config_version)
        VALUES (@c, @pol, @kind, @parent, @rk, @name, @amount, @cur, @status, @waiting, @ver) RETURNING id
        """, new
    {
        c = claimId,
        pol = policyId,
        kind,
        parent,
        rk = riderKey,
        name,
        amount = Amount(amount),
        cur = currency,
        status,
        waiting = waitingOn,
        ver = ProductConfigVersion,
    });

    private static decimal Amount(string amount) => decimal.Parse(amount, NumberStyles.AllowDecimalPoint, CultureInfo.InvariantCulture);

    private static string? BlankToNull(string? s) => string.IsNullOrWhiteSpace(s) ? null : s;

    private static string Iso(DateOnly d) => d.ToString("yyyy-MM-dd", CultureInfo.InvariantCulture);

    /// <summary>SHA-256 of the canonical JSON of the request, so the same content with reordered keys or whitespace is the same request.
    /// The set-like contactBy is sorted first.</summary>
    private static string Hash(LifeIntakeRequest r)
    {
        var canonical = r with { Caller = r.Caller with { ContactBy = r.Caller.ContactBy.Distinct().Order(StringComparer.Ordinal).ToList() } };
        return Convert.ToHexStringLower(SHA256.HashData(Encoding.UTF8.GetBytes(Json.Serialize(canonical))));
    }
}
