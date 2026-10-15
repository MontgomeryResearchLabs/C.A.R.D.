/*
 * hal.c — Pico SDK API implemented on top of the simulator imports
 * ==================================================================
 * Each SDK function here does the same thing as the real one, but instead of
 * writing RP2350 registers it calls into the JavaScript board model through
 * the primitives in sim_imports.h.
 *
 * Timing: every call charges a small, realistic cost (a few CPU cycles) so
 * that tight bit-banging loops take plausible virtual time. Blocking calls
 * (sleep, busy_wait, I2C, FIFO waits) charge their full duration.
 *
 * Exports (called BY the engine): sim_entry_core0, sim_entry_core1,
 * sim_fire_timer, sim_fire_gpio_irq, sim_stack_top, sim_async_buf.
 */
#include "sim_imports.h"
#include "pico/stdlib.h"
#include "pico/multicore.h"
#include "pico/mutex.h"
#include "pico/critical_section.h"
#include "hardware/i2c.h"
#include <stdarg.h>
#include <stdio.h>

#define SIM_EXPORT(name) __attribute__((export_name(#name)))

/* Cost of one SIO register access from C, in ns (~1-2 cycles @150 MHz plus
 * the call). Only used to keep bit-banged sequences from taking zero time. */
#define COST_SIO_NS 10.0
#define COST_PADS_NS 20.0 /* pad/function config goes over the APB bus */

/* =========================================================================
 * Entry points, stacks and asyncify buffers
 * ========================================================================= */
int main(void);

/* Separate C stacks for core 1 and for "interrupt" context. Core 0 uses the
 * linker-provided stack. (The wasm C stack only holds address-taken locals,
 * so these are much smaller in practice than ARM stacks would need to be.) */
#define SIM_STACK_BYTES (64 * 1024)
static uint8_t core1_stack[SIM_STACK_BYTES] __attribute__((aligned(16)));
static uint8_t irq_stack[SIM_STACK_BYTES] __attribute__((aligned(16)));

/* Asyncify unwind buffers: one per core. Layout required by Binaryen:
 * [0] = current write pointer, [1] = end pointer, then the data. */
#define ASYNC_BUF_BYTES (64 * 1024)
static uint8_t async_buf[2][ASYNC_BUF_BYTES] __attribute__((aligned(16)));

SIM_EXPORT(sim_stack_top) uint32_t sim_stack_top(int which) {
    return which == 1 ? (uint32_t)(core1_stack + SIM_STACK_BYTES) : (uint32_t)(irq_stack + SIM_STACK_BYTES);
}
SIM_EXPORT(sim_async_buf) uint32_t sim_async_buf(int core) { return (uint32_t)async_buf[core]; }
SIM_EXPORT(sim_async_buf_size) uint32_t sim_async_buf_size(void) { return ASYNC_BUF_BYTES; }

SIM_EXPORT(sim_entry_core0) void sim_entry_core0(void) {
    int rc = main();
    printf("[sim] main() returned %d - on real hardware the core would now sit idle\n", rc);
}

static void (*volatile core1_entry)(void);
SIM_EXPORT(sim_entry_core1) void sim_entry_core1(void) {
    if (core1_entry) core1_entry();
}

/* =========================================================================
 * Panic / assert
 * ========================================================================= */
void panic(const char *fmt, ...) {
    char buf[256];
    va_list ap;
    va_start(ap, fmt);
    int n = vsnprintf(buf, sizeof buf, fmt, ap);
    va_end(ap);
    sim_panic(buf, n < (int)sizeof buf ? n : (int)sizeof buf - 1);
    __builtin_unreachable();
}
void panic_unsupported(void) { panic("unsupported"); }
void __sim_assert_fail(const char *expr, const char *file, int line) {
    panic("assertion \"%s\" failed: %s:%d", expr, file, line);
}
void abort(void) { panic("abort()"); }
void exit(int code) { panic("exit(%d)", code); }

/* =========================================================================
 * Time
 * ========================================================================= */
uint64_t time_us_64(void) {
    sim_yield(COST_SIO_NS);
    return (uint64_t)sim_time_us();
}
uint32_t time_us_32(void) { return (uint32_t)time_us_64(); }

void busy_wait_us(uint64_t delay_us) { sim_yield((double)delay_us * 1000.0); }
void busy_wait_us_32(uint32_t delay_us) { sim_yield((double)delay_us * 1000.0); }
void busy_wait_ms(uint32_t delay_ms) { sim_yield((double)delay_ms * 1e6); }
void busy_wait_until(absolute_time_t t) {
    double now = sim_time_us();
    if ((double)t > now) sim_yield(((double)t - now) * 1000.0);
}
void busy_wait_at_least_cycles(uint32_t minimum_cycles) {
    sim_yield((double)minimum_cycles * (1e9 / (double)clock_get_hz(clk_sys)));
}
/* sleep_* behaves like busy_wait_* here: in both cases the core's clock
 * advances and the other core is free to run. */
void sleep_us(uint64_t us) { busy_wait_us(us); }
void sleep_ms(uint32_t ms) { busy_wait_ms(ms); }
void sleep_until(absolute_time_t t) { busy_wait_until(t); }
bool best_effort_wfe_or_timeout(absolute_time_t t) {
    sim_yield(1000.0); /* "wait for event": give up 1 us and re-check */
    return time_us_64() >= t;
}
void tight_loop_contents(void) { sim_yield(COST_SIO_NS * 2); }
void sim_yield_hint(void) { sim_yield(COST_SIO_NS * 4); }

/* ---- alarms & repeating timers ---------------------------------------- */
typedef struct {
    alarm_callback_t cb;
    void *user;
} sim_alarm_t;
#define MAX_ALARMS 16
static sim_alarm_t alarms[MAX_ALARMS];
static int alarm_ids[MAX_ALARMS];

alarm_id_t add_alarm_at(absolute_time_t time, alarm_callback_t cb, void *user_data, bool fire_if_past) {
    (void)fire_if_past;
    for (int i = 0; i < MAX_ALARMS; i++) {
        if (!alarms[i].cb) {
            alarms[i].cb = cb;
            alarms[i].user = user_data;
            alarm_ids[i] = sim_timer_add(1, &alarms[i], (double)time);
            return alarm_ids[i];
        }
    }
    return -1; /* real SDK: -1 when the pool is full */
}
alarm_id_t add_alarm_in_us(uint64_t us, alarm_callback_t cb, void *u, bool fip) {
    return add_alarm_at(time_us_64() + us, cb, u, fip);
}
alarm_id_t add_alarm_in_ms(uint32_t ms, alarm_callback_t cb, void *u, bool fip) {
    return add_alarm_in_us((uint64_t)ms * 1000u, cb, u, fip);
}
bool cancel_alarm(alarm_id_t id) {
    for (int i = 0; i < MAX_ALARMS; i++)
        if (alarms[i].cb && alarm_ids[i] == id) {
            alarms[i].cb = 0;
            return sim_timer_cancel(id) != 0;
        }
    return false;
}

bool add_repeating_timer_us(int64_t delay_us, repeating_timer_callback_t cb, void *user_data,
                            repeating_timer_t *out) {
    out->delay_us = delay_us;
    out->callback = cb;
    out->user_data = user_data;
    out->pool = 0;
    int64_t first = delay_us < 0 ? -delay_us : delay_us;
    out->alarm_id = sim_timer_add(0, out, (double)(time_us_64() + (uint64_t)first));
    return out->alarm_id > 0;
}
bool cancel_repeating_timer(repeating_timer_t *t) {
    if (!t->alarm_id) return false;
    bool ok = sim_timer_cancel(t->alarm_id) != 0;
    t->alarm_id = 0;
    return ok;
}

/* Called by the engine (in interrupt context) when a timer is due.
 * Returns the SDK "reschedule" value: 0 = stop, >0 = us after the previous
 * scheduled time, <0 = -us after now. */
SIM_EXPORT(sim_fire_timer) double sim_fire_timer(int kind, void *obj, int id) {
    if (kind == 0) {
        repeating_timer_t *rt = (repeating_timer_t *)obj;
        if (!rt->callback) return 0;
        bool again = rt->callback(rt);
        return again && rt->alarm_id ? (double)rt->delay_us : 0;
    }
    sim_alarm_t *a = (sim_alarm_t *)obj;
    alarm_callback_t cb = a->cb;
    if (!cb) return 0;
    int64_t r = cb(id, a->user);
    if (r == 0) a->cb = 0;
    return (double)r;
}

/* =========================================================================
 * Clocks
 * ========================================================================= */
static uint32_t sys_hz = 150000000u; /* RP2350 default */
uint32_t clock_get_hz(enum clock_index i) {
    switch (i) {
    case clk_sys: return sys_hz;
    case clk_ref: return 12000000u; /* the card's 12 MHz crystal */
    case clk_usb: case clk_adc: return 48000000u;
    case clk_peri: return sys_hz;
    default: return 0;
    }
}
bool set_sys_clock_khz(uint32_t khz, bool required) {
    (void)required;
    sys_hz = khz * 1000u;
    sim_set_sys_clock((double)sys_hz);
    return true;
}

/* =========================================================================
 * GPIO
 * ========================================================================= */
static inline void check_pin(uint gpio) {
    if (gpio >= NUM_BANK0_GPIOS) panic("GPIO%u does not exist on the RP2350A (GPIO0..29)", gpio);
}

void gpio_set_function(uint gpio, gpio_function_t fn) {
    check_pin(gpio);
    sim_gpio_set_function((int)gpio, (int)fn);
    sim_yield(COST_PADS_NS);
}
gpio_function_t gpio_get_function(uint gpio) { return (gpio_function_t)sim_gpio_get_function((int)gpio); }

void gpio_init(uint gpio) {
    /* Same order as the SDK: make it an input, clear the output latch,
     * then hand the pad to SIO. */
    check_pin(gpio);
    sim_gpio_set_oe(1u << gpio, 0);
    sim_gpio_set_out(1u << gpio, 0);
    gpio_set_function(gpio, GPIO_FUNC_SIO);
}
void gpio_init_mask(uint mask) {
    for (uint i = 0; i < NUM_BANK0_GPIOS; i++)
        if (mask & (1u << i)) gpio_init(i);
}
void gpio_deinit(uint gpio) { gpio_set_function(gpio, GPIO_FUNC_NULL); }

void gpio_set_pulls(uint gpio, bool up, bool down) {
    check_pin(gpio);
    sim_gpio_set_pulls((int)gpio, up, down);
    sim_yield(COST_PADS_NS);
}
void gpio_pull_up(uint gpio) { gpio_set_pulls(gpio, true, false); }
void gpio_pull_down(uint gpio) { gpio_set_pulls(gpio, false, true); }
void gpio_disable_pulls(uint gpio) { gpio_set_pulls(gpio, false, false); }
bool gpio_is_pulled_up(uint gpio) { return sim_gpio_get_pulls((int)gpio) & 1; }
bool gpio_is_pulled_down(uint gpio) { return (sim_gpio_get_pulls((int)gpio) >> 1) & 1; }
void gpio_set_input_enabled(uint gpio, bool en) {
    check_pin(gpio);
    sim_gpio_set_input_enabled((int)gpio, en);
    sim_yield(COST_PADS_NS);
}
void gpio_set_drive_strength(uint gpio, enum gpio_drive_strength d) {
    check_pin(gpio);
    sim_gpio_set_drive((int)gpio, (int)d);
    sim_yield(COST_PADS_NS);
}
void gpio_set_slew_rate(uint gpio, enum gpio_slew_rate s) { (void)gpio; (void)s; }

void gpio_set_dir(uint gpio, bool out) {
    check_pin(gpio);
    sim_gpio_set_oe(1u << gpio, out ? (1u << gpio) : 0);
    sim_yield(COST_SIO_NS);
}
void gpio_set_dir_out_masked(uint32_t mask) { sim_gpio_set_oe(mask, mask); sim_yield(COST_SIO_NS); }
void gpio_set_dir_in_masked(uint32_t mask) { sim_gpio_set_oe(mask, 0); sim_yield(COST_SIO_NS); }
void gpio_set_dir_masked(uint32_t mask, uint32_t value) { sim_gpio_set_oe(mask, value); sim_yield(COST_SIO_NS); }
void gpio_set_dir_all_bits(uint32_t values) { sim_gpio_set_oe(0x3fffffffu, values); sim_yield(COST_SIO_NS); }
bool gpio_is_dir_out(uint gpio) { return (sim_gpio_get_oe() >> gpio) & 1; }
uint gpio_get_dir(uint gpio) { return gpio_is_dir_out(gpio); }

void gpio_put(uint gpio, bool value) {
    sim_gpio_set_out(1u << gpio, value ? (1u << gpio) : 0);
    sim_yield(COST_SIO_NS);
}
void gpio_put_masked(uint32_t mask, uint32_t value) { sim_gpio_set_out(mask, value); sim_yield(COST_SIO_NS); }
void gpio_put_all(uint32_t value) { sim_gpio_set_out(0x3fffffffu, value); sim_yield(COST_SIO_NS); }
void gpio_set_mask(uint32_t mask) { sim_gpio_set_out(mask, mask); sim_yield(COST_SIO_NS); }
void gpio_clr_mask(uint32_t mask) { sim_gpio_set_out(mask, 0); sim_yield(COST_SIO_NS); }
void gpio_xor_mask(uint32_t mask) { sim_gpio_xor_out(mask); sim_yield(COST_SIO_NS); }
bool gpio_get(uint gpio) {
    sim_yield(COST_SIO_NS);
    return (sim_gpio_get_in() >> gpio) & 1;
}
uint32_t gpio_get_all(void) {
    sim_yield(COST_SIO_NS);
    return sim_gpio_get_in();
}
bool gpio_get_out_level(uint gpio) { return (sim_gpio_get_out() >> gpio) & 1; }

static gpio_irq_callback_t gpio_irq_cb;
void gpio_set_irq_enabled(uint gpio, uint32_t events, bool enabled) {
    check_pin(gpio);
    sim_gpio_irq_enable((int)gpio, events, enabled);
}
void gpio_set_irq_callback(gpio_irq_callback_t cb) { gpio_irq_cb = cb; }
void gpio_set_irq_enabled_with_callback(uint gpio, uint32_t events, bool enabled, gpio_irq_callback_t cb) {
    gpio_set_irq_callback(cb);
    gpio_set_irq_enabled(gpio, events, enabled);
}
SIM_EXPORT(sim_fire_gpio_irq) void sim_fire_gpio_irq(int pin, uint32_t events) {
    if (gpio_irq_cb) gpio_irq_cb((uint)pin, events);
}

/* =========================================================================
 * Interrupt masking & spin locks
 * ========================================================================= */
static uint32_t irq_disabled[2];
uint32_t save_and_disable_interrupts(void) {
    int c = sim_core_num();
    uint32_t prev = irq_disabled[c];
    irq_disabled[c] = 1;
    if (c == 0) sim_irq_mask(1);
    return prev;
}
void restore_interrupts(uint32_t status) {
    int c = sim_core_num();
    irq_disabled[c] = status;
    if (c == 0) sim_irq_mask((int)status);
}

static spin_lock_t spin_locks[32];
static uint32_t spin_claimed;
spin_lock_t *spin_lock_instance(uint n) { return &spin_locks[n & 31]; }
uint spin_lock_get_num(spin_lock_t *l) { return (uint)(l - spin_locks); }
int spin_lock_claim_unused(bool required) {
    for (int i = 16; i < 32; i++) /* SDK hands out 16..31 */
        if (!(spin_claimed & (1u << i))) { spin_claimed |= 1u << i; return i; }
    if (required) panic("no spin locks left");
    return -1;
}
void spin_lock_claim(uint n) { spin_claimed |= 1u << n; }
void spin_lock_unclaim(uint n) { spin_claimed &= ~(1u << n); spin_locks[n & 31] = 0; }
spin_lock_t *spin_lock_init(uint n) { spin_locks[n & 31] = 0; return &spin_locks[n & 31]; }
void spin_lock_unsafe_blocking(spin_lock_t *l) {
    while (*l) sim_yield(COST_SIO_NS * 2); /* other core holds it: let it run */
    *l = 1;
}
void spin_unlock_unsafe(spin_lock_t *l) { *l = 0; }
uint32_t spin_lock_blocking(spin_lock_t *l) {
    uint32_t s = save_and_disable_interrupts();
    spin_lock_unsafe_blocking(l);
    return s;
}
void spin_unlock(spin_lock_t *l, uint32_t s) { spin_unlock_unsafe(l); restore_interrupts(s); }
bool is_spin_locked(spin_lock_t *l) { return *l != 0; }

void critical_section_init(critical_section_t *cs) {
    critical_section_init_with_lock_num(cs, (uint)spin_lock_claim_unused(true));
}
void critical_section_init_with_lock_num(critical_section_t *cs, uint n) { cs->spin_lock = spin_lock_init(n); }
void critical_section_enter_blocking(critical_section_t *cs) { cs->save = spin_lock_blocking(cs->spin_lock); }
void critical_section_exit(critical_section_t *cs) { spin_unlock(cs->spin_lock, cs->save); }
void critical_section_deinit(critical_section_t *cs) { spin_lock_unclaim(spin_lock_get_num(cs->spin_lock)); }

void mutex_init(mutex_t *m) { m->owner = -1; }
bool mutex_try_enter(mutex_t *m, uint32_t *owner_out) {
    if (m->owner >= 0) { if (owner_out) *owner_out = (uint32_t)m->owner; return false; }
    m->owner = (int8_t)sim_core_num();
    return true;
}
void mutex_enter_blocking(mutex_t *m) { while (!mutex_try_enter(m, 0)) sim_yield(COST_SIO_NS * 4); }
bool mutex_enter_timeout_ms(mutex_t *m, uint32_t ms) {
    uint64_t end = time_us_64() + (uint64_t)ms * 1000u;
    while (!mutex_try_enter(m, 0)) { if (time_us_64() >= end) return false; sim_yield(COST_SIO_NS * 4); }
    return true;
}
void mutex_exit(mutex_t *m) { m->owner = -1; }
void recursive_mutex_init(recursive_mutex_t *m) { m->owner = -1; m->count = 0; }
void recursive_mutex_enter_blocking(recursive_mutex_t *m) {
    int c = sim_core_num();
    while (m->owner >= 0 && m->owner != c) sim_yield(COST_SIO_NS * 4);
    m->owner = (int8_t)c;
    m->count++;
}
void recursive_mutex_exit(recursive_mutex_t *m) { if (--m->count == 0) m->owner = -1; }

/* =========================================================================
 * Multicore
 * ========================================================================= */
uint get_core_num(void) { return (uint)sim_core_num(); }
void multicore_launch_core1(void (*entry)(void)) {
    core1_entry = entry;
    sim_core1_launch();
    sim_yield(2000.0); /* the real launch handshake takes a couple of us */
}
void multicore_launch_core1_with_stack(void (*entry)(void), uint32_t *b, size_t s) {
    (void)b; (void)s;
    multicore_launch_core1(entry);
}
void multicore_reset_core1(void) { sim_core1_reset(); core1_entry = 0; }
bool multicore_fifo_rvalid(void) { sim_yield(COST_SIO_NS); return sim_fifo_count(0) > 0; }
bool multicore_fifo_wready(void) { sim_yield(COST_SIO_NS); return sim_fifo_count(1) > 0; }
void multicore_fifo_push_blocking(uint32_t v) { while (!sim_fifo_push(v)) sim_yield(COST_SIO_NS * 4); }
bool multicore_fifo_push_timeout_us(uint32_t v, uint64_t t) {
    uint64_t end = time_us_64() + t;
    while (!sim_fifo_push(v)) { if (time_us_64() >= end) return false; sim_yield(COST_SIO_NS * 4); }
    return true;
}
uint32_t multicore_fifo_pop_blocking(void) {
    uint32_t v;
    while (!sim_fifo_pop(&v)) sim_yield(COST_SIO_NS * 4);
    return v;
}
bool multicore_fifo_pop_timeout_us(uint64_t t, uint32_t *out) {
    uint64_t end = time_us_64() + t;
    while (!sim_fifo_pop(out)) { if (time_us_64() >= end) return false; sim_yield(COST_SIO_NS * 4); }
    return true;
}
void multicore_fifo_drain(void) { sim_fifo_drain(); }

/* =========================================================================
 * I2C
 * ========================================================================= */
i2c_inst_t i2c0_inst = {0, 0};
i2c_inst_t i2c1_inst = {1, 0};

uint i2c_init(i2c_inst_t *i2c, uint baud) {
    i2c->baudrate = sim_i2c_init(i2c->id, baud);
    sim_yield(2000.0);
    return i2c->baudrate;
}
void i2c_deinit(i2c_inst_t *i2c) { i2c->baudrate = 0; sim_i2c_init(i2c->id, 0); }
uint i2c_set_baudrate(i2c_inst_t *i2c, uint baud) { return i2c_init(i2c, baud); }

static int xfer(i2c_inst_t *i2c, uint8_t addr, uint8_t *buf, size_t len, bool nostop, int rd, double tmo) {
    /* The JS side charges the bus time to this core and records the
     * transaction for the protocol analyser. */
    int r = sim_i2c_xfer(i2c->id, addr, buf, (int)len, nostop, rd, tmo);
    sim_yield(COST_SIO_NS);
    return r;
}
int i2c_write_blocking(i2c_inst_t *i2c, uint8_t addr, const uint8_t *src, size_t len, bool nostop) {
    return xfer(i2c, addr, (uint8_t *)src, len, nostop, 0, -1);
}
int i2c_read_blocking(i2c_inst_t *i2c, uint8_t addr, uint8_t *dst, size_t len, bool nostop) {
    return xfer(i2c, addr, dst, len, nostop, 1, -1);
}
int i2c_write_timeout_us(i2c_inst_t *i2c, uint8_t addr, const uint8_t *src, size_t len, bool nostop, uint t) {
    return xfer(i2c, addr, (uint8_t *)src, len, nostop, 0, (double)t);
}
int i2c_read_timeout_us(i2c_inst_t *i2c, uint8_t addr, uint8_t *dst, size_t len, bool nostop, uint t) {
    return xfer(i2c, addr, dst, len, nostop, 1, (double)t);
}
int i2c_write_blocking_until(i2c_inst_t *i2c, uint8_t addr, const uint8_t *src, size_t len, bool nostop,
                             absolute_time_t until) {
    double now = sim_time_us();
    return xfer(i2c, addr, (uint8_t *)src, len, nostop, 0, (double)until > now ? (double)until - now : 0);
}
int i2c_read_blocking_until(i2c_inst_t *i2c, uint8_t addr, uint8_t *dst, size_t len, bool nostop,
                            absolute_time_t until) {
    double now = sim_time_us();
    return xfer(i2c, addr, dst, len, nostop, 1, (double)until > now ? (double)until - now : 0);
}

/* =========================================================================
 * stdio
 * ========================================================================= */
bool stdio_init_all(void) { return true; }
int getchar_timeout_us(uint32_t t) { sim_yield((double)t * 1000.0); return PICO_ERROR_TIMEOUT; }

static char line_buf[256];
static int line_len;
int putchar(int c) {
    line_buf[line_len++] = (char)c;
    if (c == '\n' || line_len == (int)sizeof line_buf) { sim_print(line_buf, line_len); line_len = 0; }
    return c;
}
int puts(const char *s) {
    while (*s) putchar(*s++);
    putchar('\n');
    return 0;
}
int vprintf(const char *fmt, va_list ap) {
    char buf[512];
    int n = vsnprintf(buf, sizeof buf, fmt, ap);
    for (int i = 0; i < n && i < (int)sizeof buf - 1; i++) putchar(buf[i]);
    return n;
}
int printf(const char *fmt, ...) {
    va_list ap;
    va_start(ap, fmt);
    int n = vprintf(fmt, ap);
    va_end(ap);
    return n;
}
struct sim_file { int fd; };
static struct sim_file f_out = {1}, f_err = {2}, f_in = {0};
FILE *stdout = &f_out, *stderr = &f_err, *stdin = &f_in;
int fprintf(FILE *f, const char *fmt, ...) {
    (void)f;
    va_list ap;
    va_start(ap, fmt);
    int n = vprintf(fmt, ap);
    va_end(ap);
    return n;
}
int fputs(const char *s, FILE *f) { (void)f; while (*s) putchar(*s++); return 0; }
int fflush(FILE *f) { (void)f; if (line_len) { sim_print(line_buf, line_len); line_len = 0; } return 0; }
int getchar(void) { return EOF; }
