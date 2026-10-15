#ifndef _SIM_STDLIB_H
#define _SIM_STDLIB_H
#include <stddef.h>
#define RAND_MAX 0x7fffffff
#define EXIT_SUCCESS 0
#define EXIT_FAILURE 1
void *malloc(size_t n);
void *calloc(size_t n, size_t sz);
void *realloc(void *p, size_t n);
void free(void *p);
int abs(int x);
long labs(long x);
int rand(void);
void srand(unsigned seed);
int atoi(const char *s);
long strtol(const char *s, char **end, int base);
unsigned long strtoul(const char *s, char **end, int base);
float strtof(const char *s, char **end);
double atof(const char *s);
void qsort(void *base, size_t n, size_t sz, int (*cmp)(const void *, const void *));
void abort(void) __attribute__((noreturn));
void exit(int code) __attribute__((noreturn));
#endif
