/*
 * pico/types.h  —  SIMULATOR VERSION
 * ---------------------------------------------------------------------------
 * Basic types used across the Pico SDK. These match the real SDK so that
 * firmware written against the real headers compiles unchanged here.
 *
 * This header set ("simhal") is a drop-in stand-in for the parts of the
 * Raspberry Pi Pico SDK that the business-card firmware uses. Instead of
 * touching silicon registers, every call is forwarded to the JavaScript
 * board model (see sim/core/engine.js) which simulates the RP2350, the
 * charlieplexed LED matrix, and the I2C devices on the card.
 */
#ifndef _PICO_TYPES_H
#define _PICO_TYPES_H

#include <stdint.h>
#include <stdbool.h>
#include <stddef.h>

typedef unsigned int uint;

/* The real SDK uses an opaque struct in debug builds and a plain uint64_t
 * otherwise. We use the plain form: microseconds since boot. */
typedef uint64_t absolute_time_t;

/* Common SDK attribute macros. They have no meaning in the simulator, so
 * they expand to nothing (or to the closest standard equivalent). */
#define __not_in_flash_func(f) f
#define __time_critical_func(f) f
#define __no_inline_not_in_flash_func(f) __attribute__((noinline)) f
#define __scratch_x(name)
#define __scratch_y(name)
#define __in_flash(name)
#define __uninitialized_ram(name) name
#define __unused __attribute__((unused))
#define __packed __attribute__((packed))
#define __aligned(x) __attribute__((aligned(x)))
#ifndef count_of
#define count_of(a) (sizeof(a) / sizeof((a)[0]))
#endif
#ifndef MIN
#define MIN(a, b) ((a) < (b) ? (a) : (b))
#define MAX(a, b) ((a) > (b) ? (a) : (b))
#endif

/* SDK error codes (pico/error.h) */
enum pico_error_codes {
    PICO_OK = 0,
    PICO_ERROR_NONE = 0,
    PICO_ERROR_TIMEOUT = -1,
    PICO_ERROR_GENERIC = -2,
    PICO_ERROR_NO_DATA = -3,
    PICO_ERROR_NOT_PERMITTED = -4,
    PICO_ERROR_INVALID_ARG = -5,
    PICO_ERROR_IO = -6,
};

/* panic(): stops the simulation and shows the message (real SDK: halts). */
void panic(const char *fmt, ...) __attribute__((noreturn));
void panic_unsupported(void) __attribute__((noreturn));
#define hard_assert(x) do { if (!(x)) panic("hard_assert failed: %s", #x); } while (0)

#endif
