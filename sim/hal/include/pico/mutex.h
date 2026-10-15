/* pico/mutex.h — SIMULATOR VERSION. Owner-tracked mutex; waiters yield. */
#ifndef _PICO_MUTEX_H
#define _PICO_MUTEX_H
#include "pico/types.h"
#include "pico/time.h"
typedef struct { volatile int8_t owner; } mutex_t;          /* -1 = free, else core */
typedef struct { volatile int8_t owner; uint8_t count; } recursive_mutex_t;
void mutex_init(mutex_t *mtx);
void mutex_enter_blocking(mutex_t *mtx);
bool mutex_try_enter(mutex_t *mtx, uint32_t *owner_out);
bool mutex_enter_timeout_ms(mutex_t *mtx, uint32_t timeout_ms);
void mutex_exit(mutex_t *mtx);
static inline bool mutex_is_initialized(mutex_t *mtx) { (void)mtx; return true; }
void recursive_mutex_init(recursive_mutex_t *mtx);
void recursive_mutex_enter_blocking(recursive_mutex_t *mtx);
void recursive_mutex_exit(recursive_mutex_t *mtx);
#define auto_init_mutex(name) mutex_t name = { -1 }
#define auto_init_recursive_mutex(name) recursive_mutex_t name = { -1, 0 }
#endif
