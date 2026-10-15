/*
 * lis2dh12.h — minimal driver for the ST LIS2DH12 3-axis accelerometer
 */
#ifndef LIS2DH12_H
#define LIS2DH12_H
#include <stdbool.h>

typedef struct {
    float x, y, z; /* specific force in g, SENSOR axes (see board.h for mapping) */
} accel_sample_t;

/* Powers the I2C pull-ups, sets up I2C1 and configures the sensor for
 * 100 Hz, high-resolution (12-bit), +/-2 g. Returns false if the WHO_AM_I
 * check fails (wrong address, no pull-ups, bus not wired ...). */
bool lis2dh12_init(void);

/* Reads the latest sample. Returns false on an I2C error. */
bool lis2dh12_read(accel_sample_t *out);

#endif
