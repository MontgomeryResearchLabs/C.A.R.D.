/* pico/stdio.h — SIMULATOR VERSION: printf goes to the simulator console. */
#ifndef _PICO_STDIO_H
#define _PICO_STDIO_H
#include "pico/types.h"
#include <stdio.h>
bool stdio_init_all(void);
static inline bool stdio_usb_init(void) { return true; }
static inline bool stdio_usb_connected(void) { return true; }
static inline void stdio_flush(void) {}
int getchar_timeout_us(uint32_t timeout_us); /* always PICO_ERROR_TIMEOUT */
#endif
