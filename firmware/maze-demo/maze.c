/*
 * maze.c — a one-LED ball rolling through a square LED maze
 * ==========================================================
 *
 * The maze is a fixed 21x21 bitmap (walls = '#'): a 10x10-cell grid maze
 * with walls on the even rows/columns and one-LED-wide track on the odd
 * ones, edge to edge across the display. It was generated offline with a
 * recursive backtracker (fixed seed), so every track cell connects and it
 * is the same on every boot. There is no goal; the point is to watch the
 * ball (a single LED) roll through it as the card tilts.
 *
 * Walls meet at right angles and the ball moves one axis at a time, so it
 * can never slip diagonally between two wall LEDs.
 *
 * Physics per substep: v += g * GRAVITY_SCALE * dt, rolling friction, then
 * move along x, then along y. Entering a wall cell along an axis stops the
 * ball at the cell edge and bounces that velocity component (RESTITUTION).
 * MAX_SPEED keeps every move well under one cell per substep, so the ball
 * can't tunnel through a one-LED wall.
 */
#include "maze.h"
#include "charlieplex.h"
#include <math.h>

#define W DISPLAY_W
#define H DISPLAY_H

#define GRAVITY_SCALE 45.0f /* cells / s^2 per 1 g of tilt */
#define FRICTION 1.6f       /* cells / s^2 of rolling resistance */
#define RESTITUTION 0.35f   /* fraction of speed kept bouncing off a wall */
#define MAX_SPEED 22.0f     /* cells / s */
#define SUBSTEPS 4          /* 60 Hz frames -> 240 Hz physics: <= 0.1 cell per move */

/* Dim: ~240 wall LEDs are lit, and LEDs sharing a scan slot share one
 * anode's current, so bright walls would also make the ball dimmer. */
#define WALL_LEVEL 3
#define BALL_LEVEL 15

/* '#' = wall LED, ' ' = track. */
static const char MAZE[H][W + 1] = {
    "#####################",
    "# #       #   #     #",
    "# ### ### # # # ### #",
    "#   #   #   #     # #",
    "### # ############# #",
    "# # # #   #       # #",
    "# # ### # # ##### # #",
    "# #     #   #     # #",
    "# ########### ##### #",
    "#       #   #   #   #",
    "# ### ### # ### # # #",
    "#   #     #   #   # #",
    "### ######### ##### #",
    "#   #       #     # #",
    "# ##### ### # ##### #",
    "# #     # # #       #",
    "# # ##### # #########",
    "# # #   #   #       #",
    "# # # ### ##### ### #",
    "#   #           #   #",
    "#####################",
};

static float bx, by, vx, vy;       /* ball centre (cells) and velocity */

static inline int solid(int x, int y) {
    return x < 0 || y < 0 || x >= W || y >= H || MAZE[y][x] != ' ';
}

void maze_init(void) {
    /* Start in the top-left track cell. */
    bx = 1.5f; by = 1.5f;
    vx = vy = 0.0f;
}

static void step_once(float gx, float gy, float dt) {
    vx += gx * GRAVITY_SCALE * dt;
    vy += gy * GRAVITY_SCALE * dt;

    /* Rolling friction: a constant deceleration, so a nearly level card
     * lets the ball come to rest instead of creeping forever. */
    float sp = sqrtf(vx * vx + vy * vy);
    if (sp > 0.0f) {
        float k = sp > FRICTION * dt ? (sp - FRICTION * dt) / sp : 0.0f;
        if (sp * k > MAX_SPEED) k = MAX_SPEED / sp;
        vx *= k; vy *= k;
    }

    int cx = (int)bx, cy = (int)by;

    /* x first, then y: one axis at a time, so no corner-cutting. */
    float nx = bx + vx * dt;
    if ((int)floorf(nx) != cx && solid((int)floorf(nx), cy)) {
        bx = vx > 0 ? cx + 0.999f : cx + 0.001f;
        vx = -vx * RESTITUTION;
    } else {
        bx = nx;
        cx = (int)bx;
    }
    float ny = by + vy * dt;
    if ((int)floorf(ny) != cy && solid(cx, (int)floorf(ny))) {
        by = vy > 0 ? cy + 0.999f : cy + 0.001f;
        vy = -vy * RESTITUTION;
    } else {
        by = ny;
    }
}

void maze_step(float gx, float gy, float dt) {
    if (dt > 0.05f) dt = 0.05f; /* don't jump after a long pause */
    for (int k = 0; k < SUBSTEPS; k++) step_once(gx, gy, dt / SUBSTEPS);
}

void maze_render(uint8_t *fb) {
    for (int y = 0; y < H; y++)
        for (int x = 0; x < W; x++)
            fb[y * W + x] = MAZE[y][x] == '#' ? WALL_LEVEL : 0;
    fb[(int)by * W + (int)bx] = BALL_LEVEL;
}
