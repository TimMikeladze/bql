/*
** The SQL functions and modules bql.sh adds to every connection of the vendored build: sqlite-vec
** (`vec0`, `vec_*`) and bql.sh's own geo functions. `docs/x1-search.md`.
**
** Why an auto-extension rather than `load_extension`: the server refuses `load_extension()` from
** client SQL (`src/server/auth.ts`), and a capability that has to be loaded per connection is one
** some connection forgets. `sqlite3_auto_extension` runs the entry point below inside every
** `sqlite3_open_v2` from the moment it is registered, so the tenant's writer, its readers, a
** replica's apply connection and a bare `Database.open()` all have the same functions.
**
** Registration is an explicit call, `bql_ext_init`, which `src/sqlite/lib.ts` makes once when it
** loads the library. Not a load-time constructor: `__attribute__((constructor))` is a GCC/Clang
** extension whose behaviour inside a Windows DLL depends on the CRT, and an explicit call is the
** same one line on every platform. It is idempotent — SQLite ignores a second registration of the
** same entry point.
**
** Invariant: everything registered here is deterministic and innocuous. A trigger or a view may
** call it under `PRAGMA trusted_schema = off`, which is how `ftsIndex`/`geoIndex` keep their
** indexes in sync, and none of it touches the filesystem — sqlite-vec is compiled with
** `SQLITE_VEC_OMIT_FS`, so its `vec_npy_each` file reader does not exist in this build.
*/

#include <math.h>

#include "sqlite3.h"

#ifndef BQL_API
#define BQL_API
#endif

/* sqlite-vec's entry point, from the pinned amalgamation compiled beside this file. */
extern int sqlite3_vec_init(sqlite3 *db, char **pzErrMsg, const sqlite3_api_routines *pApi);

/* The capability bits `bql_ext_features` reports; `src/sqlite/lib.ts` reads them as `vec`, `geo`. */
#define BQL_EXT_VEC 1
#define BQL_EXT_GEO 2

/* IUGG mean Earth radius. Haversine on a sphere is within 0.5% of the ellipsoid everywhere, which
** is the precision a "within 5 km" query asks for; a caller wanting survey accuracy wants Vincenty
** and a different library. */
#define BQL_EARTH_RADIUS_M 6371008.8

#define BQL_PI 3.14159265358979323846
#define BQL_RAD(d) ((d) * (BQL_PI / 180.0))
#define BQL_DEG(r) ((r) * (180.0 / BQL_PI))

/* Reads `argc` doubles. Returns 0 — and the function returns NULL — if any argument is NULL, the
** SQL rule for arithmetic on an unknown. */
static int bql_doubles(int argc, sqlite3_value **argv, double *out) {
  int i;
  for (i = 0; i < argc; i++) {
    if (sqlite3_value_type(argv[i]) == SQLITE_NULL) return 0;
    out[i] = sqlite3_value_double(argv[i]);
  }
  return 1;
}

static double bql_haversine_m(double lat1, double lon1, double lat2, double lon2) {
  double p1 = BQL_RAD(lat1);
  double p2 = BQL_RAD(lat2);
  double dp = BQL_RAD(lat2 - lat1);
  double dl = BQL_RAD(lon2 - lon1);
  double a = sin(dp / 2) * sin(dp / 2) + cos(p1) * cos(p2) * sin(dl / 2) * sin(dl / 2);
  /* Rounding can carry `a` a hair past 1 for antipodal points, and sqrt of that is still fine but
  ** asin of it is NaN. */
  if (a > 1.0) a = 1.0;
  return 2.0 * BQL_EARTH_RADIUS_M * asin(sqrt(a));
}

/* bql_haversine(lat1, lon1, lat2, lon2) → great-circle distance in metres. */
static void bql_haversine_fn(sqlite3_context *ctx, int argc, sqlite3_value **argv) {
  double v[4];
  if (!bql_doubles(argc, argv, v)) return;
  sqlite3_result_double(ctx, bql_haversine_m(v[0], v[1], v[2], v[3]));
}

/*
** The bounding box of every point within `radius` metres of (lat, lon), as four functions so each
** can be an R*Tree constraint on its own. The longitude span is the exact one for a circle on a
** sphere (asin(sin(r)/cos(lat)), not r/cos(lat), which is too narrow near the poles).
**
** Two cases give up precision rather than correctness, returning the full longitude range: a
** circle that reaches a pole, and one that crosses the antimeridian. The box is only ever a
** prefilter in front of an exact haversine test, so a box that is too large costs a scan and a
** box that is too small would lose rows. The edge is selected by the function's user data.
*/
enum { BQL_MIN_LAT, BQL_MAX_LAT, BQL_MIN_LON, BQL_MAX_LON };

static void bql_bbox_fn(sqlite3_context *ctx, int argc, sqlite3_value **argv) {
  double v[3];
  int edge = *(const int *)sqlite3_user_data(ctx);
  double lat, lon, r, minLat, maxLat, minLon, maxLon;
  if (!bql_doubles(argc, argv, v)) return;
  lat = v[0];
  lon = v[1];
  r = v[2] < 0 ? 0 : v[2] / BQL_EARTH_RADIUS_M;
  minLat = lat - BQL_DEG(r);
  maxLat = lat + BQL_DEG(r);
  minLon = -180.0;
  maxLon = 180.0;
  if (minLat > -90.0 && maxLat < 90.0) {
    double s = sin(r) / cos(BQL_RAD(lat));
    if (s < 1.0) {
      double dl = BQL_DEG(asin(s));
      if (lon - dl >= -180.0 && lon + dl <= 180.0) {
        minLon = lon - dl;
        maxLon = lon + dl;
      }
    }
  } else {
    if (minLat < -90.0) minLat = -90.0;
    if (maxLat > 90.0) maxLat = 90.0;
  }
  switch (edge) {
    case BQL_MIN_LAT: sqlite3_result_double(ctx, minLat); break;
    case BQL_MAX_LAT: sqlite3_result_double(ctx, maxLat); break;
    case BQL_MIN_LON: sqlite3_result_double(ctx, minLon); break;
    default: sqlite3_result_double(ctx, maxLon); break;
  }
}

static const int bql_edges[4] = {BQL_MIN_LAT, BQL_MAX_LAT, BQL_MIN_LON, BQL_MAX_LON};

static int bql_geo_init(sqlite3 *db) {
  static const char *names[4] = {
      "bql_bbox_min_lat", "bql_bbox_max_lat", "bql_bbox_min_lon", "bql_bbox_max_lon"};
  const int flags = SQLITE_UTF8 | SQLITE_DETERMINISTIC | SQLITE_INNOCUOUS;
  int i;
  int rc = sqlite3_create_function_v2(db, "bql_haversine", 4, flags, 0, bql_haversine_fn, 0, 0, 0);
  for (i = 0; i < 4 && rc == SQLITE_OK; i++) {
    rc = sqlite3_create_function_v2(db, names[i], 3, flags, (void *)&bql_edges[i], bql_bbox_fn, 0,
                                    0, 0);
  }
  return rc;
}

/* Runs inside every sqlite3_open_v2 once registered. A failure here fails the open, which is the
** right answer: a connection missing half its functions would fail later and more confusingly. */
static int bql_ext_entry(sqlite3 *db, char **pzErrMsg, const sqlite3_api_routines *pApi) {
  int rc = sqlite3_vec_init(db, pzErrMsg, pApi);
  if (rc != SQLITE_OK) return rc;
  return bql_geo_init(db);
}

/* Registers the auto-extension. Returns an SQLite result code. */
BQL_API int bql_ext_init(void) {
  return sqlite3_auto_extension((void (*)(void))bql_ext_entry);
}

/* What this build carries, as BQL_EXT_* bits. */
BQL_API int bql_ext_features(void) {
  return BQL_EXT_VEC | BQL_EXT_GEO;
}
