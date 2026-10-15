/*
 * libm.c — transcendental functions for the simulator
 * ====================================================
 * Implemented in double precision with classic range reduction + polynomial
 * kernels; the float versions round the double result. Accuracy is well
 * within what graphics/physics firmware needs (< 1e-12 relative for double
 * paths in the normal range).
 */
#include <math.h>
#include <stdint.h>

static const double PI = 3.14159265358979323846;
static const double PIO2 = 1.57079632679489661923;
static const double LN2 = 0.69314718055994530942;

/* sin/cos kernels on [-pi/4, pi/4] (Taylor to x^15 / x^14). */
static double ksin(double x) {
    double x2 = x * x;
    return x * (1 + x2 * (-1.0 / 6 + x2 * (1.0 / 120 + x2 * (-1.0 / 5040 + x2 * (1.0 / 362880 +
               x2 * (-1.0 / 39916800 + x2 * (1.0 / 6227020800.0 + x2 * (-1.0 / 1307674368000.0))))))));
}
static double kcos(double x) {
    double x2 = x * x;
    return 1 + x2 * (-0.5 + x2 * (1.0 / 24 + x2 * (-1.0 / 720 + x2 * (1.0 / 40320 + x2 * (-1.0 / 3628800 +
               x2 * (1.0 / 479001600.0 + x2 * (-1.0 / 87178291200.0)))))));
}
/* Reduce x to r in [-pi/4, pi/4] with x = r + q*pi/2; returns q mod 4. */
static int reduce(double x, double *r) {
    double q = __builtin_nearbyint(x / PIO2);
    /* two-step Cody-Waite reduction for accuracy at moderate |x| */
    *r = (x - q * 1.57079632673412561417) - q * 6.07710050650619224932e-11;
    return (int)((int64_t)q & 3);
}
double sin(double x) {
    double r;
    switch (reduce(x, &r)) {
    case 0: return ksin(r);
    case 1: return kcos(r);
    case 2: return -ksin(r);
    default: return -kcos(r);
    }
}
double cos(double x) {
    double r;
    switch (reduce(x, &r)) {
    case 0: return kcos(r);
    case 1: return -ksin(r);
    case 2: return -kcos(r);
    default: return ksin(r);
    }
}
double tan(double x) { return sin(x) / cos(x); }

/* atan: reduce to |x| <= tan(pi/12) then series. */
double atan(double x) {
    int neg = x < 0;
    if (neg) x = -x;
    int inv = x > 1;
    if (inv) x = 1 / x;
    double off = 0;
    if (x > 0.2679491924311227) { /* tan(15deg) */
        off = PI / 6;
        x = (x - 0.5773502691896258) / (1 + 0.5773502691896258 * x);
    }
    double x2 = x * x, s = 0, t = x;
    for (int k = 0; k < 14; k++) { s += t / (2 * k + 1); t *= -x2; }
    s += off;
    if (inv) s = PIO2 - s;
    return neg ? -s : s;
}
double atan2(double y, double x) {
    if (x > 0) return atan(y / x);
    if (x < 0) return y >= 0 ? atan(y / x) + PI : atan(y / x) - PI;
    return y > 0 ? PIO2 : y < 0 ? -PIO2 : 0;
}
double asin(double x) { return atan2(x, __builtin_sqrt((1 - x) * (1 + x))); }
double acos(double x) { return atan2(__builtin_sqrt((1 - x) * (1 + x)), x); }

double exp(double x) {
    if (x > 709) return HUGE_VAL;
    if (x < -745) return 0;
    double k = __builtin_nearbyint(x / LN2);
    double r = x - k * LN2, s = 1, t = 1;
    for (int i = 1; i < 18; i++) { t *= r / i; s += t; }
    /* scale by 2^k via exponent bits */
    union { double d; int64_t i; } u = {s};
    u.i += (int64_t)k << 52;
    return u.d;
}
double log(double x) {
    if (x <= 0) return x == 0 ? -HUGE_VAL : NAN;
    union { double d; int64_t i; } u = {x};
    int e = (int)((u.i >> 52) & 0x7ff) - 1023;
    u.i = (u.i & 0x000fffffffffffffLL) | 0x3ff0000000000000LL; /* mantissa in [1,2) */
    double m = u.d;
    if (m > 1.4142135623730951) { m /= 2; e++; }
    double z = (m - 1) / (m + 1), z2 = z * z, s = 0, t = z;
    for (int k = 0; k < 12; k++) { s += t / (2 * k + 1); t *= z2; }
    return 2 * s + e * LN2;
}
double pow(double x, double y) {
    if (y == 0) return 1;
    if (x == 0) return y > 0 ? 0 : HUGE_VAL;
    if (x < 0) {
        double yi = __builtin_trunc(y);
        if (yi != y) return NAN;
        double r = exp(y * log(-x));
        return ((int64_t)yi & 1) ? -r : r;
    }
    return exp(y * log(x));
}
double tanh(double x) {
    if (x > 20) return 1;
    if (x < -20) return -1;
    double e = exp(2 * x);
    return (e - 1) / (e + 1);
}

float sinf(float x) { return (float)sin(x); }
float cosf(float x) { return (float)cos(x); }
float tanf(float x) { return (float)tan(x); }
float atanf(float x) { return (float)atan(x); }
float atan2f(float y, float x) { return (float)atan2(y, x); }
float asinf(float x) { return (float)asin(x); }
float acosf(float x) { return (float)acos(x); }
float expf(float x) { return (float)exp(x); }
float logf(float x) { return (float)log(x); }
float log2f(float x) { return (float)(log(x) / LN2); }
float log10f(float x) { return (float)(log(x) / 2.302585092994046); }
float powf(float x, float y) { return (float)pow(x, y); }
float tanhf(float x) { return (float)tanh(x); }
