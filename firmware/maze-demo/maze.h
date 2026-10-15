/*
 * maze.h — a one-LED ball rolling through a square LED maze
 */
#ifndef MAZE_H
#define MAZE_H
#include <stdint.h>

void maze_init(void);
/* gx, gy: gravity in display axes (x right, y down), units of g.
 * dt: seconds since the last step. */
void maze_step(float gx, float gy, float dt);
/* Draws the walls and the ball (one LED) into a 21x21 buffer
 * of 0..15 brightness values. */
void maze_render(uint8_t *fb);

#endif
