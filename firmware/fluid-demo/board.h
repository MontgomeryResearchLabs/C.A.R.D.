/*
 * board.h — JT Business Card (rev E1) hardware definitions
 * =========================================================
 * Every number here was traced from JT-Business-Card.kicad_sch / .kicad_pcb.
 * The simulator reads the same facts from board/board.json, so if the PCB
 * changes, re-run tools/kicad_pcb_extract.py and update this file.
 */
#ifndef BOARD_H
#define BOARD_H

#include "led_map.h" /* generated charlieplex wiring: LED_ANODE / LED_CATHODE */

/* ---- Charlieplexed LED matrix ------------------------------------------
 * 22 lines: GPIO0..GPIO21, each through a 22R resistor to net /LED_ARRAY/Dk
 * (GPIOn drives D(22-n)). 441 LEDs on the back copper, 2.25 mm pitch. */
#define LED_FIRST_GPIO 0
#define LED_LINES 22

/* ---- I2C1: LIS2DH12 accelerometer + ST25DV04K NFC tag ------------------- */
#define BOARD_I2C i2c1
#define PIN_I2C_SDA 22 /* GPIO22 = I2C1 SDA */
#define PIN_I2C_SCL 23 /* GPIO23 = I2C1 SCL */
#define I2C_BAUD 400000 /* LIS2DH12 max is 400 kHz (fast mode) */

/* The two 5.1k I2C pull-ups (R1, R3) are powered from this GPIO, not from
 * 3V3. Drive it HIGH before using the bus, or SDA/SCL can never go high. */
#define PIN_I2C_PULLUP_EN 29 /* net "ENABLE_ACCEL" */

#define PIN_ACCEL_INT1 24 /* LIS2DH12 INT1 (push-pull, active high by default) */
#define PIN_ACCEL_INT2 25 /* LIS2DH12 INT2 */

#define LIS2DH12_ADDR 0x18 /* SA0/SDO tied to GND */
#define ST25DV_ADDR_USER 0x53
#define ST25DV_ADDR_SYS 0x57

/* GPIO26/27/28 carry no-connect flags in the schematic but are wired to GND.
 * NEVER drive them as outputs-high: that shorts a pad driver to ground. */
#define PINS_TIED_TO_GND ((1u << 26) | (1u << 27) | (1u << 28))

/* ---- Accelerometer -> display axes ----------------------------------------
 * U4 is on the FRONT (component) side, rotated -45 deg in KiCad. The LEDs are
 * on the BACK. Working it through (see README "Accelerometer axes"):
 *
 *   sensor X in board coords = ( cos45, -sin45)   (KiCad x right, y up)
 *   sensor Y in board coords = ( sin45,  cos45)
 *   display x (looking at LEDs) = -board x       (viewed from the back)
 *   display y (down)            = -board y
 *
 * Gravity pulls the fluid along -(measured specific force), which gives:
 *   gx_display = (ax + ay) / sqrt2
 *   gy_display = (ay - ax) / sqrt2
 *   gz_display (into the LED face) = az
 *
 * ASSUMPTION: LIS2DH12 axes as drawn in the ST datasheet's top-view figure
 * (X right, Y up, pin 1 top-left). Confirm on the first real board by holding
 * it upright and checking which way the fluid falls. */
#define ACCEL_TO_DISPLAY(ax, ay, az, gx, gy, gz)        \
    do {                                                \
        (gx) = ((ax) + (ay)) * 0.70710678f;             \
        (gy) = ((ay) - (ax)) * 0.70710678f;             \
        (gz) = (az);                                    \
    } while (0)

#endif
