package com.example.claims.gateway;

/** Sends email, text, portal invites, faxes and mail. The idempotency key lets the provider drop a repeated send. */
public interface NotificationGateway {

    record Message(String idempotencyKey, String channel, String to, String templateCode, String subject) {}

    /** Returns the provider's message id. */
    String send(Message message);
}
