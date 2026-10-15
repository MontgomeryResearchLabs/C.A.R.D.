/*
 * lis2dh12.c — LIS2DH12 over I2C1
 * ================================
 * Register addresses and bit meanings are from the ST LIS2DH12 datasheet
 * (DocID025056). Only what the fluid demo needs is configured.
 */
#include "lis2dh12.h"
#include "board.h"
#include "pico/stdlib.h"
#include "hardware/gpio.h"
#include "hardware/i2c.h"
#include <stdio.h>

#define REG_WHO_AM_I 0x0F /* reads 0x33 */
#define REG_CTRL_REG1 0x20
#define REG_CTRL_REG4 0x23
#define REG_STATUS 0x27
#define REG_OUT_X_L 0x28
#define AUTO_INCREMENT 0x80 /* MSB of the sub-address enables burst reads */

static bool write_reg(uint8_t reg, uint8_t val) {
    uint8_t buf[2] = {reg, val};
    return i2c_write_blocking(BOARD_I2C, LIS2DH12_ADDR, buf, 2, false) == 2;
}

static bool read_regs(uint8_t reg, uint8_t *dst, int len) {
    if (len > 1) reg |= AUTO_INCREMENT;
    if (i2c_write_blocking(BOARD_I2C, LIS2DH12_ADDR, &reg, 1, true) != 1) return false; /* repeated start */
    return i2c_read_blocking(BOARD_I2C, LIS2DH12_ADDR, dst, (size_t)len, false) == len;
}

bool lis2dh12_init(void) {
    /* 1. Power the bus pull-ups (R1/R3 hang off GPIO29, "ENABLE_ACCEL"). */
    gpio_init(PIN_I2C_PULLUP_EN);
    gpio_set_dir(PIN_I2C_PULLUP_EN, GPIO_OUT);
    gpio_put(PIN_I2C_PULLUP_EN, 1);
    sleep_us(100); /* let the bus rise */

    /* 2. I2C1 on GPIO22/23. No internal pull-ups: the external 5.1k are
     *    much stronger and the internal ones would just add load. */
    i2c_init(BOARD_I2C, I2C_BAUD);
    gpio_set_function(PIN_I2C_SDA, GPIO_FUNC_I2C);
    gpio_set_function(PIN_I2C_SCL, GPIO_FUNC_I2C);

    /* 3. INT1 as a plain input (not used by the demo, but don't leave it as
     *    an output fighting the sensor's push-pull driver). */
    gpio_init(PIN_ACCEL_INT1);
    gpio_init(PIN_ACCEL_INT2);

    sleep_ms(5); /* LIS2DH12 boot time */

    uint8_t who = 0;
    if (!read_regs(REG_WHO_AM_I, &who, 1) || who != 0x33) {
        printf("LIS2DH12: WHO_AM_I = 0x%02x (expected 0x33)\n", who);
        return false;
    }
    /* CTRL_REG1 = 0101 0 111 : ODR 100 Hz, normal/HR mode, X Y Z enabled */
    if (!write_reg(REG_CTRL_REG1, 0x57)) return false;
    /* CTRL_REG4 = 1 0 00 1 00 0 : BDU on, +/-2 g, high-resolution (12-bit) */
    if (!write_reg(REG_CTRL_REG4, 0x88)) return false;
    printf("LIS2DH12: ok (100 Hz, HR, +/-2 g)\n");
    return true;
}

bool lis2dh12_read(accel_sample_t *out) {
    uint8_t raw[6];
    if (!read_regs(REG_OUT_X_L, raw, 6)) return false;
    /* Data is left-justified 16-bit two's complement; in HR mode the top 12
     * bits are valid and 1 LSB = 1 mg at +/-2 g. */
    int16_t x = (int16_t)(raw[0] | raw[1] << 8);
    int16_t y = (int16_t)(raw[2] | raw[3] << 8);
    int16_t z = (int16_t)(raw[4] | raw[5] << 8);
    out->x = (float)(x >> 4) * 0.001f;
    out->y = (float)(y >> 4) * 0.001f;
    out->z = (float)(z >> 4) * 0.001f;
    return true;
}
