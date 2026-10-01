using System.Collections.Concurrent;
using System.Security.Cryptography;
using System.Text;

namespace Claims.Gateway;

/// <summary>
/// STUB. "Pays" every payment at once and records a payment reference, and remembers what it was sent so tests can look. It can be told to
/// misbehave: <see cref="RejectItem"/> makes the bank return one item, and the faults <c>bank.down</c> and <c>bank.reject-next</c> do it from
/// configuration (see <see cref="IFaultRegistry"/>).
/// </summary>
public sealed partial class StubBankGateway(IFaultRegistry faults, ILogger<StubBankGateway> log) : IBankGateway
{
    private readonly ConcurrentDictionary<Guid, (string Code, string Reason)> rejections = new();

    public ConcurrentQueue<BankFile> SentFiles { get; } = new();

    /// <summary>The next time this item is sent the bank returns it.</summary>
    public void RejectItem(Guid itemId, string code = "R02", string reason = "Account closed") => rejections[itemId] = (code, reason);

    public Task<BankFileResult> SendPaymentFileAsync(BankFile file, CancellationToken cancellationToken = default)
    {
        if (faults.IsOn(FaultCatalog.BankDown)) throw new BankUnavailableException("The bank's file endpoint is unreachable (fault bank.down)");
        SentFiles.Enqueue(file);
        var rejectFirst = file.Payments.Count > 0 && faults.TryConsume(FaultCatalog.BankRejectNext);
        var results = new List<BankPaymentResult>();
        for (var i = 0; i < file.Payments.Count; i++)
        {
            var p = file.Payments[i];
            if (rejections.TryRemove(p.ItemId, out var r)) results.Add(new BankPaymentResult(p.ItemId, false, null, r.Code, r.Reason));
            else if (rejectFirst && i == 0) results.Add(new BankPaymentResult(p.ItemId, false, null, "R02", "Account closed"));
            else results.Add(new BankPaymentResult(p.ItemId, true, Reference(p), null, null));
        }
        var fileReference = "STUB-FILE-" + file.RunDate.ToString("yyyyMMdd", System.Globalization.CultureInfo.InvariantCulture) + "-" + file.RunId.ToString()[..8];
        LogSent(fileReference, file.Payments.Count, results.Count(x => !x.Accepted));
        return Task.FromResult(new BankFileResult(fileReference, results));
    }

    // ------------------------------------------------------------------ the returns queue (the stub's stand-in for the bank's returns file)

    private readonly List<BankReturn> returnQueue = [];
    private readonly object returnGate = new();

    /// <summary>The bank's returns file gains a line (Development only: <c>POST /dev/bank/returns</c>; tests call it directly).</summary>
    public BankReturn EnqueueReturn(Guid itemId, string code, string? reason, DateTimeOffset at)
    {
        var r = new BankReturn(Guid.CreateVersion7(), itemId, code, reason, at);
        lock (returnGate) returnQueue.Add(r);
        return r;
    }

    public IReadOnlyList<BankReturn> Queue
    {
        get { lock (returnGate) return [.. returnQueue]; }
    }

    public Task<IReadOnlyList<BankReturn>> ReadReturnsAsync(CancellationToken cancellationToken = default)
    {
        if (faults.IsOn(FaultCatalog.BankDown)) throw new BankUnavailableException("The bank's returns endpoint is unreachable (fault bank.down)");
        lock (returnGate) return Task.FromResult<IReadOnlyList<BankReturn>>([.. returnQueue]);
    }

    public Task AcknowledgeReturnsAsync(IEnumerable<Guid> returnIds, CancellationToken cancellationToken = default)
    {
        var ids = returnIds.ToHashSet();
        lock (returnGate) returnQueue.RemoveAll(r => ids.Contains(r.ReturnId));
        return Task.CompletedTask;
    }

    /// <summary>STUB. An account whose number ends 0000 is "closed"; everything else verifies. (Claims keeps only the last 4 digits.)</summary>
    public Task<AccountVerification> VerifyAccountAsync(BankAccount account, CancellationToken cancellationToken = default)
    {
        if (faults.IsOn(FaultCatalog.BankDown)) throw new BankUnavailableException("The bank's verification endpoint is unreachable (fault bank.down)");
        var ok = account.AccountLast4 != "0000";
        return Task.FromResult(new AccountVerification(ok, "verify-stub-" + Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(account.RoutingLast4 + account.AccountLast4)))[..8].ToLowerInvariant(),
            ok ? "Account open · name matches" : "Account closed or not found"));
    }

    private static string Reference(BankPayment p) =>
        (p.Method == "check" ? "STUB-CHK-" : "STUB-EFT-") + Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(p.IdempotencyKey)))[..10].ToLowerInvariant();

    [LoggerMessage(Level = LogLevel.Information, Message = "STUB bank file {File}: {Count} payments, {Returned} returned")]
    private partial void LogSent(string file, int count, int returned);
}
