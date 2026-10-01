package com.example.claims.support;

import java.sql.Connection;
import java.sql.DriverManager;
import java.sql.SQLException;
import java.sql.Statement;
import java.util.UUID;
import org.testcontainers.DockerClientFactory;
import org.testcontainers.containers.PostgreSQLContainer;

/**
 * Where the Postgres-backed tests get a real PostgreSQL (never H2: SKIP LOCKED, partial indexes, triggers and
 * jsonb must behave like production). In order:
 *   1. TEST_PG_URL (+ TEST_PG_USER, TEST_PG_PASSWORD): an existing server, e.g. a throwaway `initdb` cluster.
 *      Each test class gets its own freshly created database on it, dropped by the server owner, not by us.
 *   2. Testcontainers, when a Docker daemon is reachable.
 *   3. Neither: available() is false and the tests are skipped with a message that says why.
 */
public final class PostgresTestSupport {
    private PostgresTestSupport() {}

    private static boolean resolved;
    private static String adminUrl;
    private static String user;
    private static String password;
    private static String skipReason;
    private static PostgreSQLContainer<?> container;

    public record Db(String url, String user, String password) {}

    public static synchronized boolean available() {
        resolve();
        return adminUrl != null;
    }

    public static synchronized String skipReason() {
        resolve();
        return skipReason;
    }

    private static void resolve() {
        if (resolved) return;
        resolved = true;
        String env = System.getenv("TEST_PG_URL");
        if (env != null && !env.isBlank()) {
            adminUrl = env;
            user = System.getenv().getOrDefault("TEST_PG_USER", "postgres");
            password = System.getenv().getOrDefault("TEST_PG_PASSWORD", "");
            return;
        }
        try {
            if (DockerClientFactory.instance().isDockerAvailable()) {
                container = new PostgreSQLContainer<>("postgres:16-alpine");
                container.start();
                adminUrl = container.getJdbcUrl();
                user = container.getUsername();
                password = container.getPassword();
                return;
            }
            skipReason = "No Postgres: TEST_PG_URL is not set and no Docker daemon is running";
        } catch (RuntimeException e) {
            skipReason = "No Postgres: TEST_PG_URL is not set and Testcontainers could not start one (" + e.getMessage() + ")";
        }
    }

    /** For @DynamicPropertySource: a fresh database for this test class, wired into the datasource properties. */
    public static void register(org.springframework.test.context.DynamicPropertyRegistry registry, String hint) {
        Db db = newDatabase(hint);
        registry.add("spring.datasource.url", db::url);
        registry.add("spring.datasource.username", db::user);
        registry.add("spring.datasource.password", db::password);
    }

    /** Creates an empty database for one test class; Flyway (run by the Spring context) fills it. */
    public static synchronized Db newDatabase(String hint) {
        resolve();
        if (adminUrl == null) throw new IllegalStateException(skipReason);
        String name = "claims_" + hint.toLowerCase().replaceAll("[^a-z0-9]", "") + "_" + UUID.randomUUID().toString().substring(0, 8);
        try (Connection c = DriverManager.getConnection(adminUrl, user, password); Statement s = c.createStatement()) {
            s.execute("CREATE DATABASE " + name);
        } catch (SQLException e) {
            throw new IllegalStateException("Could not create test database", e);
        }
        String url = adminUrl.replaceFirst("/[^/?]*(\\?|$)", "/" + name + "$1");
        return new Db(url, user, password);
    }
}
