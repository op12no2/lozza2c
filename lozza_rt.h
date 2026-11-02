//
// lozza2c runtime helpers, included at the top of the generated C.
//

#include <ctype.h>

static inline int32_t lz_imul  (int32_t a, int32_t b) { return (int32_t)((uint32_t)a * (uint32_t)b); }
static inline int32_t lz_abs32 (int32_t x)            { return x < 0 ? -x : x; }
static inline int64_t lz_abs64 (int64_t x)            { return x < 0 ? -x : x; }
static inline int32_t lz_max32 (int32_t a, int32_t b) { return a > b ? a : b; }
static inline int32_t lz_min32 (int32_t a, int32_t b) { return a < b ? a : b; }
static inline int64_t lz_max64 (int64_t a, int64_t b) { return a > b ? a : b; }
static inline int64_t lz_min64 (int64_t a, int64_t b) { return a < b ? a : b; }
static inline double  lz_sign  (double x)             { return x > 0 ? 1.0 : (x < 0 ? -1.0 : 0.0); }

// (a / b) | 0 with JS semantics: division by zero gives Infinity or NaN, which | 0 makes 0

static inline int32_t lz_idiv (int64_t a, int64_t b) { return b == 0 ? 0 : (int32_t)(a / b); }

// JS ToInt32 of a double: NaN and infinities give 0, otherwise truncate and wrap modulo 2^32

static inline int32_t lz_toint32 (double d) {
  if (d != d || d > 1e300 || d < -1e300) return 0;
  if (d >= -2147483648.0 && d <= 2147483647.0) return (int32_t)d;
  double t = trunc(d);
  double m = fmod(t, 4294967296.0);
  if (m < 0) m += 4294967296.0;
  return (int32_t)(uint32_t)m;
}
static inline int32_t lz_fdiv (double a, double b)   { double d = a / b; return (d != d || d > 2147483647.0 || d < -2147483648.0) ? 0 : (int32_t)d; }

#define LZ_FILL(E, CT, VT) static inline void lz_fill_##E (CT* a, int64_t n, VT v) { for (int64_t i = 0; i < n; i++) a[i] = (CT)v; }
LZ_FILL(i8,  int8_t,   int32_t)
LZ_FILL(u8,  uint8_t,  int32_t)
LZ_FILL(i16, int16_t,  int32_t)
LZ_FILL(u16, uint16_t, int32_t)
LZ_FILL(i32, int32_t,  int32_t)
LZ_FILL(u32, uint32_t, uint32_t)
LZ_FILL(u64, uint64_t, uint64_t)
LZ_FILL(f64, double,   double)

#define LZ_REALLOC(E, CT) static inline void lz_realloc_##E (CT** p, int32_t* len, int64_t n) { free(*p); *p = (CT*)calloc((size_t)(n > 0 ? n : 1), sizeof(CT)); *len = (int32_t)n; }
LZ_REALLOC(i8,  int8_t)
LZ_REALLOC(u8,  uint8_t)
LZ_REALLOC(i16, int16_t)
LZ_REALLOC(u16, uint16_t)
LZ_REALLOC(i32, int32_t)
LZ_REALLOC(u32, uint32_t)
LZ_REALLOC(u64, uint64_t)
LZ_REALLOC(f64, double)

//{{{  strings
//
// String values are const char*. Results of concatenation and the other
// string functions live in a ring of static buffers, which is plenty for
// the short lived strings lozza builds (fens, moves, info lines, tokens).
//

#define LZ_RING 1024
#define LZ_BUF  16384   // longest string: a position command with a few thousand plies

static char lz_ring[LZ_RING][LZ_BUF];
static int  lz_ring_i = 0;

static inline char* lz_buf (void) { lz_ring_i = (lz_ring_i + 1) % LZ_RING; return lz_ring[lz_ring_i]; }

static inline const char* lz_cat (const char* a, const char* b) {
  char* d = lz_buf();
  size_t la = strlen(a);
  if (la >= LZ_BUF) la = LZ_BUF - 1;
  memcpy(d, a, la);
  size_t lb = strlen(b);
  if (la + lb >= LZ_BUF) lb = LZ_BUF - 1 - la;
  memcpy(d + la, b, lb);
  d[la + lb] = 0;
  return d;
}

static inline const char* lz_i64s (int64_t v) { char* d = lz_buf(); snprintf(d, LZ_BUF, "%lld", (long long)v); return d; }
static inline const char* lz_chrs (char c)    { char* d = lz_buf(); d[0] = c; d[1] = 0; return d; }

static inline const char* lz_f64s (double v) {
  char* d = lz_buf();
  if (v == (double)(int64_t)v && v > -1e15 && v < 1e15)
    snprintf(d, LZ_BUF, "%lld", (long long)v);
  else
    snprintf(d, LZ_BUF, "%.15g", v);
  return d;
}

static inline int lz_streq    (const char* a, const char* b) { return strcmp(a, b) == 0; }
static inline int lz_strEmpty (const char* s)                { return s == NULL || s[0] == 0; }

static inline int32_t lz_parseInt (const char* s) { return (int32_t)strtol(s, NULL, 10); }

static inline const char* lz_trim (const char* s) {
  while (*s && isspace((unsigned char)*s)) s++;
  size_t n = strlen(s);
  while (n > 0 && isspace((unsigned char)s[n-1])) n--;
  char* d = lz_buf();
  if (n >= LZ_BUF) n = LZ_BUF - 1;
  memcpy(d, s, n);
  d[n] = 0;
  return d;
}

static inline const char* lz_lower (const char* s) {
  char* d = lz_buf();
  size_t i = 0;
  for (; s[i] && i < LZ_BUF - 1; i++) d[i] = (char)tolower((unsigned char)s[i]);
  d[i] = 0;
  return d;
}

static inline const char* lz_upper (const char* s) {
  char* d = lz_buf();
  size_t i = 0;
  for (; s[i] && i < LZ_BUF - 1; i++) d[i] = (char)toupper((unsigned char)s[i]);
  d[i] = 0;
  return d;
}

static inline const char* lz_stripNewlines (const char* s) {
  char* d = lz_buf();
  size_t j = 0;
  for (size_t i = 0; s[i] && j < LZ_BUF - 1; i++)
    if (s[i] != '\n' && s[i] != '\r') d[j++] = s[i];
  d[j] = 0;
  return d;
}

static inline const char* lz_collapseWs (const char* s) {
  char* d = lz_buf();
  size_t j = 0;
  int ws = 0;
  for (size_t i = 0; s[i] && j < LZ_BUF - 1; i++) {
    if (isspace((unsigned char)s[i])) { if (!ws) d[j++] = ' '; ws = 1; }
    else { d[j++] = s[i]; ws = 0; }
  }
  d[j] = 0;
  return d;
}

static inline const char* lz_padStart (const char* s, int32_t width, char pad) {
  char* d = lz_buf();
  int32_t n = (int32_t)strlen(s);
  int32_t p = width - n;
  if (p < 0) p = 0;
  if (p >= LZ_BUF - 1) p = LZ_BUF - 2;
  memset(d, pad, (size_t)p);
  strncpy(d + p, s, (size_t)(LZ_BUF - 1 - p));
  d[LZ_BUF - 1] = 0;
  return d;
}

static inline int32_t lz_indexOfStr (const char** arr, int32_t n, const char* s) {
  for (int32_t i = 0; i < n; i++)
    if (strcmp(arr[i], s) == 0)
      return i;
  return -1;
}

//}}}
//{{{  string arrays
//
// JS arrays of strings (tokens, move lists, the command queue). Fixed
// capacity, heap allocated entries, always used through a pointer.
//

#define LZ_STRARR_CAP 4096   // tokens per line, i.e. plies in a position command

typedef struct { int32_t n; char* s[LZ_STRARR_CAP]; } strarr_t;

static inline void lz_strarr_init (strarr_t* a) { a->n = 0; }

static inline void lz_strarr_free (strarr_t* a) {
  for (int32_t i = 0; i < a->n; i++) free(a->s[i]);
  a->n = 0;
}

static inline void lz_strarr_push (strarr_t* a, const char* s) {
  if (a->n >= LZ_STRARR_CAP) return;
  size_t n = strlen(s);
  char* d = (char*)malloc(n + 1);
  memcpy(d, s, n + 1);
  a->s[a->n++] = d;
}

static inline const char* lz_strarr_shift (strarr_t* a) {
  if (a->n == 0) return "";
  char* d = lz_buf();
  strncpy(d, a->s[0], LZ_BUF - 1);
  d[LZ_BUF - 1] = 0;
  free(a->s[0]);
  a->n--;
  memmove(&a->s[0], &a->s[1], (size_t)a->n * sizeof(char*));
  return d;
}

static inline void lz_strarr_splice (strarr_t* a, int32_t i) {
  if (i < 0 || i >= a->n) return;
  free(a->s[i]);
  a->n--;
  memmove(&a->s[i], &a->s[i+1], (size_t)(a->n - i) * sizeof(char*));
}

// split on a single character; runs of whitespace separators count as one,
// matching lozza's use after collapsing whitespace

static inline strarr_t* lz_strarr_split (strarr_t* a, const char* s, char sep) {
  lz_strarr_free(a);
  const char* p = s;
  while (*p) {
    const char* q = p;
    while (*q && *q != sep) q++;
    size_t n = (size_t)(q - p);
    char* d = (char*)malloc(n + 1);
    memcpy(d, p, n);
    d[n] = 0;
    if (a->n < LZ_STRARR_CAP) a->s[a->n++] = d; else free(d);
    if (*q == 0) break;
    p = q + 1;
  }
  if (a->n == 0) lz_strarr_push(a, "");
  return a;
}

static strarr_t lz_strarr_scratch_s;
static strarr_t lz_strarr_empty_s;

static inline strarr_t* lz_strarr_scratch (void) { return &lz_strarr_scratch_s; }
static inline strarr_t* lz_strarr_empty   (void) { lz_strarr_empty_s.n = 0; return &lz_strarr_empty_s; }

//}}}
