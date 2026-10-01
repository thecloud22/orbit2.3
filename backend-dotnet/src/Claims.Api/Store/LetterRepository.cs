using Claims.Common;

namespace Claims.Store;

public sealed class LetterRepository(Db db)
{
    public sealed record NewLetter(Guid ClaimId, string TemplateCode, string Channel, Guid? RecipientPartyId, string RecipientLabel,
                                   string Subject, string? Summary, string SourceKind, Guid? SourceId, string WorkflowId, string DedupeKey,
                                   DateTimeOffset? CreatedAt = null);

    public sealed record Row(Guid Id, string Status, string? ProviderMessageId);

    /// <summary>Inserts the letter as queued; returns null when a letter with this dedupe key already exists.</summary>
    public async Task<Guid?> InsertQueuedAsync(NewLetter l) => await db.SingleOrDefaultAsync<Guid?>("""
        INSERT INTO letters (claim_id, template_code, channel, recipient_party_id, recipient_label, subject, summary,
                             source_kind, source_id, workflow_id, dedupe_key, created_at)
        VALUES (@claim, @tpl, @channel, @party, @label, @subject, @summary, @sk, @sid, @wf, @key, COALESCE(@at, now()))
        ON CONFLICT (dedupe_key) DO NOTHING RETURNING id
        """, new
    {
        claim = l.ClaimId,
        tpl = l.TemplateCode,
        channel = l.Channel,
        party = l.RecipientPartyId,
        label = l.RecipientLabel,
        subject = l.Subject,
        summary = l.Summary,
        sk = l.SourceKind,
        sid = l.SourceId,
        wf = l.WorkflowId,
        key = l.DedupeKey,
        at = l.CreatedAt?.ToUniversalTime(),
    });

    /// <summary>The workflow that wrote the letter with this key, or null when there is none.</summary>
    public Task<string?> WorkflowIdOfAsync(string key) => db.SingleOrDefaultAsync<string?>("SELECT workflow_id FROM letters WHERE dedupe_key = @k", new { k = key });

    public Task<Row> ByDedupeKeyAsync(string key) => db.QuerySingleAsync(
        "SELECT id, status, provider_message_id FROM letters WHERE dedupe_key = @k", new { k = key },
        r => new Row(r.Guid("id"), r.Text("status"), r.Str("provider_message_id")));

    /// <summary>
    /// The letter with this key will never be sent: `skipped`, with the reason. Only a letter that has not gone (draft, queued or failed) changes, so a repeat, or a letter
    /// that was sent before, returns 0 and nothing is touched. Returns the number of letters skipped (0 or 1).
    /// </summary>
    public Task<int> MarkSkippedAsync(string key, string reason) => db.ExecuteAsync(
        "UPDATE letters SET status = 'skipped', status_reason = @r WHERE dedupe_key = @k AND status IN ('draft', 'queued', 'failed')", new { k = key, r = reason });

    public Task<int> MarkSentAsync(Guid id, string messageId, DateTimeOffset at) => db.ExecuteAsync(
        "UPDATE letters SET status = 'sent', sent_at = @at, provider_message_id = @m WHERE id = @id AND status <> 'sent'",
        new { at = at.ToUniversalTime(), m = messageId, id });
}
