/*
 * hardware/gpio.h  —  SIMULATOR VERSION
 * ---------------------------------------------------------------------------
 * Same function names and signatures as the Pico SDK. Each call is forwarded
 * to the simulated RP2350 pad/SIO block, which feeds the electrical model of
 * the board (charlieplex currents, ghosting, shorts, I2C pull-ups ...).
 *
 * NOT supported: direct register access (sio_hw->gpio_oe_set = ...,
 * padsbank0_hw, iobank0_hw). Use the gpio_*_masked() helpers instead; on real
 * hardware they compile to the same single-register writes, so there is no
 * speed penalty for using them.
 */
#ifndef _HARDWARE_GPIO_H
#define _HARDWARE_GPIO_H

#include "pico/types.h"

#define NUM_BANK0_GPIOS 30 /* RP2350A (QFN-60) has GPIO0..GPIO29 */

#define GPIO_OUT 1
#define GPIO_IN 0

/* RP2350 function-select numbers (datasheet table "GPIO function select"). */
enum gpio_function_rp2350 {
    GPIO_FUNC_HSTX = 0,
    GPIO_FUNC_SPI = 1,
    GPIO_FUNC_UART = 2,
    GPIO_FUNC_I2C = 3,
    GPIO_FUNC_PWM = 4,
    GPIO_FUNC_SIO = 5,
    GPIO_FUNC_PIO0 = 6,
    GPIO_FUNC_PIO1 = 7,
    GPIO_FUNC_PIO2 = 8,
    GPIO_FUNC_GPCK = 9,
    GPIO_FUNC_XIP_CS1 = 9,
    GPIO_FUNC_CORESIGHT_TRACE = 9,
    GPIO_FUNC_USB = 10,
    GPIO_FUNC_UART_AUX = 11,
    GPIO_FUNC_NULL = 0x1f,
};
typedef enum gpio_function_rp2350 gpio_function_t;

enum gpio_drive_strength {
    GPIO_DRIVE_STRENGTH_2MA = 0,
    GPIO_DRIVE_STRENGTH_4MA = 1, /* reset default */
    GPIO_DRIVE_STRENGTH_8MA = 2,
    GPIO_DRIVE_STRENGTH_12MA = 3,
};

enum gpio_slew_rate { GPIO_SLEW_RATE_SLOW = 0, GPIO_SLEW_RATE_FAST = 1 };

enum gpio_irq_level {
    GPIO_IRQ_LEVEL_LOW = 0x1u,
    GPIO_IRQ_LEVEL_HIGH = 0x2u,
    GPIO_IRQ_EDGE_FALL = 0x4u,
    GPIO_IRQ_EDGE_RISE = 0x8u,
};

typedef void (*gpio_irq_callback_t)(uint gpio, uint32_t event_mask);

/* --- configuration ------------------------------------------------------ */
void gpio_init(uint gpio);           /* SIO function, input, output latch 0 */
void gpio_init_mask(uint gpio_mask);
void gpio_deinit(uint gpio);
void gpio_set_function(uint gpio, gpio_function_t fn);
gpio_function_t gpio_get_function(uint gpio);
void gpio_set_pulls(uint gpio, bool up, bool down);
void gpio_pull_up(uint gpio);
void gpio_pull_down(uint gpio);
void gpio_disable_pulls(uint gpio);
bool gpio_is_pulled_up(uint gpio);
bool gpio_is_pulled_down(uint gpio);
void gpio_set_input_enabled(uint gpio, bool enabled);
void gpio_set_drive_strength(uint gpio, enum gpio_drive_strength drive);
void gpio_set_slew_rate(uint gpio, enum gpio_slew_rate slew);

/* --- direction ------------------------------------------------------------ */
void gpio_set_dir(uint gpio, bool out);
void gpio_set_dir_out_masked(uint32_t mask);
void gpio_set_dir_in_masked(uint32_t mask);
void gpio_set_dir_masked(uint32_t mask, uint32_t value);
void gpio_set_dir_all_bits(uint32_t values);
bool gpio_is_dir_out(uint gpio);
uint gpio_get_dir(uint gpio);

/* --- output / input ------------------------------------------------------- */
void gpio_put(uint gpio, bool value);
void gpio_put_masked(uint32_t mask, uint32_t value);
void gpio_put_all(uint32_t value);
void gpio_set_mask(uint32_t mask);
void gpio_clr_mask(uint32_t mask);
void gpio_xor_mask(uint32_t mask);
bool gpio_get(uint gpio);
uint32_t gpio_get_all(void);
bool gpio_get_out_level(uint gpio);

/* --- interrupts ------------------------------------------------------------
 * Callbacks run on core 0 "between instructions", like a real IRQ.
 * Only edge/level events caused by the simulated peripherals (e.g. the
 * LIS2DH12 INT1 data-ready line on GPIO24) are generated. */
void gpio_set_irq_enabled(uint gpio, uint32_t event_mask, bool enabled);
void gpio_set_irq_callback(gpio_irq_callback_t callback);
void gpio_set_irq_enabled_with_callback(uint gpio, uint32_t event_mask, bool enabled,
                                        gpio_irq_callback_t callback);

#endif
