using Claims.Clock;
using Claims.Gateway;
using Claims.Store;

namespace Claims.Store;

/// <summary>
/// Sends a letter at most once per dedupe key, however many times the caller (an activity being retried, a
/// workflow started twice) runs it: insert-if-absent, send, mark sent. If the process dies between the send
/// and the mark, the retry sends again with the same idempotency key, and the provider drops the repeat.
/// Deliberately not in one DB transaction: no transaction should stay open across a call to another system.
/// </summary>
public sealed class LetterService(LetterRepository letters, INotificationGateway gateway, IClock clock)
{
    /// <summary>Returns the letter id.</summary>
    public async Task<Guid> SendOnceAsync(LetterRepository.NewLetter l, string to)
    {
        var id = await letters.InsertQueuedAsync(l with { CreatedAt = l.CreatedAt ?? clock.UtcNow });   // business time, so a letter's dates agree with the claim's
        if (id is null)
        {
            var existing = await letters.ByDedupeKeyAsync(l.DedupeKey);
            if (existing.Status is "sent" or "skipped") return existing.Id;   // a skipped letter was judged moot: a late repeat of the send must not resurrect it
            id = existing.Id;
        }
        var messageId = await gateway.SendAsync(new NotificationMessage(l.DedupeKey, l.Channel, to, l.TemplateCode, l.Subject));
        await letters.MarkSentAsync(id.Value, messageId, clock.UtcNow);
        return id.Value;
    }

    /// <summary>
    /// The situation changed and the letter with this key is moot: mark it `skipped` (with the reason) if it is still waiting. Idempotent, and it never touches a
    /// letter that was sent. Returns true when this call is the one that skipped it.
    /// </summary>
    public async Task<bool> SkipIfWaitingAsync(string dedupeKey, string reason) => await letters.MarkSkippedAsync(dedupeKey, reason) > 0;
}
