/*
 * sim_imports.h — the boundary between firmware (WebAssembly) and simulator
 * ===========================================================================
 * Every function declared here is IMPLEMENTED IN JAVASCRIPT (sim/core/engine.js,
 * object `imports.sim`). The C side of the HAL (hal.c) is a thin layer that
 * converts Pico SDK calls into these primitives.
 *
 * sim_yield() is special: it is the ONLY import allowed to suspend the
 * WebAssembly stack (via Binaryen "asyncify"). The engine uses it to switch
 * between core 0 and core 1, to fire timer/GPIO interrupts and to hand
 * control back to the browser so the 3D view can be drawn.
 */
#ifndef SIM_IMPORTS_H
#define SIM_IMPORTS_H
#include <stdint.h>
#include <stddef.h>

#define SIM_IMPORT(name) __attribute__((import_module("sim"), import_name(#name)))

/* Charge `cost_ns` of virtual time to the running core, then possibly
 * suspend it (context switch). */
SIM_IMPORT(yield) void sim_yield(double cost_ns);

/* Virtual time of the running core, microseconds since boot. */
SIM_IMPORT(time_us) double sim_time_us(void);
/* Which core is executing (0 or 1). */
SIM_IMPORT(core_num) int sim_core_num(void);

/* ---- GPIO / pads. `mask` bit n = GPIOn. ---- */
SIM_IMPORT(gpio_set_function) void sim_gpio_set_function(int pin, int fn);
SIM_IMPORT(gpio_get_function) int sim_gpio_get_function(int pin);
SIM_IMPORT(gpio_set_oe) void sim_gpio_set_oe(uint32_t mask, uint32_t value);
SIM_IMPORT(gpio_get_oe) uint32_t sim_gpio_get_oe(void);
SIM_IMPORT(gpio_set_out) void sim_gpio_set_out(uint32_t mask, uint32_t value);
SIM_IMPORT(gpio_xor_out) void sim_gpio_xor_out(uint32_t mask);
SIM_IMPORT(gpio_get_out) uint32_t sim_gpio_get_out(void);
SIM_IMPORT(gpio_get_in) uint32_t sim_gpio_get_in(void);
SIM_IMPORT(gpio_set_pulls) void sim_gpio_set_pulls(int pin, int up, int down);
SIM_IMPORT(gpio_get_pulls) int sim_gpio_get_pulls(int pin); /* bit0 up, bit1 down */
SIM_IMPORT(gpio_set_input_enabled) void sim_gpio_set_input_enabled(int pin, int en);
SIM_IMPORT(gpio_set_drive) void sim_gpio_set_drive(int pin, int strength);
SIM_IMPORT(gpio_irq_enable) void sim_gpio_irq_enable(int pin, uint32_t events, int enabled);

/* ---- I2C ---- */
SIM_IMPORT(i2c_init) uint32_t sim_i2c_init(int bus, uint32_t baud);
/* Returns bytes transferred, or a negative PICO_ERROR_* code. */
SIM_IMPORT(i2c_xfer) int sim_i2c_xfer(int bus, int addr, uint8_t *buf, int len, int nostop, int is_read,
                                      double timeout_us);

/* ---- multicore ---- */
SIM_IMPORT(core1_launch) void sim_core1_launch(void);
SIM_IMPORT(core1_reset) void sim_core1_reset(void);
SIM_IMPORT(fifo_push) int sim_fifo_push(uint32_t v);   /* 0 if full */
SIM_IMPORT(fifo_pop) int sim_fifo_pop(uint32_t *out);  /* 0 if empty */
SIM_IMPORT(fifo_count) int sim_fifo_count(int which);  /* 0 = rx for this core, 1 = tx space */
SIM_IMPORT(fifo_drain) void sim_fifo_drain(void);

/* ---- timers / alarms (fire as core-0 interrupts) ---- */
/* kind 0 = repeating_timer_t*, 1 = alarm. Returns an id (>0). */
SIM_IMPORT(timer_add) int sim_timer_add(int kind, void *obj, double first_due_us);
SIM_IMPORT(timer_cancel) int sim_timer_cancel(int id);
SIM_IMPORT(irq_mask) void sim_irq_mask(int masked);

/* ---- misc ---- */
SIM_IMPORT(print) void sim_print(const char *s, int len);
SIM_IMPORT(panic) void sim_panic(const char *msg, int len);
SIM_IMPORT(set_sys_clock) void sim_set_sys_clock(double hz);
SIM_IMPORT(heap_mark) void sim_heap_mark(uint32_t high_water);

#endif
