/*
 * libc.c — the small slice of the C library that firmware typically uses
 * ======================================================================
 * Strings, memory, a first-fit heap, rand(), number parsing, qsort and a
 * compact printf engine (vsnprintf). Kept dependency-free so the simulator
 * only needs clang + wasm-ld to build firmware.
 */
#include <stddef.h>
#include <stdint.h>
#include <stdarg.h>
#include <stdbool.h>
#include "sim_imports.h"
#include <stdlib.h>
#include <string.h>
#include <stdio.h>

/* ---------------------------------------------------------------- memory */
void *memcpy(void *d, const void *s, size_t n) {
    uint8_t *dp = d;
    const uint8_t *sp = s;
    while (n--) *dp++ = *sp++;
    return d;
}
void *memmove(void *d, const void *s, size_t n) {
    uint8_t *dp = d;
    const uint8_t *sp = s;
    if (dp < sp) while (n--) *dp++ = *sp++;
    else { dp += n; sp += n; while (n--) *--dp = *--sp; }
    return d;
}
void *memset(void *d, int c, size_t n) {
    uint8_t *dp = d;
    while (n--) *dp++ = (uint8_t)c;
    return d;
}
int memcmp(const void *a, const void *b, size_t n) {
    const uint8_t *x = a, *y = b;
    for (; n; n--, x++, y++) if (*x != *y) return *x - *y;
    return 0;
}
void *memchr(const void *s, int c, size_t n) {
    const uint8_t *p = s;
    for (; n; n--, p++) if (*p == (uint8_t)c) return (void *)p;
    return 0;
}
size_t strlen(const char *s) { const char *p = s; while (*p) p++; return (size_t)(p - s); }
int strcmp(const char *a, const char *b) { while (*a && *a == *b) a++, b++; return (uint8_t)*a - (uint8_t)*b; }
int strncmp(const char *a, const char *b, size_t n) {
    for (; n; n--, a++, b++) { if (*a != *b || !*a) return (uint8_t)*a - (uint8_t)*b; }
    return 0;
}
char *strcpy(char *d, const char *s) { char *r = d; while ((*d++ = *s++)) {} return r; }
char *strncpy(char *d, const char *s, size_t n) {
    size_t i = 0;
    for (; i < n && s[i]; i++) d[i] = s[i];
    for (; i < n; i++) d[i] = 0;
    return d;
}
char *strcat(char *d, const char *s) { strcpy(d + strlen(d), s); return d; }
char *strchr(const char *s, int c) { for (;; s++) { if (*s == (char)c) return (char *)s; if (!*s) return 0; } }
char *strrchr(const char *s, int c) { const char *r = 0; for (;; s++) { if (*s == (char)c) r = s; if (!*s) return (char *)r; } }
char *strstr(const char *h, const char *n) {
    size_t ln = strlen(n);
    for (; *h; h++) if (!strncmp(h, n, ln)) return (char *)h;
    return ln ? 0 : (char *)h;
}

/* ------------------------------------------------------------------ heap
 * First-fit free list with coalescing on free. Each block has an 8-byte
 * header {size, free}. The heap grows wasm memory on demand; the high-water
 * mark is reported to the simulator so it can be compared with the RP2350's
 * 520 KB of SRAM. */
extern unsigned char __heap_base;
typedef struct blk { uint32_t size; uint32_t free; } blk_t;
static uint8_t *heap_lo, *heap_hi; /* [lo, hi) is the formatted heap */

static void heap_setup(void) {
    if (heap_lo) return;
    heap_lo = heap_hi = (uint8_t *)(((uintptr_t)&__heap_base + 15) & ~(uintptr_t)15);
}
static blk_t *grow(size_t need) {
    size_t have = __builtin_wasm_memory_size(0) * 65536u;
    if ((size_t)(heap_hi - (uint8_t *)0) + need > have) {
        size_t pages = (need + 65535) / 65536 + 1;
        if (__builtin_wasm_memory_grow(0, pages) == (size_t)-1) return 0;
    }
    blk_t *b = (blk_t *)heap_hi;
    b->size = (uint32_t)need;
    b->free = 0;
    heap_hi += need;
    sim_heap_mark((uint32_t)(heap_hi - heap_lo));
    return b;
}
void *malloc(size_t n) {
    heap_setup();
    size_t need = ((n + 15) & ~(size_t)15) + 16;
    for (uint8_t *p = heap_lo; p < heap_hi; p += ((blk_t *)p)->size) {
        blk_t *b = (blk_t *)p;
        if (b->free && b->size >= need) {
            if (b->size - need >= 64) { /* split */
                blk_t *rest = (blk_t *)(p + need);
                rest->size = b->size - (uint32_t)need;
                rest->free = 1;
                b->size = (uint32_t)need;
            }
            b->free = 0;
            return p + 16;
        }
    }
    blk_t *b = grow(need);
    return b ? (uint8_t *)b + 16 : 0;
}
void free(void *ptr) {
    if (!ptr) return;
    blk_t *b = (blk_t *)((uint8_t *)ptr - 16);
    b->free = 1;
    /* coalesce with following free blocks */
    blk_t *n;
    while ((uint8_t *)b + b->size < heap_hi && (n = (blk_t *)((uint8_t *)b + b->size))->free)
        b->size += n->size;
}
void *calloc(size_t n, size_t sz) {
    void *p = malloc(n * sz);
    if (p) memset(p, 0, n * sz);
    return p;
}
void *realloc(void *p, size_t n) {
    if (!p) return malloc(n);
    blk_t *b = (blk_t *)((uint8_t *)p - 16);
    if (b->size - 16 >= n) return p;
    void *q = malloc(n);
    if (q) { memcpy(q, p, b->size - 16); free(p); }
    return q;
}

/* ------------------------------------------------------------ misc stdlib */
int abs(int x) { return x < 0 ? -x : x; }
long labs(long x) { return x < 0 ? -x : x; }
static uint32_t rand_state = 1;
int rand(void) { rand_state = rand_state * 1103515245u + 12345u; return (int)((rand_state >> 1) & RAND_MAX); }
void srand(unsigned s) { rand_state = s; }

long strtol(const char *s, char **end, int base) {
    while (*s == ' ' || *s == '\t') s++;
    int neg = 0;
    if (*s == '-' || *s == '+') neg = *s++ == '-';
    if ((base == 0 || base == 16) && s[0] == '0' && (s[1] | 32) == 'x') { s += 2; base = 16; }
    else if (base == 0) base = s[0] == '0' ? 8 : 10;
    long v = 0;
    for (;; s++) {
        int d = (*s >= '0' && *s <= '9') ? *s - '0' : ((*s | 32) >= 'a' && (*s | 32) <= 'z') ? (*s | 32) - 'a' + 10 : 99;
        if (d >= base) break;
        v = v * base + d;
    }
    if (end) *end = (char *)s;
    return neg ? -v : v;
}
unsigned long strtoul(const char *s, char **end, int base) { return (unsigned long)strtol(s, end, base); }
int atoi(const char *s) { return (int)strtol(s, 0, 10); }
float strtof(const char *s, char **end) {
    while (*s == ' ') s++;
    int neg = 0;
    if (*s == '-' || *s == '+') neg = *s++ == '-';
    double v = 0, scale = 1;
    while (*s >= '0' && *s <= '9') v = v * 10 + (*s++ - '0');
    if (*s == '.') { s++; while (*s >= '0' && *s <= '9') { v = v * 10 + (*s++ - '0'); scale *= 10; } }
    v /= scale;
    if ((*s | 32) == 'e') {
        s++;
        int en = (int)strtol(s, (char **)&s, 10);
        while (en > 0) { v *= 10; en--; }
        while (en < 0) { v /= 10; en++; }
    }
    if (end) *end = (char *)s;
    return (float)(neg ? -v : v);
}
double atof(const char *s) { return strtof(s, 0); }

void qsort(void *base, size_t n, size_t sz, int (*cmp)(const void *, const void *)) {
    /* insertion sort: firmware arrays are small and this is stable */
    uint8_t *a = base, tmp[64];
    if (sz > sizeof tmp) return;
    for (size_t i = 1; i < n; i++) {
        memcpy(tmp, a + i * sz, sz);
        size_t j = i;
        while (j > 0 && cmp(a + (j - 1) * sz, tmp) > 0) { memcpy(a + j * sz, a + (j - 1) * sz, sz); j--; }
        memcpy(a + j * sz, tmp, sz);
    }
}

/* ---------------------------------------------------------------- printf
 * Supports: %d %i %u %x %X %o %c %s %p %f %F %e %g %% with flags "-+ 0#",
 * width, precision (incl. '*'), and length modifiers hh h l ll z j t. */
typedef struct { char *buf; size_t cap, len; } out_t;
static void emit(out_t *o, char c) { if (o->len + 1 < o->cap) o->buf[o->len] = c; o->len++; }
static void emit_pad(out_t *o, char c, int n) { while (n-- > 0) emit(o, c); }

static void fmt_int(out_t *o, unsigned long long v, int neg, int base, int upper, int width, int prec,
                    int left, int zero, char sign) {
    char tmp[32];
    int n = 0;
    const char *dig = upper ? "0123456789ABCDEF" : "0123456789abcdef";
    if (v == 0 && prec != 0) tmp[n++] = '0';
    while (v) { tmp[n++] = dig[v % (unsigned)base]; v /= (unsigned)base; }
    int zeros = prec > n ? prec - n : 0;
    char sc = neg ? '-' : sign;
    int total = n + zeros + (sc ? 1 : 0);
    if (!left && !(zero && prec < 0)) emit_pad(o, ' ', width - total);
    if (sc) emit(o, sc);
    if (!left && zero && prec < 0) emit_pad(o, '0', width - total);
    emit_pad(o, '0', zeros);
    while (n) emit(o, tmp[--n]);
    if (left) emit_pad(o, ' ', width - total);
}

static void fmt_float(out_t *o, double v, char conv, int width, int prec, int left, int zero, char sign) {
    char tmp[64];
    int n = 0;
    if (prec < 0) prec = 6;
    if (prec > 9) prec = 9;
    int neg = v < 0 || (v == 0 && 1 / v < 0);
    if (neg) v = -v;
    if (v != v) { tmp[n++] = 'n'; tmp[n++] = 'a'; tmp[n++] = 'n'; goto out; }
    if (v > 1e300) { tmp[n++] = 'i'; tmp[n++] = 'n'; tmp[n++] = 'f'; goto out; }
    int exp10 = 0;
    if (conv == 'g' || conv == 'G') {
        if (v != 0 && (v < 1e-4 || v >= 1e9)) conv = 'e';
        else { conv = 'f'; if (prec > 0) { double t = v; int d = 1; while (t >= 10) { t /= 10; d++; } prec = prec > d ? prec - d : 0; } }
    }
    if (conv == 'e' || conv == 'E') {
        while (v >= 10) { v /= 10; exp10++; }
        while (v != 0 && v < 1) { v *= 10; exp10--; }
    }
    double r = 0.5;
    for (int i = 0; i < prec; i++) r /= 10;
    v += r;
    if ((conv == 'e' || conv == 'E') && v >= 10) { v /= 10; exp10++; }
    unsigned long long ip = (unsigned long long)v;
    double fp = v - (double)ip;
    char itmp[24];
    int in = 0;
    do { itmp[in++] = (char)('0' + ip % 10); ip /= 10; } while (ip);
    while (in) tmp[n++] = itmp[--in];
    if (prec > 0) {
        tmp[n++] = '.';
        for (int i = 0; i < prec; i++) { fp *= 10; int d = (int)fp; tmp[n++] = (char)('0' + d); fp -= d; }
    }
    if (conv == 'e' || conv == 'E') {
        tmp[n++] = conv;
        tmp[n++] = exp10 < 0 ? '-' : '+';
        int e = exp10 < 0 ? -exp10 : exp10;
        tmp[n++] = (char)('0' + e / 10);
        tmp[n++] = (char)('0' + e % 10);
    }
out:;
    char sc = neg ? '-' : sign;
    int total = n + (sc ? 1 : 0);
    if (!left && !zero) emit_pad(o, ' ', width - total);
    if (sc) emit(o, sc);
    if (!left && zero) emit_pad(o, '0', width - total);
    for (int i = 0; i < n; i++) emit(o, tmp[i]);
    if (left) emit_pad(o, ' ', width - total);
}

int vsnprintf(char *buf, size_t cap, const char *f, va_list ap) {
    out_t o = {buf, cap, 0};
    for (; *f; f++) {
        if (*f != '%') { emit(&o, *f); continue; }
        f++;
        int left = 0, zero = 0, width = 0, prec = -1, lng = 0;
        char sign = 0;
        for (;; f++) {
            if (*f == '-') left = 1;
            else if (*f == '0') zero = 1;
            else if (*f == '+') sign = '+';
            else if (*f == ' ') { if (!sign) sign = ' '; }
            else if (*f == '#') {}
            else break;
        }
        if (*f == '*') { width = va_arg(ap, int); f++; if (width < 0) { left = 1; width = -width; } }
        else while (*f >= '0' && *f <= '9') width = width * 10 + (*f++ - '0');
        if (*f == '.') {
            f++;
            prec = 0;
            if (*f == '*') { prec = va_arg(ap, int); f++; }
            else while (*f >= '0' && *f <= '9') prec = prec * 10 + (*f++ - '0');
        }
        for (;; f++) {
            if (*f == 'l') lng++;
            else if (*f == 'z' || *f == 'j' || *f == 't') lng = 2;
            else if (*f == 'h') {}
            else break;
        }
        switch (*f) {
        case 'd': case 'i': {
            long long v = lng >= 2 ? va_arg(ap, long long) : lng == 1 ? va_arg(ap, long) : va_arg(ap, int);
            fmt_int(&o, (unsigned long long)(v < 0 ? -v : v), v < 0, 10, 0, width, prec, left, zero, sign);
            break;
        }
        case 'u': case 'x': case 'X': case 'o': {
            unsigned long long v = lng >= 2 ? va_arg(ap, unsigned long long)
                                 : lng == 1 ? va_arg(ap, unsigned long) : va_arg(ap, unsigned);
            int base = *f == 'u' ? 10 : *f == 'o' ? 8 : 16;
            fmt_int(&o, v, 0, base, *f == 'X', width, prec, left, zero, 0);
            break;
        }
        case 'p':
            emit(&o, '0'); emit(&o, 'x');
            fmt_int(&o, (uintptr_t)va_arg(ap, void *), 0, 16, 0, 8, -1, 0, 1, 0);
            break;
        case 'c': emit_pad(&o, ' ', left ? 0 : width - 1); emit(&o, (char)va_arg(ap, int)); if (left) emit_pad(&o, ' ', width - 1); break;
        case 's': {
            const char *s = va_arg(ap, const char *);
            if (!s) s = "(null)";
            int n = (int)strlen(s);
            if (prec >= 0 && n > prec) n = prec;
            if (!left) emit_pad(&o, ' ', width - n);
            for (int i = 0; i < n; i++) emit(&o, s[i]);
            if (left) emit_pad(&o, ' ', width - n);
            break;
        }
        case 'f': case 'F': case 'e': case 'E': case 'g': case 'G':
            fmt_float(&o, va_arg(ap, double), *f, width, prec, left, zero, sign);
            break;
        case '%': emit(&o, '%'); break;
        case 0: f--; break;
        default: emit(&o, '%'); emit(&o, *f);
        }
    }
    if (cap) buf[o.len < cap ? o.len : cap - 1] = 0;
    return (int)o.len;
}
int vsprintf(char *buf, const char *f, va_list ap) { return vsnprintf(buf, 1u << 20, f, ap); }
int snprintf(char *buf, size_t n, const char *f, ...) {
    va_list ap; va_start(ap, f); int r = vsnprintf(buf, n, f, ap); va_end(ap); return r;
}
int sprintf(char *buf, const char *f, ...) {
    va_list ap; va_start(ap, f); int r = vsnprintf(buf, 1u << 20, f, ap); va_end(ap); return r;
}
