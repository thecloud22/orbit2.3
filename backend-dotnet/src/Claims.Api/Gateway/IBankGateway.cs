namespace Claims.Gateway;

/// <summary>One payment in the file sent to the bank. <c>IdempotencyKey</c> is the payment item id: sending it twice must not pay twice.</summary>
public sealed record BankPayment(Guid ItemId, string IdempotencyKey, string Payee, decimal Amount, string Currency, string Method);

public sealed record BankFile(Guid RunId, DateOnly RunDate, IReadOnlyList<BankPayment> Payments);

/// <param name="Accepted">The bank took it. False: the bank returned it (<c>ReturnCode</c>, for example R02 account closed).</param>
public sealed record BankPaymentResult(Guid ItemId, bool Accepted, string? PaymentReference, string? ReturnCode, string? ReturnReason);

public sealed record BankFileResult(string FileReference, IReadOnlyList<BankPaymentResult> Payments);

/// <summary>
/// A payment the bank returned AFTER accepting it (its returns file, days later). <c>ItemId</c> is the idempotency key the payment was sent with.
/// <c>ReturnId</c> identifies the line, so it can be acknowledged once it has been processed.
/// </summary>
public sealed record BankReturn(Guid ReturnId, Guid ItemId, string ReasonCode, string? ReasonText, DateTimeOffset QueuedAt);

/// <summary>
/// The account a payee gave. Claims keeps only the last 4 digits of the routing and account numbers, so that is what the stub gets; a real client would pass a
/// token for the full numbers held in a vault.
/// </summary>
public sealed record BankAccount(string PayeeName, string RoutingLast4, string AccountLast4);

public sealed record AccountVerification(bool Verified, string Reference, string Detail);

/// <summary>The bank cannot be reached: the whole file was not sent. The payment run releases its items and records the failure.</summary>
public sealed class BankUnavailableException(string message) : Exception(message);

/// <summary>
/// The bank (ACH/EFT and check files). The payment run sends files; the returns batch reads what came back afterwards; a workflow verifies an
/// account a payee gave. A real implementation sends the file and reads the acknowledgement.
/// </summary>
public interface IBankGateway
{
    Task<BankFileResult> SendPaymentFileAsync(BankFile file, CancellationToken cancellationToken = default);

    /// <summary>
    /// The returns file: payments the bank took and then returned (R-codes). Reading does not remove them: call <see cref="AcknowledgeReturnsAsync"/> once
    /// they are saved, so a crash in between re-reads them (processing is idempotent) instead of losing them.
    /// </summary>
    Task<IReadOnlyList<BankReturn>> ReadReturnsAsync(CancellationToken cancellationToken = default);

    Task AcknowledgeReturnsAsync(IEnumerable<Guid> returnIds, CancellationToken cancellationToken = default);

    /// <summary>Is the account open, and does the name match? An answer, not an error; throws only when the bank cannot be reached.</summary>
    Task<AccountVerification> VerifyAccountAsync(BankAccount account, CancellationToken cancellationToken = default);
}
