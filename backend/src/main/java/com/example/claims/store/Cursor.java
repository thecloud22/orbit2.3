package com.example.claims.store;

import com.example.claims.common.ApiException;
import java.nio.charset.StandardCharsets;
import java.time.Instant;
import java.util.Base64;
import org.springframework.http.HttpStatus;

/** Opaque keyset cursor: a timestamp and a tie-breaker (uuid or sequence number). */
public record Cursor(Instant at, String tie) {

    public String encode() {
        long micros = at.getEpochSecond() * 1_000_000L + at.getNano() / 1_000;
        return Base64.getUrlEncoder().withoutPadding().encodeToString((micros + "|" + tie).getBytes(StandardCharsets.UTF_8));
    }

    public static Cursor decode(String token) {
        try {
            String[] p = new String(Base64.getUrlDecoder().decode(token), StandardCharsets.UTF_8).split("\\|", 2);
            long micros = Long.parseLong(p[0]);
            return new Cursor(Instant.ofEpochSecond(Math.floorDiv(micros, 1_000_000L), Math.floorMod(micros, 1_000_000L) * 1_000L), p[1]);
        } catch (RuntimeException e) {
            throw new ApiException(HttpStatus.BAD_REQUEST, "invalid_cursor", "The cursor is not valid");
        }
    }
}
