/*
 * A C program that calls the library the way an app does, built by
 * tests/c_link.rs against include/iamreal_device_core.h and the static
 * library. It exits with 0 when every call gave what the specification
 * says, otherwise with the number of the check that failed.
 */
#include <string.h>

#include "iamreal_device_core.h"

static int same(const idc_buf *buf, const char *expected) {
  return buf->ptr != NULL && buf->len == strlen(expected) && memcmp(buf->ptr, expected, buf->len) == 0;
}

int main(void) {
  static const char accounts[] = "[{\"platform\":\"threads\",\"username\":\"alice\"}]";
  static const char challenge[] = "2026-11-16.000G40R40M30E209185GR38E1W";
  idc_buf out = {NULL, 0};

  if (idc_abi_version() != IDC_ABI_VERSION) return 1;
  if (idc_self_check() != IDC_OK) return 2;

  if (idc_scope_string(IDC_ROSTER_TEST, &out) != IDC_OK) return 3;
  if (!same(&out, "iamreal-test:public:0__________")) return 4;
  idc_buf_free(&out);
  if (out.ptr != NULL || out.len != 0) return 5;
  idc_buf_free(&out);

  /* The example written out in spec/declaration-code.md. This program reads
   * no file: tests/c_api.rs runs every case of spec/vectors/ through the
   * same functions. */
  if (idc_declaration_code(IDC_ROSTER_PRODUCTION, (const uint8_t *)accounts, strlen(accounts),
                           (const uint8_t *)challenge, strlen(challenge), &out) != IDC_OK) return 6;
  if (!same(&out, "DYR31H79A046QB7TZR3EZ26GGF20ZV9")) return 7;
  idc_buf_free(&out);

  if (idc_declaration_code(IDC_ROSTER_PRODUCTION, (const uint8_t *)"x", 1,
                           (const uint8_t *)challenge, strlen(challenge), &out) != IDC_ERR_INPUT) return 8;
  if (out.ptr != NULL || out.len != 0) return 9;
  if (idc_scope_string(2, &out) != IDC_ERR_ARGUMENT) return 10;

  /* A first declaration on a card without a record, on 2026-11-16 in Taiwan. */
  {
    static const char platforms[] =
        "[{\"platform\":\"threads\",\"display_name\":\"Threads\",\"username_format\":\"[a-z0-9._]{1,30}\"}]";
    static const char state[] =
        "{\"last_card_proof\":null,\"proofs_on_last_date\":0,\"platforms\":{\"threads\":"
        "{\"current\":null,\"last_declared\":null,\"switch_count\":0,\"correction_date\":null}},\"count\":0}";
    static const char known[] = "[\"threads\"]";
    if (idc_list_consequence((const uint8_t *)platforms, strlen(platforms), (const uint8_t *)state,
                             strlen(state), (const uint8_t *)known, strlen(known),
                             (const uint8_t *)accounts, strlen(accounts),
                             INT64_C(1794801600), &out) != IDC_OK) return 11;
    /* What it holds is checked in tests/c_list_consequence.rs; here, that the call links. */
    if (out.ptr == NULL || out.len == 0) return 12;
    idc_buf_free(&out);
  }

  /* A session that checked nothing gives no scoped ID. */
  {
    static const uint8_t signature[256] = {1};
    idc_session session = 0;
    if (idc_session_open(IDC_ROSTER_TEST, &session) != IDC_OK || session == 0) return 13;
    if (idc_session_card_state_request(session, 1794800000, signature, sizeof signature, &out) != IDC_ERR_REFUSED) return 14;
    if (out.ptr != NULL || out.len != 0) return 15;
    if (idc_session_build_tree(session) != IDC_ERR_REFUSED) return 16;
    if (idc_session_check_artifacts(session, NULL, 0, NULL, 0, NULL, 0, NULL, 0) != IDC_ERR_REFUSED) return 17;
    /* Nor a proof. */
    if (idc_session_records_request(session, NULL, 0, NULL, 0, NULL, 0, NULL, 0, (const uint8_t *)accounts,
                                    strlen(accounts), (const uint8_t *)challenge, strlen(challenge), signature,
                                    sizeof signature, signature, sizeof signature, &out) != IDC_ERR_REFUSED) return 18;
    if (out.ptr != NULL || out.len != 0) return 19;
    /* No certificate: the card proof stops with a reason code. */
    if (idc_session_check_certificates(session, 1794800000, &out) != IDC_OK) return 20;
    if (!same(&out, "{\"ok\":false,\"problem\":\"no_certificate\"}")) return 21;
    idc_buf_free(&out);
    idc_session_close(session);
    idc_session_close(session);
    if (idc_session_build_tree(session) != IDC_ERR_ARGUMENT) return 22;
  }
  return 0;
}
