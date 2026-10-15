/*
 * charlieplex.h — 21x21 charlieplexed LED display driver (runs on core 1)
 *
 * Usage:
 *   display_init();                         // core 0, once
 *   multicore_launch_core1(display_core1_main);
 *   uint8_t *fb = display_back_buffer();    // 21*21 bytes, 0..15 brightness
 *   ...draw...
 *   display_swap();                         // shown from the next refresh
 */
#ifndef CHARLIEPLEX_H
#define CHARLIEPLEX_H
#include <stdint.h>
#include "board.h"

#define DISPLAY_W LED_COLS
#define DISPLAY_H LED_ROWS
#define DISPLAY_LEVELS 16 /* 4-bit binary code modulation */

void display_init(void);
void display_core1_main(void);    /* never returns */
uint8_t *display_back_buffer(void);
void display_swap(void);          /* publish the back buffer */
uint32_t display_refresh_count(void);

#endif
