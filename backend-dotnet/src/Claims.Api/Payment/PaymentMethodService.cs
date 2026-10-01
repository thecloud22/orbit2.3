using System.Globalization;
using System.Security.Cryptography;
using System.Text;
using Claims.Clock;
using Claims.Common;
using Claims.Domain;
using Claims.Intake;
using Claims.Store;
using Claims.View;
using static Claims.Store.DeadlineRepository;

namespace Claims.Payment;

public sealed record UpdatePaymentMethodRequest(string? Kind, string? RoutingNumber, string? AccountNumber, string? HolderName);

/// <summary>
/// A payee whose payment came back gives a new account. ONE transaction, saved before any workflow:
///
///   * the method is stored (only the last 4 digits of the routing and account numbers are kept), and the payee's hold on the closed account records which method replaced it,
///   * the row waiting for the payee's new details closes without ever firing,
///   * the REPLACEMENT item is created: a new item linked by <c>replacement_of_id</c>, the same principal and interest as the returned one (interest stopped at the first
///     payment date, because the return came from the payee's closed account: an example rule), `cleared` for the next business day's run,
///   * the "reissue a returned payment" target row (2 business days) is written, the examiner's "payment returned" work item closes, history is appended,
///   * an outbox event `payment_method_updated` is written.
///
/// The next payment run pays the replacement and closes the claim again. The workflow the event starts verifies the account and confirms to the payee.
/// </summary>
public sealed class PaymentMethodService(Db db, IClock clock, BusinessCalendar calendar, PaymentRepository payments, DeadlineRepository deadlines, HistoryRepository history,
                                         WorkItemRepository workItems, OutboxRepository outbox, IdempotencyRepository keys, ClaimQueries queries)
{
    public const int ReissueBusinessDays = 2;

    public sealed record Outcome(PaymentMethodUpdatedView Result, bool Replayed);

    public async Task<Outcome> UpdateAsync(Guid claimId, Guid partyId, UpdatePaymentMethodRequest r, string idempotencyKey, string actorName)
    {
        var errors = new List<FieldError>();
        if (r.Kind != "eft") errors.Add(new FieldError("kind", "must be eft"));
        var routing = r.RoutingNumber?.Trim() ?? "";
        var account = r.AccountNumber?.Trim() ?? "";
        if (routing.Length != 9 || !routing.All(char.IsAsciiDigit)) errors.Add(new FieldError("routingNumber", "must be 9 digits"));
        if (account.Length is < 4 or > 17 || !account.All(char.IsAsciiDigit)) errors.Add(new FieldError("accountNumber", "must be 4 to 17 digits"));
        if (errors.Count > 0) throw new ApiException(422, "validation_failed", "The request is well formed but not valid", errors);
        if (idempotencyKey.Length is < 8 or > 128) throw ApiException.BadRequest("invalid_idempotency_key", "Idempotency-Key must be 8 to 128 characters");

        return await db.InTransactionAsync(async () =>
        {
            var scope = "payment-method:" + claimId + ":" + partyId;
            // The hash keeps the key in it so the stored value cannot be used to guess an account number without it.
            var hash = Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes($"{idempotencyKey}|{claimId}|{partyId}|{routing}|{account}|{r.HolderName?.Trim()}")));
            await keys.LockAsync(scope, idempotencyKey);
            if (await keys.FindAsync(scope, idempotencyKey) is { } seen)
            {
                if (seen.Hash != hash) throw ApiException.Conflict("idempotency_key_reuse", "This Idempotency-Key was already used with a different request body");
                return new Outcome(await ResultAsync(seen.ResourceId!.Value), true);
            }

            var claim = await db.QueryOptionalAsync("SELECT owner_id FROM claims WHERE id = @c", new { c = claimId }, x => new ClaimOwner(x.GuidOrNull("owner_id"))) ?? throw ApiException.NotFound("Claim", claimId);
            var name = await db.SingleOrDefaultAsync<string>(
                "SELECT p.full_name FROM claim_parties cp JOIN parties p ON p.id = cp.party_id WHERE cp.claim_id = @c AND cp.party_id = @p AND cp.role = 'beneficiary' AND cp.payee LIMIT 1",
                new { c = claimId, p = partyId }) ?? throw ApiException.NotFound("Payee", partyId);
            await payments.LockClaimsAsync([claimId]);
            var returned = await payments.LockReturnedWithoutReplacementAsync(claimId, partyId);
            if (returned.Count == 0)
                throw ApiException.Conflict("no_returned_payment", $"{name} has no returned payment waiting for a replacement on this claim");

            var now = clock.UtcNow;
            var first = LifeIntakeRules.First(name);
            var methodId = await payments.InsertPaymentMethodAsync(claimId, partyId, routing[^4..], account[^4..], string.IsNullOrWhiteSpace(r.HolderName) ? name : r.HolderName.Trim(), now);
            await payments.SupersedeHoldsAsync(claimId, partyId, methodId);
            var closed = await deadlines.CloseLiveBankDetailsAsync(claimId, partyId, $"Closed: {first}'s new account was added {calendar.LocalDate(now).ToString("d MMM", CultureInfo.InvariantCulture)}; never had to fire", now);
            var payOn = BusinessCalendar.AddBusinessDays(calendar.LocalDate(now), PaymentRules.PayBusinessDaysAfterDecision);
            var replacementIds = new List<Guid>();
            foreach (var item in returned)
            {
                var basis = $"Replacement for the payment returned by the bank ({item.ReturnCode}): {item.Basis}";
                replacementIds.Add(await payments.InsertReplacementAsync(new PaymentRepository.NewReplacement(item, methodId, payOn, basis)));
                await workItems.CompleteByKeyAsync("payment-returned:" + item.Id, now);
            }
            var reissueDue = calendar.BusinessDaysAfter(now, ReissueBusinessDays);
            var reissue = await deadlines.InsertAsync(new NewDeadline(claimId, DeadlineKind.PaymentDue, null, $"Pay {first}'s replacement", "reissue", reissueDue, null, partyId));
            var total = returned.Sum(i => i.Principal + i.Interest);
            await history.AppendAsync(claimId, now, "payment", $"New bank account added: {name}", Actor.User(actorName),
                $"Account ending {account[^4..]} · replacement of {PaymentRules.Usd(total)} cleared for the {payOn.ToString("ddd d MMM", CultureInfo.InvariantCulture)} run"
                + (closed.Count > 0 ? $" · {closed.Count} row closed without firing" : "") + $" · reissue target row {reissue}", methodId.ToString(), null);
            await outbox.InsertAsync(claimId, "payment_method_updated", Json.Serialize(new
            {
                claimId = claimId.ToString(),
                paymentMethodId = methodId.ToString(),
                payeePartyId = partyId.ToString(),
                replacementItemIds = replacementIds.Select(x => x.ToString()).ToList(),
            }));
            await keys.InsertAsync(scope, idempotencyKey, hash, claimId, methodId);
            _ = claim;
            return new Outcome(await ResultAsync(methodId), false);
        });
    }

    private sealed record ClaimOwner(Guid? OwnerId);

    private async Task<PaymentMethodUpdatedView> ResultAsync(Guid methodId)
    {
        var method = (await queries.PaymentMethodAsync(methodId))!;
        var items = new List<PaymentItemView>();
        foreach (var id in await payments.ItemsOfMethodAsync(methodId)) items.Add((await queries.PaymentItemAsync(id))!);
        var reissue = (await queries.DeadlinesAsync(method.ClaimId)).Where(d => d.Kind == "payment_due" && d.Sla == "reissue" && d.PartyId == method.PartyId)
            .OrderByDescending(d => d.DueAt).FirstOrDefault();
        return new PaymentMethodUpdatedView(method, items, reissue);
    }
}
