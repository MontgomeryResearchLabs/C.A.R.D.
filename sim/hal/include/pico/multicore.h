/*
 * pico/multicore.h  —  SIMULATOR VERSION
 * ---------------------------------------------------------------------------
 * Core 1 runs as a cooperative "fiber" that shares memory with core 0.
 * The scheduler interleaves the two cores by virtual time (within a few us),
 * so shared variables, the inter-core FIFO and races behave much like on the
 * real dual Cortex-M33.
 *
 * A busy loop that waits on a flag set by the other core MUST contain
 * tight_loop_contents() (as the SDK recommends) or another SDK call,
 * otherwise the simulator can never switch to the other core.
 */
#ifndef _PICO_MULTICORE_H
#define _PICO_MULTICORE_H
#include "pico/types.h"
#include "pico/time.h"

void multicore_launch_core1(void (*entry)(void));
void multicore_launch_core1_with_stack(void (*entry)(void), uint32_t *stack_bottom, size_t stack_size_bytes);
void multicore_reset_core1(void);

bool multicore_fifo_rvalid(void);
bool multicore_fifo_wready(void);
void multicore_fifo_push_blocking(uint32_t data);
bool multicore_fifo_push_timeout_us(uint32_t data, uint64_t timeout_us);
uint32_t multicore_fifo_pop_blocking(void);
bool multicore_fifo_pop_timeout_us(uint64_t timeout_us, uint32_t *out);
void multicore_fifo_drain(void);
static inline void multicore_fifo_clear_irq(void) {}
uint get_core_num(void);
#endif
