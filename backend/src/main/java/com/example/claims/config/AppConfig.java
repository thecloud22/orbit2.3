package com.example.claims.config;

import com.example.claims.common.BusinessCalendar;
import java.time.Clock;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;

@Configuration
public class AppConfig {

    @Bean
    Clock clock() {
        return Clock.systemUTC();
    }

    @Bean
    BusinessCalendar businessCalendar(ClaimsProperties props) {
        return new BusinessCalendar(props.business().zone(), props.business().fireTime());
    }
}
