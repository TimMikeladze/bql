// bql native shim: exposes the connection handle and API function pointers to JS via SQL functions.
#include <stdint.h>
#include <string.h>
#include "sqlite3ext.h"
SQLITE_EXTENSION_INIT1
static void fn_db(sqlite3_context *ctx, int n, sqlite3_value **v) { sqlite3_result_int64(ctx, (sqlite3_int64)(intptr_t)sqlite3_context_db_handle(ctx)); }
static void fn_api(sqlite3_context *ctx, int n, sqlite3_value **v) {
  const char *name = (const char*)sqlite3_value_text(v[0]); void *p = 0;
  #define F(x) if (!strcmp(name, #x)) p = (void*)sqlite3_api->x;
  F(wal_hook) F(update_hook) F(commit_hook) F(rollback_hook) 
  F(set_authorizer) F(progress_handler) F(limit) F(busy_timeout) F(db_config) F(db_status) F(status64) 
  F(value_text) F(value_type) F(value_int64) F(value_double) F(value_blob) F(value_bytes)
  F(free) F(db_filename) F(db_readonly) F(errmsg) F(libversion) F(get_autocommit) F(total_changes64) F(changes64)
  F(open_v2) F(close_v2) F(prepare_v3) F(step) F(reset) F(finalize) F(bind_int64) F(bind_double) F(bind_text) F(bind_blob) F(bind_null) F(column_count) F(column_type) F(column_int64) F(column_double) F(column_text) F(column_blob) F(column_bytes) F(column_name) F(wal_checkpoint_v2) F(file_control)
  #undef F
  if (p) sqlite3_result_int64(ctx, (sqlite3_int64)(intptr_t)p); else sqlite3_result_null(ctx);
}
int sqlite3_bqlnative_init(sqlite3 *db, char **err, const sqlite3_api_routines *api) {
  SQLITE_EXTENSION_INIT2(api);
  sqlite3_create_function(db, "bql_db", 0, SQLITE_UTF8 | SQLITE_DIRECTONLY, 0, fn_db, 0, 0);
  sqlite3_create_function(db, "bql_api", 1, SQLITE_UTF8 | SQLITE_DIRECTONLY, 0, fn_api, 0, 0);
  return SQLITE_OK;
}
