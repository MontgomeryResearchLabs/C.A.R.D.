/*
 * fluid.c — a small particle fluid for a 21x21 LED grid
 * ======================================================
 *
 * Model
 * -----
 * Each particle has a continuous position and velocity (in grid cells) but
 * occupies exactly one grid cell, and no two particles may share a cell. This
 * is the classic "LED sand" idea, extended with one rule that turns sand
 * into water:
 *
 *   When a particle is blocked in the direction gravity pulls it, it may
 *   slide SIDEWAYS (perpendicular to gravity). Sand piles up; water spreads
 *   out until the surface is level.
 *
 * Per step:
 *   1. v += g * GRAVITY_SCALE * dt      (tilt -> acceleration)
 *   2. v *= DAMPING                     (viscosity)
 *   3. try to move to the cell at p + v*dt:
 *        free           -> move
 *        blocked        -> try sliding along x only, then y only
 *        still blocked  -> look up to DISPERSION cells sideways
 *                          (perpendicular to gravity) for a lower spot —
 *                          this is the "water" rule — else bounce
 *
 * Particles are processed lowest-first along gravity so the bottom of the
 * pool settles before the top tries to move into it.
 *
 * Cost: O(N log N)-ish per step with N ~ 200 — well under 1 ms on a
 * 150 MHz Cortex-M33 with its single-precision FPU (all maths is float).
 */
#include "fluid.h"
#include "charlieplex.h"
#include <math.h>
#include <string.h>

#define W DISPLAY_W
#define H DISPLAY_H
#define MAX_PARTICLES (W * H)

#define GRAVITY_SCALE 60.0f /* cells / s^2 per 1 g of tilt */
#define DAMPING 0.985f      /* per step velocity retention */
#define IMPACT 0.25f        /* fraction of velocity kept after hitting something (inelastic) */
#define MAX_SPEED 50.0f     /* cells / s (keeps moves <= 1 cell per 60 Hz step) */
#define DISPERSION 6        /* how far (cells) a blocked particle looks sideways */
#define SUBSTEPS 2          /* physics steps per frame (faster, smoother flow) */

typedef struct {
    float x, y;   /* position in cells, centre of cell = integer + 0.5 */
    float vx, vy; /* velocity in cells / s */
    uint8_t moved;
} particle_t;

static particle_t P[MAX_PARTICLES];
static int16_t occ[H][W];  /* particle index in each cell, -1 = empty */
static uint16_t order[MAX_PARTICLES];
static int count;
static int up_dx = 0, up_dy = -1;  /* grid step pointing against gravity (rendering) */
static int down_dx = 0, down_dy = 1; /* grid step pointing along gravity (water rule) */

/* ---- tiny deterministic RNG (xorshift32) ---- */
static uint32_t rng = 0x12345678u;
static inline uint32_t rnd(void) { rng ^= rng << 13; rng ^= rng >> 17; rng ^= rng << 5; return rng; }
static inline float rndf(void) { return (float)(rnd() & 0xffff) / 65535.0f; }

void fluid_init(int n) {
    if (n > MAX_PARTICLES) n = MAX_PARTICLES;
    count = n;
    memset(occ, 0xff, sizeof occ);
    /* Fill from the bottom row up, like water already settled in a glass. */
    int i = 0;
    for (int y = H - 1; y >= 0 && i < n; y--)
        for (int x = 0; x < W && i < n; x++, i++) {
            P[i].x = x + 0.5f;
            P[i].y = y + 0.5f;
            P[i].vx = P[i].vy = 0;
            occ[y][x] = (int16_t)i;
            order[i] = (uint16_t)i;
        }
}

void fluid_splash(float s) {
    for (int i = 0; i < count; i++) {
        P[i].vx += (rndf() - 0.5f) * s;
        P[i].vy += (rndf() - 0.5f) * s;
    }
}

/* Move particle i from its cell to (nx, ny) if that cell is inside the grid
 * and free. Returns 1 on success. */
static int try_move(int i, int nx, int ny) {
    if (nx < 0 || ny < 0 || nx >= W || ny >= H || occ[ny][nx] >= 0) return 0;
    int cx = (int)P[i].x, cy = (int)P[i].y;
    occ[cy][cx] = -1;
    occ[ny][nx] = (int16_t)i;
    return 1;
}

static void step_once(float gx, float gy, float dt) {
    float ax = gx * GRAVITY_SCALE, ay = gy * GRAVITY_SCALE;

    /* Sort by how far "down" each particle is (projection on gravity),
     * lowest first. Insertion sort: the order barely changes frame to frame. */
    static float key[MAX_PARTICLES];
    for (int i = 0; i < count; i++) key[i] = P[i].x * gx + P[i].y * gy;
    for (int i = 1; i < count; i++) {
        uint16_t v = order[i];
        int j = i;
        while (j > 0 && key[order[j - 1]] < key[v]) { order[j] = order[j - 1]; j--; }
        order[j] = v;
    }

    /* Unit vector perpendicular to gravity (for the sideways "water" move). */
    float gl = sqrtf(gx * gx + gy * gy);
    float px = gl > 1e-3f ? -gy / gl : 1.0f, py = gl > 1e-3f ? gx / gl : 0.0f;
    if (gl > 0.1f) {
        down_dx = (int)lroundf(gx / gl); down_dy = (int)lroundf(gy / gl);
        up_dx = -down_dx; up_dy = -down_dy;
    }

    for (int k = 0; k < count; k++) {
        int i = order[k];
        particle_t *p = &P[i];

        p->vx = (p->vx + ax * dt) * DAMPING;
        p->vy = (p->vy + ay * dt) * DAMPING;
        float sp = sqrtf(p->vx * p->vx + p->vy * p->vy);
        if (sp > MAX_SPEED) { p->vx *= MAX_SPEED / sp; p->vy *= MAX_SPEED / sp; }

        int cx = (int)p->x, cy = (int)p->y;
        float nxf = p->x + p->vx * dt, nyf = p->y + p->vy * dt;
        int nx = (int)floorf(nxf), ny = (int)floorf(nyf);

        if (nx == cx && ny == cy) { p->x = nxf; p->y = nyf; continue; } /* still in cell */

        if (try_move(i, nx, ny)) {
            p->x = nxf; p->y = nyf; p->moved = 1;
        } else if (nx != cx && try_move(i, nx, cy)) {          /* slide along x */
            p->x = nxf; p->y = cy + 0.5f; p->vy *= IMPACT; p->moved = 1;
        } else if (ny != cy && try_move(i, cx, ny)) {          /* slide along y */
            p->y = nyf; p->x = cx + 0.5f; p->vx *= IMPACT; p->moved = 1;
        } else {
            /* Fully blocked: the water rule. Look sideways (perpendicular to
             * gravity) up to DISPERSION cells in each direction. Prefer a
             * "hole": a free cell whose own downhill neighbour is also free,
             * because moving there lowers the particle. Otherwise drift to
             * the farthest free cell. Random side order keeps it symmetric.
             * This is what makes a tilted pool end up with a flat surface
             * instead of a sand-like 45-degree slope. */
            int moved = 0;
            if (gl > 0.1f) {
                int s0 = (rnd() & 1) ? 1 : -1;
                int best_x = -1, best_y = -1, best_hole = 0, best_k = 0;
                for (int t = 0; t < 2; t++) {
                    int s = t ? -s0 : s0;
                    for (int kk = 1; kk <= DISPERSION; kk++) {
                        int sx = cx + (int)lroundf(px * s * kk), sy = cy + (int)lroundf(py * s * kk);
                        if (sx < 0 || sy < 0 || sx >= W || sy >= H || occ[sy][sx] >= 0) break;
                        int hx = sx + down_dx, hy = sy + down_dy;
                        int hole = hx >= 0 && hy >= 0 && hx < W && hy < H && occ[hy][hx] < 0;
                        if (hole > best_hole || (hole == best_hole && !best_hole && kk > best_k)) {
                            best_x = sx; best_y = sy; best_hole = hole; best_k = kk;
                        }
                        if (hole) break;
                    }
                    if (best_hole) break;
                }
                if (best_x >= 0 && try_move(i, best_x, best_y)) {
                    p->x = best_x + 0.5f; p->y = best_y + 0.5f;
                    float dirx = (float)(best_x - cx), diry = (float)(best_y - cy);
                    p->vx = dirx * 4.0f; p->vy = diry * 4.0f; /* keep a little momentum */
                    moved = 1;
                }
            }
            if (!moved) {
                /* Nowhere to go: stay put and lose most of the velocity. No
                 * bounce-back: reversing would open gaps in the pool. */
                p->vx *= IMPACT; p->vy *= IMPACT;
                p->x = cx + 0.5f; p->y = cy + 0.5f;
            } else {
                p->moved = 1;
            }
        }
    }
}

void fluid_step(float gx, float gy, float dt) {
    if (dt > 0.05f) dt = 0.05f; /* don't explode after a long pause */
    /* a particle counts as "moving" (drawn brighter) if it changed cell in
     * any substep of this frame */
    for (int i = 0; i < count; i++) P[i].moved = 0;
    for (int k = 0; k < SUBSTEPS; k++) step_once(gx, gy, dt / SUBSTEPS);
}

void fluid_render(uint8_t *fb) {
    /* Surface particles (empty cell directly "above" them, against gravity)
     * are drawn brightest, moving particles next, the settled bulk dimmer. */
    for (int y = 0; y < H; y++)
        for (int x = 0; x < W; x++) {
            int i = occ[y][x];
            if (i < 0) { fb[y * W + x] = 0; continue; }
            int ux = x + up_dx, uy = y + up_dy;
            int surface = ux < 0 || uy < 0 || ux >= W || uy >= H || occ[uy][ux] < 0;
            fb[y * W + x] = P[i].moved ? 15 : surface ? 13 : 7;
        }
}
