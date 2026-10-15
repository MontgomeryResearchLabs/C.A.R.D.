/*
 * main.c — JT Business Card fluid demo
 * =====================================
 * Core 0: reads the accelerometer, steps the fluid at 60 Hz, draws frames.
 * Core 1: refreshes the charlieplexed matrix forever (charlieplex.c).
 *
 * The same source builds for the real RP2350 (CMakeLists.txt, Pico SDK) and
 * for the browser simulator (tools/build-firmware.mjs).
 */
#include <stdio.h>
#include <math.h>
#include "pico/stdlib.h"
#include "pico/multicore.h"
#include "board.h"
#include "charlieplex.h"
#include "lis2dh12.h"
#include "fluid.h"

#define FRAME_US 16667     /* 60 Hz simulation + drawing */
#define PARTICLES 200      /* ~45 % of the 441 cells */
#define SHAKE_THRESHOLD_G 0.6f

/* Light every LED in order, one row at a time: a quick visual check that the
 * wiring map is right (a wrong map shows up as LEDs lighting out of order). */
static void boot_sweep(void) {
    for (int y = 0; y < DISPLAY_H; y++) {
        uint8_t *fb = display_back_buffer();
        for (int i = 0; i < DISPLAY_W * DISPLAY_H; i++) fb[i] = (i / DISPLAY_W == y) ? 15 : 0;
        display_swap();
        sleep_ms(20);
    }
}

int main(void) {
    stdio_init_all();
    printf("JT card fluid demo — %d x %d charlieplex, %d particles\n", DISPLAY_W, DISPLAY_H, PARTICLES);

    display_init();
    multicore_launch_core1(display_core1_main);
    boot_sweep();

    bool have_accel = lis2dh12_init();
    if (!have_accel) printf("No accelerometer: fluid will fall straight 'down'.\n");

    fluid_init(PARTICLES);

    absolute_time_t next = get_absolute_time();
    uint64_t last_us = time_us_64();
    uint32_t frames = 0;
    float prev_mag = 1.0f;

    for (;;) {
        /* 1. gravity in display coordinates */
        float gx = 0.0f, gy = 1.0f, gz = 0.0f;
        accel_sample_t a;
        if (have_accel && lis2dh12_read(&a)) {
            ACCEL_TO_DISPLAY(a.x, a.y, a.z, gx, gy, gz);
            /* A sudden change in total acceleration = a shake: splash! */
            float mag = sqrtf(a.x * a.x + a.y * a.y + a.z * a.z);
            if (fabsf(mag - prev_mag) > SHAKE_THRESHOLD_G) fluid_splash(40.0f * fabsf(mag - prev_mag));
            prev_mag = mag;
        }
        (void)gz;

        /* 2. physics with the real elapsed time */
        uint64_t now = time_us_64();
        fluid_step(gx, gy, (float)(now - last_us) * 1e-6f);
        last_us = now;

        /* 3. draw + publish */
        fluid_render(display_back_buffer());
        display_swap();

        if (++frames % 300 == 0)
            printf("t=%lus  g=(%.2f, %.2f)  display refreshes=%lu\n",
                   (unsigned long)(now / 1000000u), (double)gx, (double)gy,
                   (unsigned long)display_refresh_count());

        next = delayed_by_us(next, FRAME_US);
        sleep_until(next);
    }
}
