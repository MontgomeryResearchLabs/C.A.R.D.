/*
 * main.c — JT Business Card ball-tilt maze demo
 * ==============================================
 * Core 0: reads the accelerometer, rolls the ball at 60 Hz, draws frames.
 * Core 1: refreshes the charlieplexed matrix forever (charlieplex.c).
 *
 * The display and accelerometer drivers are shared with the fluid demo
 * (../fluid-demo): only the game on core 0 differs.
 *
 * Simulator build:
 *   node tools/build-firmware.mjs firmware/maze-demo \
 *        firmware/fluid-demo/charlieplex.c firmware/fluid-demo/lis2dh12.c -o dist/maze-demo.wasm
 */
#include <stdio.h>
#include "pico/stdlib.h"
#include "pico/multicore.h"
#include "board.h"
#include "charlieplex.h"
#include "lis2dh12.h"
#include "maze.h"

#define FRAME_US 16667 /* 60 Hz physics + drawing */

int main(void) {
    stdio_init_all();
    printf("JT card maze demo — %d x %d charlieplex\n", DISPLAY_W, DISPLAY_H);

    display_init();
    multicore_launch_core1(display_core1_main);

    bool have_accel = lis2dh12_init();
    if (!have_accel) printf("No accelerometer: the ball will roll straight 'down'.\n");

    maze_init();

    absolute_time_t next = get_absolute_time();
    uint64_t last_us = time_us_64();

    for (;;) {
        float gx = 0.0f, gy = 1.0f, gz = 0.0f;
        accel_sample_t a;
        if (have_accel && lis2dh12_read(&a)) ACCEL_TO_DISPLAY(a.x, a.y, a.z, gx, gy, gz);
        (void)gz;

        uint64_t now = time_us_64();
        maze_step(gx, gy, (float)(now - last_us) * 1e-6f);
        last_us = now;

        maze_render(display_back_buffer());
        display_swap();

        next = delayed_by_us(next, FRAME_US);
        sleep_until(next);
    }
}
