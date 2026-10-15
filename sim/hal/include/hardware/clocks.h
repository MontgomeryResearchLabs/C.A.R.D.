/* hardware/clocks.h — SIMULATOR VERSION. The system clock frequency feeds the
 * CPU-time estimate (code runs proportionally faster at higher clk_sys). */
#ifndef _HARDWARE_CLOCKS_H
#define _HARDWARE_CLOCKS_H
#include "pico/types.h"
enum clock_index { clk_gpout0 = 0, clk_gpout1, clk_gpout2, clk_gpout3, clk_ref, clk_sys, clk_peri, clk_hstx, clk_usb, clk_adc };
uint32_t clock_get_hz(enum clock_index clk_index);
bool set_sys_clock_khz(uint32_t freq_khz, bool required);
static inline void set_sys_clock_hz(uint32_t hz, bool required) { set_sys_clock_khz(hz / 1000, required); }
#endif
