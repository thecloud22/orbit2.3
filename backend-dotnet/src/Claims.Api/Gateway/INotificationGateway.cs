namespace Claims.Gateway;

public sealed record NotificationMessage(string IdempotencyKey, string Channel, string To, string TemplateCode, string Subject);

/// <summary>Sends email, text, portal invites, faxes and mail. The idempotency key lets the provider drop a repeated send.</summary>
public interface INotificationGateway
{
    /// <summary>Returns the provider's message id.</summary>
    Task<string> SendAsync(NotificationMessage message);
}
