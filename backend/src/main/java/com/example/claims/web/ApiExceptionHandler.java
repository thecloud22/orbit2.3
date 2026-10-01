package com.example.claims.web;

import com.example.claims.common.ApiException;
import java.net.URI;
import java.util.List;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.http.HttpStatus;
import org.springframework.http.ProblemDetail;
import org.springframework.http.ResponseEntity;
import org.springframework.http.converter.HttpMessageNotReadableException;
import org.springframework.web.bind.MethodArgumentNotValidException;
import org.springframework.web.bind.MissingRequestHeaderException;
import org.springframework.web.bind.annotation.ExceptionHandler;
import org.springframework.web.bind.annotation.RestControllerAdvice;

/** One error model for the whole API: RFC 9457 problem+json plus a stable machine `code`. */
@RestControllerAdvice
public class ApiExceptionHandler {
    private static final Logger log = LoggerFactory.getLogger(ApiExceptionHandler.class);

    @ExceptionHandler(ApiException.class)
    ResponseEntity<ProblemDetail> api(ApiException e) {
        return problem(e.status(), e.code(), e.getMessage(), e.errors());
    }

    @ExceptionHandler(MethodArgumentNotValidException.class)
    ResponseEntity<ProblemDetail> invalid(MethodArgumentNotValidException e) {
        List<ApiException.FieldError> errors = e.getBindingResult().getFieldErrors().stream()
                .map(f -> new ApiException.FieldError(f.getField(), f.getDefaultMessage())).toList();
        return problem(HttpStatus.UNPROCESSABLE_ENTITY, "validation_failed", "The request is well formed but not valid", errors);
    }

    @ExceptionHandler(HttpMessageNotReadableException.class)
    ResponseEntity<ProblemDetail> unreadable(HttpMessageNotReadableException e) {
        return problem(HttpStatus.BAD_REQUEST, "malformed_request", "The request body could not be read", List.of());
    }

    @ExceptionHandler(MissingRequestHeaderException.class)
    ResponseEntity<ProblemDetail> missingHeader(MissingRequestHeaderException e) {
        HttpStatus status = "If-Match".equalsIgnoreCase(e.getHeaderName()) ? HttpStatus.PRECONDITION_REQUIRED : HttpStatus.BAD_REQUEST;
        String code = status == HttpStatus.PRECONDITION_REQUIRED ? "precondition_required" : "missing_header";
        return problem(status, code, "Header " + e.getHeaderName() + " is required", List.of());
    }

    @ExceptionHandler(Exception.class)
    ResponseEntity<ProblemDetail> unexpected(Exception e) {
        log.error("Unhandled error", e);
        return problem(HttpStatus.INTERNAL_SERVER_ERROR, "internal_error", "Something went wrong on our side", List.of());
    }

    private ResponseEntity<ProblemDetail> problem(HttpStatus status, String code, String detail, List<ApiException.FieldError> errors) {
        ProblemDetail p = ProblemDetail.forStatusAndDetail(status, detail);
        p.setType(URI.create("https://claims.example.com/problems/" + code));
        p.setTitle(status.getReasonPhrase());
        p.setProperty("code", code);
        if (!errors.isEmpty()) p.setProperty("errors", errors);
        return ResponseEntity.status(status).contentType(org.springframework.http.MediaType.APPLICATION_PROBLEM_JSON).body(p);
    }
}
