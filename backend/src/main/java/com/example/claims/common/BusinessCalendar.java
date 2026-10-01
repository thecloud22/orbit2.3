package com.example.claims.common;

import java.time.DayOfWeek;
import java.time.Instant;
import java.time.LocalDate;
import java.time.LocalTime;
import java.time.ZoneId;

/**
 * Turns "N days after X" into the instant a deadline row falls due. Business days skip weekends only;
 * holidays come with the state rules table. Example values, as in the mock.
 */
public final class BusinessCalendar {
    private final ZoneId zone;
    private final LocalTime fireTime;

    public BusinessCalendar(ZoneId zone, LocalTime fireTime) {
        this.zone = zone;
        this.fireTime = fireTime;
    }

    public LocalDate localDate(Instant at) {
        return at.atZone(zone).toLocalDate();
    }

    /** The instant a deadline dated `date` falls due: fireTime on that local date. */
    public Instant dueAt(LocalDate date) {
        return date.atTime(fireTime).atZone(zone).toInstant();
    }

    public Instant daysAfter(Instant from, int days) {
        return dueAt(localDate(from).plusDays(days));
    }

    public Instant businessDaysAfter(Instant from, int days) {
        return dueAt(addBusinessDays(localDate(from), days));
    }

    public LocalDate addBusinessDays(LocalDate from, int days) {
        LocalDate d = from;
        int left = days;
        while (left > 0) {
            d = d.plusDays(1);
            if (d.getDayOfWeek() != DayOfWeek.SATURDAY && d.getDayOfWeek() != DayOfWeek.SUNDAY) left--;
        }
        return d;
    }

    public ZoneId zone() {
        return zone;
    }
}
