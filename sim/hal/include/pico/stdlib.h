/*
 * pico/stdlib.h  —  SIMULATOR VERSION
 * Pulls in the same set of headers as the real SDK's pico_stdlib.
 */
#ifndef _PICO_STDLIB_H
#define _PICO_STDLIB_H
#include "pico/types.h"
#include "pico/time.h"
#include "pico/stdio.h"
#include "hardware/gpio.h"
#include "hardware/sync.h"
#include "hardware/clocks.h"

#define PICO_DEFAULT_LED_PIN_INVERTED 0
/* tight_loop_contents(): put this in any busy-wait loop. In the simulator it
 * is the point where the other core gets a chance to run. */
void tight_loop_contents(void);
static inline void setup_default_uart(void) {}
#endif
