/*
 * charlieplex.c — scanning driver for the 21x21 charlieplexed matrix
 * ===================================================================
 *
 * How charlieplexing works on this board
 * --------------------------------------
 * 22 GPIO lines. Every LED sits between two lines. To light the LED from
 * line A (anode) to line K (cathode) we drive A high, K low and leave every
 * other line as a high-impedance input. Any number of LEDs that share the
 * same anode can be lit at once by pulling several cathodes low.
 *
 * Scan strategy: "anode at a time"
 * --------------------------------
 *   for each of the 22 lines A:
 *       for each brightness bit b = 0..3   (binary code modulation)
 *           cathodes = { K : LED(A,K) has bit b set in its brightness }
 *           all lines -> input       (break-before-make: no ghost flashes)
 *           A -> high, cathodes -> low
 *           wait BCM_UNIT_US << b
 *
 * One full refresh = 22 phases x 15 units. With BCM_UNIT_US = 6 that is
 * ~2 ms -> ~500 Hz, far above visible flicker. Each LED's duty cycle is at
 * most 1/22, which sets the maximum average brightness.
 *
 * Electrical notes (all checked by the simulator):
 *   - Pull-ups/pull-downs are disabled on the LED lines: a pulled input
 *     next to a driven-high anode leaks ~20 uA through an LED — enough to
 *     make InGaN green LEDs glow faintly ("ghosting").
 *   - Input buffers are disabled on the LED lines (RP2350 erratum E9:
 *     an input-enabled pad with pull-down can latch around 2 V).
 *   - Drive strength is set to 12 mA so the anode line, which may source
 *     up to 21 LEDs at once, sags as little as possible.
 */
#include "charlieplex.h"
#include "pico/stdlib.h"
#include "hardware/gpio.h"

#define BCM_UNIT_US 6

/* ---- frame buffers ---------------------------------------------------------
 * Core 0 draws into fb[back]; core 1 scans fb[front]. display_swap() flips
 * them, and core 1 only picks up the new front buffer between refreshes so a
 * frame is never shown half-drawn. */
static uint8_t fb[2][DISPLAY_H * DISPLAY_W];
static volatile uint8_t front_idx = 0;
static volatile uint8_t swap_pending = 0;
static volatile uint32_t refreshes = 0;

/* ---- scan tables, built once from led_map.h -----------------------------
 * For each anode line: which LEDs (pixel index + cathode line) it feeds. */
typedef struct {
    uint8_t count;
    uint8_t cathode[LED_LINES];
    uint16_t pixel[LED_LINES];
} anode_phase_t;
static anode_phase_t phases[LED_LINES];

void display_init(void) {
    /* Build the per-anode tables from the generated wiring map. */
    for (int y = 0; y < DISPLAY_H; y++) {
        for (int x = 0; x < DISPLAY_W; x++) {
            anode_phase_t *p = &phases[LED_ANODE[y][x] - LED_FIRST_GPIO];
            p->cathode[p->count] = LED_CATHODE[y][x];
            p->pixel[p->count] = (uint16_t)(y * DISPLAY_W + x);
            p->count++;
        }
    }
    /* Configure all 22 lines as quiet, high-impedance SIO pins. */
    for (uint pin = 0; pin < 32; pin++) {
        if (!(LED_PIN_MASK & (1u << pin))) continue;
        gpio_init(pin);
        gpio_disable_pulls(pin);
        gpio_set_input_enabled(pin, false);
        gpio_set_drive_strength(pin, GPIO_DRIVE_STRENGTH_12MA);
    }
    gpio_set_dir_in_masked(LED_PIN_MASK);
    gpio_put_masked(LED_PIN_MASK, 0);
}

uint8_t *display_back_buffer(void) { return fb[front_idx ^ 1]; }

void display_swap(void) {
    swap_pending = 1;
    /* Wait until core 1 has adopted the new buffer before the caller starts
     * drawing into what is now the back buffer again. */
    while (swap_pending) tight_loop_contents();
}

uint32_t display_refresh_count(void) { return refreshes; }

void display_core1_main(void) {
    for (;;) {
        if (swap_pending) {
            front_idx ^= 1;
            swap_pending = 0;
        }
        const uint8_t *frame = fb[front_idx];

        for (int a = 0; a < LED_LINES; a++) {
            const anode_phase_t *p = &phases[a];
            if (!p->count) continue;
            uint32_t anode_bit = 1u << (a + LED_FIRST_GPIO);

            for (int bit = 0; bit < 4; bit++) {
                uint32_t cathodes = 0;
                for (int i = 0; i < p->count; i++)
                    if (frame[p->pixel[i]] & (1u << bit)) cathodes |= 1u << p->cathode[i];

                gpio_set_dir_in_masked(LED_PIN_MASK);          /* break...     */
                gpio_put_masked(LED_PIN_MASK, anode_bit);      /* A=1, rest=0  */
                if (cathodes) gpio_set_dir_out_masked(anode_bit | cathodes); /* ...make */
                busy_wait_us_32(BCM_UNIT_US << bit);
            }
        }
        gpio_set_dir_in_masked(LED_PIN_MASK);
        refreshes++;
    }
}
