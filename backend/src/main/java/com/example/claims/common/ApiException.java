package com.example.claims.common;

import java.util.List;
import org.springframework.http.HttpStatus;

/** An error the API reports as application/problem+json (RFC 9457) with a stable `code`. */
public class ApiException extends RuntimeException {
    private final HttpStatus status;
    private final String code;
    private final List<FieldError> errors;

    public record FieldError(String field, String message) {}

    public ApiException(HttpStatus status, String code, String message) {
        this(status, code, message, List.of());
    }

    public ApiException(HttpStatus status, String code, String message, List<FieldError> errors) {
        super(message);
        this.status = status;
        this.code = code;
        this.errors = errors;
    }

    public HttpStatus status() { return status; }
    public String code() { return code; }
    public List<FieldError> errors() { return errors; }

    public static ApiException notFound(String what, Object id) {
        return new ApiException(HttpStatus.NOT_FOUND, "not_found", what + " " + id + " not found");
    }
    public static ApiException conflict(String code, String message) {
        return new ApiException(HttpStatus.CONFLICT, code, message);
    }
    public static ApiException versionConflict(String what) {
        return new ApiException(HttpStatus.PRECONDITION_FAILED, "version_conflict",
                what + " changed since you read it; fetch it again and retry with the new ETag");
    }
    public static ApiException unprocessable(String code, String message) {
        return new ApiException(HttpStatus.UNPROCESSABLE_ENTITY, code, message);
    }
}
