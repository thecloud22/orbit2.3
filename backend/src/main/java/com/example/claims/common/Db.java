package com.example.claims.common;

import java.sql.ResultSet;
import java.sql.SQLException;
import java.time.Instant;
import java.time.LocalDate;
import java.time.OffsetDateTime;
import java.time.ZoneOffset;
import java.util.Collection;
import java.util.List;
import java.util.UUID;
import java.util.stream.Collectors;

/** Small JDBC helpers: pgjdbc has no Instant support, so timestamps go in and out as OffsetDateTime. */
public final class Db {
    private Db() {}

    public static OffsetDateTime ts(Instant i) {
        return i == null ? null : OffsetDateTime.ofInstant(i, ZoneOffset.UTC);
    }

    public static Instant instant(ResultSet rs, String col) throws SQLException {
        OffsetDateTime o = rs.getObject(col, OffsetDateTime.class);
        return o == null ? null : o.toInstant();
    }

    public static UUID uuid(ResultSet rs, String col) throws SQLException {
        return rs.getObject(col, UUID.class);
    }

    public static LocalDate date(ResultSet rs, String col) throws SQLException {
        return rs.getObject(col, LocalDate.class);
    }

    public static Instant instant(ResultSet rs, int col) throws SQLException {
        OffsetDateTime o = rs.getObject(col, OffsetDateTime.class);
        return o == null ? null : o.toInstant();
    }

    public static UUID uuid(ResultSet rs, int col) throws SQLException {
        return rs.getObject(col, UUID.class);
    }

    public static LocalDate date(ResultSet rs, int col) throws SQLException {
        return rs.getObject(col, LocalDate.class);
    }

    public static List<String> textArray(ResultSet rs, String col) throws SQLException {
        java.sql.Array a = rs.getArray(col);
        return a == null ? List.of() : List.of((String[]) a.getArray());
    }

    /** A Postgres array literal ('{"a","b"}') for use as `cast(:x as text[])`. */
    public static String arrayLiteral(Collection<String> values) {
        return values.stream()
                .map(v -> "\"" + v.replace("\\", "\\\\").replace("\"", "\\\"") + "\"")
                .collect(Collectors.joining(",", "{", "}"));
    }
}
