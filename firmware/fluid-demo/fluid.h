/*
 * fluid.h — particle "water" on a 21x21 grid, driven by a gravity vector
 */
#ifndef FLUID_H
#define FLUID_H
#include <stdint.h>

void fluid_init(int particle_count);
/* gx, gy: gravity in display axes (x right, y down), units of g.
 * dt: seconds since the last step. */
void fluid_step(float gx, float gy, float dt);
/* Draws into a 21x21 buffer of 0..15 brightness values. */
void fluid_render(uint8_t *fb);
/* Adds a random velocity kick to every particle (e.g. on a shake). */
void fluid_splash(float strength);

#endif
