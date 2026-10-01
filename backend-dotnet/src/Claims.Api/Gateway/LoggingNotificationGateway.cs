using System.Security.Cryptography;
using System.Text;

namespace Claims.Gateway;

/// <summary>STUB. Logs instead of sending. The fault <c>letters.down</c> makes it throw, as an unreachable provider would.</summary>
public sealed partial class LoggingNotificationGateway(IFaultRegistry faults, ILogger<LoggingNotificationGateway> log) : INotificationGateway
{
    public Task<string> SendAsync(NotificationMessage m)
    {
        if (faults.Trigger(FaultCatalog.LettersDown)) throw new InvalidOperationException("The letters service returned 503 (fault letters.down)");
        LogSend(m.Channel, m.TemplateCode, m.To, m.Subject, m.IdempotencyKey);
        return Task.FromResult("stub-msg-" + Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(m.IdempotencyKey)))[..8].ToLowerInvariant());
    }

    [LoggerMessage(Level = LogLevel.Information, Message = "STUB send {Channel} {Template} to {To} [{Subject}] key={Key}")]
    private partial void LogSend(string channel, string template, string to, string subject, string key);
}
