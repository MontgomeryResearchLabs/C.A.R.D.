#ifndef _SIM_ASSERT_H
#define _SIM_ASSERT_H
void __sim_assert_fail(const char *expr, const char *file, int line) __attribute__((noreturn));
#ifdef NDEBUG
#define assert(x) ((void)0)
#else
#define assert(x) ((x) ? (void)0 : __sim_assert_fail(#x, __FILE__, __LINE__))
#endif
#define static_assert _Static_assert
#endif
