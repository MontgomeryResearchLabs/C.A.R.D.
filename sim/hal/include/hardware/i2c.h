/*
 * hardware/i2c.h  —  SIMULATOR VERSION
 * ---------------------------------------------------------------------------
 * Byte-level I2C master that talks to the simulated devices on the card:
 *   0x18  LIS2DH12 accelerometer (SA0 strapped to GND)
 *   0x53  ST25DV04K NFC tag, user memory
 *   0x57  ST25DV04K NFC tag, system area
 *
 * The transaction only succeeds if the bus is electrically able to work:
 * GPIO22/23 must be in GPIO_FUNC_I2C and the pull-ups (powered from GPIO29,
 * "ENABLE_ACCEL") must be energised. Bus time is charged to the calling core
 * (9 bit-times per byte at the configured baud rate).
 */
#ifndef _HARDWARE_I2C_H
#define _HARDWARE_I2C_H

#include "pico/types.h"

typedef struct i2c_inst {
    int id;         /* 0 or 1 */
    uint baudrate;  /* 0 = not initialised */
} i2c_inst_t;

extern i2c_inst_t i2c0_inst;
extern i2c_inst_t i2c1_inst;
#define i2c0 (&i2c0_inst)
#define i2c1 (&i2c1_inst)
#define i2c_default i2c1 /* the card's only bus */

uint i2c_init(i2c_inst_t *i2c, uint baudrate);
void i2c_deinit(i2c_inst_t *i2c);
uint i2c_set_baudrate(i2c_inst_t *i2c, uint baudrate);
static inline uint i2c_hw_index(i2c_inst_t *i2c) { return (uint)i2c->id; }

int i2c_write_blocking(i2c_inst_t *i2c, uint8_t addr, const uint8_t *src, size_t len, bool nostop);
int i2c_read_blocking(i2c_inst_t *i2c, uint8_t addr, uint8_t *dst, size_t len, bool nostop);
int i2c_write_timeout_us(i2c_inst_t *i2c, uint8_t addr, const uint8_t *src, size_t len, bool nostop,
                         uint timeout_us);
int i2c_read_timeout_us(i2c_inst_t *i2c, uint8_t addr, uint8_t *dst, size_t len, bool nostop,
                        uint timeout_us);
int i2c_write_blocking_until(i2c_inst_t *i2c, uint8_t addr, const uint8_t *src, size_t len,
                             bool nostop, absolute_time_t until);
int i2c_read_blocking_until(i2c_inst_t *i2c, uint8_t addr, uint8_t *dst, size_t len, bool nostop,
                            absolute_time_t until);

#endif
