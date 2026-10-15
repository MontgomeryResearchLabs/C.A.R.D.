/*
 * hardware/sync.h  —  SIMULATOR VERSION
 * Barriers are no-ops (the simulator is sequentially consistent). __wfe/__wfi
 * yield to the other core. Interrupt masking is honoured for simulated IRQs.
 */
#ifndef _HARDWARE_SYNC_H
#define _HARDWARE_SYNC_H
#include "pico/types.h"

void sim_yield_hint(void); /* lets the other core run */

static inline void __dmb(void) {}
static inline void __dsb(void) {}
static inline void __isb(void) {}
static inline void __mem_fence_acquire(void) {}
static inline void __mem_fence_release(void) {}
static inline void __nop(void) {}
static inline void __sev(void) {}
static inline void __wfe(void) { sim_yield_hint(); }
static inline void __wfi(void) { sim_yield_hint(); }

uint32_t save_and_disable_interrupts(void);
void restore_interrupts(uint32_t status);
static inline void restore_interrupts_from_disabled(uint32_t status) { restore_interrupts(status); }

/* Hardware spin locks (32 of them on RP2350). */
typedef volatile uint32_t spin_lock_t;
spin_lock_t *spin_lock_instance(uint lock_num);
uint spin_lock_get_num(spin_lock_t *lock);
int spin_lock_claim_unused(bool required);
void spin_lock_claim(uint lock_num);
void spin_lock_unclaim(uint lock_num);
spin_lock_t *spin_lock_init(uint lock_num);
void spin_lock_unsafe_blocking(spin_lock_t *lock);
void spin_unlock_unsafe(spin_lock_t *lock);
uint32_t spin_lock_blocking(spin_lock_t *lock);
void spin_unlock(spin_lock_t *lock, uint32_t saved_irq);
bool is_spin_locked(spin_lock_t *lock);
#endif
