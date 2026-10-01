package com.example.claims.store;

import com.example.claims.gateway.NotificationGateway;
import com.example.claims.store.LetterRepository.NewLetter;
import java.time.Clock;
import java.util.UUID;
import org.springframework.stereotype.Service;

/**
 * Sends a letter at most once per dedupe key, however many times the caller (an activity being retried, a
 * workflow started twice) runs it: insert-if-absent, send, mark sent. If the process dies between the send
 * and the mark, the retry sends again with the same idempotency key, and the provider drops the repeat.
 * Deliberately not in one DB transaction: no transaction should stay open across a call to another system.
 */
@Service
public class LetterService {
    private final LetterRepository letters;
    private final NotificationGateway gateway;
    private final Clock clock;

    public LetterService(LetterRepository letters, NotificationGateway gateway, Clock clock) {
        this.letters = letters;
        this.gateway = gateway;
        this.clock = clock;
    }

    /** Returns the letter id. */
    public UUID sendOnce(NewLetter l, String to) {
        UUID id = letters.insertQueued(l).orElse(null);
        LetterRepository.Row existing = null;
        if (id == null) {
            existing = letters.byDedupeKey(l.dedupeKey());
            if (existing.status().equals("sent")) return existing.id();
            id = existing.id();
        }
        String messageId = gateway.send(new NotificationGateway.Message(l.dedupeKey(), l.channel(), to, l.templateCode(), l.subject()));
        letters.markSent(id, messageId, clock.instant());
        return id;
    }
}
