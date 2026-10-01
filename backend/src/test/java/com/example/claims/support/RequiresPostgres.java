package com.example.claims.support;

import java.lang.annotation.ElementType;
import java.lang.annotation.Retention;
import java.lang.annotation.RetentionPolicy;
import java.lang.annotation.Target;
import org.junit.jupiter.api.extension.ExecutionCondition;
import org.junit.jupiter.api.extension.ExtendWith;
import org.junit.jupiter.api.extension.ExtensionContext;
import org.junit.jupiter.api.extension.ConditionEvaluationResult;

/** Marks a test class that needs a real PostgreSQL. Skipped, with the reason, when there is none. */
@Target(ElementType.TYPE)
@Retention(RetentionPolicy.RUNTIME)
@ExtendWith(RequiresPostgres.Condition.class)
public @interface RequiresPostgres {

    class Condition implements ExecutionCondition {
        @Override
        public ConditionEvaluationResult evaluateExecutionCondition(ExtensionContext context) {
            return PostgresTestSupport.available()
                    ? ConditionEvaluationResult.enabled("Postgres available")
                    : ConditionEvaluationResult.disabled("REQUIRES POSTGRES/DOCKER: " + PostgresTestSupport.skipReason());
        }
    }
}
