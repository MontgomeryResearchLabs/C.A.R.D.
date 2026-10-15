/*
 * common-mistakes — firmware that is WRONG on purpose
 * ====================================================
 * Load this in the simulator to see how each mistake is reported.
 * Every bug below is one that compiles fine and would only show up on the
 * real board (as a dead accelerometer, ghost LEDs, a hot pad ...).
 */
#include <stdio.h>
#include "pico/stdlib.h"
#include "hardware/i2c.h"

int main(void) {
    stdio_init_all();

    /* BUG 1: LED lines initialised but pulls left at their reset default
     * (pull-down ON). Tri-stated lines next to a driven anode leak current
     * through the LEDs -> faint ghost glow. */
    for (int p = 0; p <= 21; p++) gpio_init(p);

    /* BUG 2: I2C routed correctly, but GPIO29 (which powers the 5.1k pull-ups)
     * is never driven high -> nothing on the bus can answer. */
    i2c_init(i2c1, 400000);
    gpio_set_function(22, GPIO_FUNC_I2C);
    gpio_set_function(23, GPIO_FUNC_I2C);
    uint8_t reg = 0x0F, who = 0;
    i2c_write_blocking(i2c1, 0x18, &reg, 1, true);
    int r = i2c_read_blocking(i2c1, 0x18, &who, 1, false);
    printf("WHO_AM_I read returned %d, value 0x%02x\n", r, who);

    /* BUG 3: "spare" GPIO27 used as a debug output — but it is tied to GND. */
    gpio_init(27);
    gpio_set_dir(27, GPIO_OUT);
    gpio_put(27, 1);

    /* Fix bug 2, then BUG 4: burst read without the auto-increment bit:
     * all six bytes come from OUT_X_L. */
    gpio_init(29); gpio_set_dir(29, GPIO_OUT); gpio_put(29, 1);
    uint8_t cfg[2] = {0x20, 0x57};
    i2c_write_blocking(i2c1, 0x18, cfg, 2, false);
    sleep_ms(20);
    uint8_t out = 0x28, raw[6];
    i2c_write_blocking(i2c1, 0x18, &out, 1, true);
    i2c_read_blocking(i2c1, 0x18, raw, 6, false);
    printf("raw: %02x %02x %02x %02x %02x %02x\n", raw[0], raw[1], raw[2], raw[3], raw[4], raw[5]);

    /* Light one LED row with the ghosting pulls still on. */
    gpio_set_dir(0, GPIO_OUT); gpio_put(0, 1);         /* anode GPIO0 */
    gpio_set_dir(18, GPIO_OUT); gpio_put(18, 0);        /* one cathode */
    while (1) sleep_ms(100);
}
