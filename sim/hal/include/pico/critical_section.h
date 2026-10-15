/* pico/critical_section.h — SIMULATOR VERSION (spin lock + IRQ mask). */
#ifndef _PICO_CRITICAL_SECTION_H
#define _PICO_CRITICAL_SECTION_H
#include "hardware/sync.h"
typedef struct { spin_lock_t *spin_lock; uint32_t save; } critical_section_t;
void critical_section_init(critical_section_t *crit_sec);
void critical_section_init_with_lock_num(critical_section_t *crit_sec, uint lock_num);
void critical_section_enter_blocking(critical_section_t *crit_sec);
void critical_section_exit(critical_section_t *crit_sec);
void critical_section_deinit(critical_section_t *crit_sec);
#endif
