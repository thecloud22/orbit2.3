package com.example.claims.web;

import com.example.claims.common.ApiException;
import org.springframework.http.HttpStatus;

/** Optimistic concurrency: the ETag of a resource is its row version, quoted ("7"); If-Match echoes it back. */
final class IfMatch {
    private IfMatch() {}

    static long parse(String header) {
        String v = header.trim();
        if (v.startsWith("W/")) v = v.substring(2);
        v = v.replace("\"", "");
        try {
            return Long.parseLong(v);
        } catch (NumberFormatException e) {
            throw new ApiException(HttpStatus.BAD_REQUEST, "invalid_if_match", "If-Match must be an ETag returned by a GET, e.g. \"3\"");
        }
    }

    static String etag(long version) {
        return "\"" + version + "\"";
    }
}
