/*
 * Minimal libm for the simulator. Accuracy is ~1 ulp-ish for the float
 * functions, which is plenty for graphics/physics firmware.
 *
 * NOTE: the RP2350's Cortex-M33 has a SINGLE-precision FPU. double maths is
 * emulated in software on the real chip and is roughly 10-50x slower than
 * float. Prefer sinf/sqrtf/float literals (1.0f) in firmware.
 */
#ifndef _SIM_MATH_H
#define _SIM_MATH_H
#define M_PI 3.14159265358979323846
#define M_PI_2 1.57079632679489661923
#define M_SQRT2 1.41421356237309504880
#define M_E 2.7182818284590452354
#define INFINITY (__builtin_inff())
#define NAN (__builtin_nanf(""))
#define HUGE_VALF (__builtin_huge_valf())
#define HUGE_VAL (__builtin_huge_val())
#define isnan(x) __builtin_isnan(x)
#define isinf(x) __builtin_isinf(x)
#define isfinite(x) __builtin_isfinite(x)
#define signbit(x) __builtin_signbit(x)

/* These map to single WebAssembly instructions. */
static inline float sqrtf(float x) { return __builtin_sqrtf(x); }
static inline double sqrt(double x) { return __builtin_sqrt(x); }
static inline float fabsf(float x) { return __builtin_fabsf(x); }
static inline double fabs(double x) { return __builtin_fabs(x); }
static inline float floorf(float x) { return __builtin_floorf(x); }
static inline double floor(double x) { return __builtin_floor(x); }
static inline float ceilf(float x) { return __builtin_ceilf(x); }
static inline double ceil(double x) { return __builtin_ceil(x); }
static inline float truncf(float x) { return __builtin_truncf(x); }
static inline double trunc(double x) { return __builtin_trunc(x); }
static inline float fminf(float a, float b) { return __builtin_fminf(a, b); }
static inline float fmaxf(float a, float b) { return __builtin_fmaxf(a, b); }
static inline double fmin(double a, double b) { return __builtin_fmin(a, b); }
static inline double fmax(double a, double b) { return __builtin_fmax(a, b); }
static inline float copysignf(float a, float b) { return __builtin_copysignf(a, b); }
static inline double copysign(double a, double b) { return __builtin_copysign(a, b); }
static inline float roundf(float x) { return x < 0 ? -__builtin_floorf(-x + 0.5f) : __builtin_floorf(x + 0.5f); }
static inline double round(double x) { return x < 0 ? -__builtin_floor(-x + 0.5) : __builtin_floor(x + 0.5); }
static inline long lroundf(float x) { return (long)roundf(x); }
static inline float fmodf(float a, float b) { return a - b * __builtin_truncf(a / b); }
static inline double fmod(double a, double b) { return a - b * __builtin_trunc(a / b); }
static inline float hypotf(float a, float b) { return __builtin_sqrtf(a * a + b * b); }

float sinf(float x);
float cosf(float x);
float tanf(float x);
float atanf(float x);
float atan2f(float y, float x);
float asinf(float x);
float acosf(float x);
float expf(float x);
float logf(float x);
float log2f(float x);
float log10f(float x);
float powf(float x, float y);
float tanhf(float x);
double sin(double x);
double cos(double x);
double tan(double x);
double atan(double x);
double atan2(double y, double x);
double asin(double x);
double acos(double x);
double exp(double x);
double log(double x);
double pow(double x, double y);
double tanh(double x);
#endif
