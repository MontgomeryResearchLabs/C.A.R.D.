/* Minimal stdio for the simulator: printf family writes to the sim console. */
#ifndef _SIM_STDIO_H
#define _SIM_STDIO_H
#include <stddef.h>
#include <stdarg.h>
#define EOF (-1)
typedef struct sim_file FILE;
extern FILE *stdout, *stderr, *stdin;
int printf(const char *fmt, ...) __attribute__((format(printf, 1, 2)));
int vprintf(const char *fmt, va_list ap);
int sprintf(char *buf, const char *fmt, ...);
int snprintf(char *buf, size_t n, const char *fmt, ...);
int vsnprintf(char *buf, size_t n, const char *fmt, va_list ap);
int vsprintf(char *buf, const char *fmt, va_list ap);
int fprintf(FILE *f, const char *fmt, ...);
int puts(const char *s);
int putchar(int c);
int fputs(const char *s, FILE *f);
int fflush(FILE *f);
int getchar(void);
#endif
