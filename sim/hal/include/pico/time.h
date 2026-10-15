/*
 * pico/time.h  —  SIMULATOR VERSION
 * ---------------------------------------------------------------------------
 * Time in the simulator is VIRTUAL: each core has its own clock in
 * microseconds since boot. sleep_xxx() and busy_wait_xxx() advance the calling core's
 * clock; the scheduler always resumes whichever core is furthest behind, so
 * the two cores stay within a few microseconds of each other.
 *
 * Pure computation (e.g. the fluid step) is also charged to the core, using
 * an estimate of how long the same code would take on a 150 MHz Cortex-M33
 * (see "CPU speed ratio" in the simulator UI).
 */
#ifndef _PICO_TIME_H
#define _PICO_TIME_H

#include "pico/types.h"

/* ---- clocks ---- */
uint32_t time_us_32(void);
uint64_t time_us_64(void);

static inline absolute_time_t get_absolute_time(void) { return time_us_64(); }
static inline uint64_t to_us_since_boot(absolute_time_t t) { return t; }
static inline uint32_t to_ms_since_boot(absolute_time_t t) { return (uint32_t)(t / 1000u); }
static inline absolute_time_t from_us_since_boot(uint64_t us) { return us; }
static inline void update_us_since_boot(absolute_time_t *t, uint64_t us) { *t = us; }
static inline absolute_time_t delayed_by_us(absolute_time_t t, uint64_t us) { return t + us; }
static inline absolute_time_t delayed_by_ms(absolute_time_t t, uint32_t ms) { return t + (uint64_t)ms * 1000u; }
static inline absolute_time_t make_timeout_time_us(uint64_t us) { return time_us_64() + us; }
static inline absolute_time_t make_timeout_time_ms(uint32_t ms) { return time_us_64() + (uint64_t)ms * 1000u; }
static inline int64_t absolute_time_diff_us(absolute_time_t from, absolute_time_t to) {
    return (int64_t)(to - from);
}
static inline absolute_time_t absolute_time_min(absolute_time_t a, absolute_time_t b) { return a < b ? a : b; }
static inline bool time_reached(absolute_time_t t) { return time_us_64() >= t; }
#define at_the_end_of_time ((absolute_time_t)0x7fffffffffffffffull)
#define nil_time ((absolute_time_t)0)
static inline bool is_at_the_end_of_time(absolute_time_t t) { return t == at_the_end_of_time; }
static inline bool is_nil_time(absolute_time_t t) { return t == 0; }

/* ---- delays ---- */
void sleep_us(uint64_t us);
void sleep_ms(uint32_t ms);
void sleep_until(absolute_time_t target);
bool best_effort_wfe_or_timeout(absolute_time_t timeout_timestamp);
void busy_wait_us_32(uint32_t delay_us);
void busy_wait_us(uint64_t delay_us);
void busy_wait_ms(uint32_t delay_ms);
void busy_wait_until(absolute_time_t t);
void busy_wait_at_least_cycles(uint32_t minimum_cycles);

/* ---- one-shot alarms (core 0 "interrupt" context) ---- */
typedef int32_t alarm_id_t;
/* return 0 = don't reschedule, >0 = reschedule this many us after the
 * previous fire time, <0 = reschedule -value us after the callback */
typedef int64_t (*alarm_callback_t)(alarm_id_t id, void *user_data);
typedef struct alarm_pool alarm_pool_t;

alarm_id_t add_alarm_at(absolute_time_t time, alarm_callback_t callback, void *user_data, bool fire_if_past);
alarm_id_t add_alarm_in_us(uint64_t us, alarm_callback_t callback, void *user_data, bool fire_if_past);
alarm_id_t add_alarm_in_ms(uint32_t ms, alarm_callback_t callback, void *user_data, bool fire_if_past);
bool cancel_alarm(alarm_id_t alarm_id);

/* ---- repeating timers (core 0 "interrupt" context) ---- */
typedef struct repeating_timer repeating_timer_t;
typedef bool (*repeating_timer_callback_t)(repeating_timer_t *rt);
struct repeating_timer {
    int64_t delay_us;                    /* >0: period start-to-start, <0: end-to-start */
    alarm_pool_t *pool;
    alarm_id_t alarm_id;
    repeating_timer_callback_t callback;
    void *user_data;
};

bool add_repeating_timer_us(int64_t delay_us, repeating_timer_callback_t callback, void *user_data,
                            repeating_timer_t *out);
static inline bool add_repeating_timer_ms(int32_t delay_ms, repeating_timer_callback_t callback,
                                          void *user_data, repeating_timer_t *out) {
    return add_repeating_timer_us((int64_t)delay_ms * 1000, callback, user_data, out);
}
bool cancel_repeating_timer(repeating_timer_t *timer);

#endif
