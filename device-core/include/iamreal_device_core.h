/*
 * The C functions of device-core/ (ADR-0034): what the Android and iOS apps
 * call. Written by hand, to match prover/src/lib.rs; prover/tests/c_link.rs
 * builds a C program against this file and the static library.
 *
 * The conventions (device-core/README.md):
 *
 * - Bytes in: a pointer and a length. The core reads them during the call
 *   and keeps neither the pointer nor, unless the function says so, a
 *   copy. The caller owns them before and after, and overwrites what must
 *   not stay in memory.
 * - Bytes out: an idc_buf the core fills. The caller reads it, then gives
 *   it back with idc_buf_free, once; the core overwrites the bytes with
 *   zeros before it releases them. Never free() it.
 * - Every function that can fail returns one of the IDC_ codes. With any
 *   code but IDC_OK the idc_buf is empty (NULL, 0) and there is nothing to
 *   free.
 * - No function takes a PIN, opens a file or a socket, or calls back.
 * - The functions may be called from any thread. A call returns when its
 *   work is done.
 */
#ifndef IAMREAL_DEVICE_CORE_H
#define IAMREAL_DEVICE_CORE_H

#include <stddef.h>
#include <stdint.h>

#ifdef __cplusplus
extern "C" {
#endif

/* The version of these functions. It goes up when one changes or goes away. */
#define IDC_ABI_VERSION 1

/* The function did what it is for. */
#define IDC_OK 0
/* The call itself is wrong: a null pointer, or a number that is none of the
 * listed values. A mistake in the app's code. */
#define IDC_ERR_ARGUMENT 1
/* The bytes passed in are not what the function reads. */
#define IDC_ERR_INPUT 2
/* The core failed: a panic, or Barretenberg did not answer. */
#define IDC_ERR_INTERNAL 3

/* Which roster. An app is built for one and passes that one everywhere
 * (ADR-0036). */
#define IDC_ROSTER_PRODUCTION 0
#define IDC_ROSTER_TEST 1

/* Bytes the core hands to its caller. */
typedef struct idc_buf {
  uint8_t *ptr;
  size_t len;
} idc_buf;

/* IDC_ABI_VERSION of the library that is linked. */
uint32_t idc_abi_version(void);

/* Gives a buffer back to the core. *buf becomes empty, so a second call
 * with the same buf does nothing. buf may be NULL. */
void idc_buf_free(idc_buf *buf);

/* Checks that the Barretenberg linked into the library answers and computes
 * the Poseidon2 of spec/scoped-id.md: IDC_OK or IDC_ERR_INTERNAL. */
int32_t idc_self_check(void);

/* The scope string a card signs for `roster` (spec/scope.md): 31 bytes in
 * *out. */
int32_t idc_scope_string(uint32_t roster, idc_buf *out);

/* The declaration code (spec/declaration-code.md) of a list of accounts and
 * a challenge, in the scope of `roster`: 31 bytes in *out, the second
 * message the card signs.
 *
 * accounts_json: a JSON array of {"platform":"...","username":"..."}, in
 * ascending order of platform, each platform at most once.
 * challenge: the challenge as the server issued it.
 * IDC_ERR_INPUT when the list is not that, or the challenge is not in its
 * one spelling. */
int32_t idc_declaration_code(uint32_t roster,
                             const uint8_t *accounts_json, size_t accounts_json_len,
                             const uint8_t *challenge, size_t challenge_len,
                             idc_buf *out);

/* What a list does on every platform, before the card signs it
 * (spec/list-consequence.md): JSON in *out, for the confirmation screen.
 *
 * platforms_json: the `platforms` of GET /api/v1/config, as the server
 * sent it.
 * card_state_json: the answer of POST /api/v1/card-state, as the server
 * sent it.
 * accounts_json: the cardholder's list for the platforms offered, in the
 * shape of a record's accounts (ascending order of platform, each platform
 * at most once). The kept accounts are not in it: the core adds them.
 * now: seconds since 1970-01-01T00:00:00Z by the device's clock; the date
 * is the one in Taiwan.
 *
 * *out is one of:
 *   {"valid":true,"accounts":[...],"rows":[{"platform":"threads","known":true,"kind":"switch","username":"carol","current":"bob","previous":"bob","switches_left":3}],"first_record":false}
 *   {"valid":false,"reason":"switch_limit","platform":"threads"}
 *   {"valid":false,"reason":"username","platform":"threads"}
 *   {"valid":false,"reason":"empty"}   (or "daily_limit")
 * accounts is the list the card signs (pass it to idc_declaration_code); a
 * row and the reasons are those of spec/list-consequence.md, "What the list
 * does". valid false is not offered for signing.
 *
 * IDC_ERR_INPUT when the table or the state cannot be read, when the list
 * names a platform that is not offered or is not in the shape above, or
 * when now is outside the years 2000 to 2049 in Taiwan. */
int32_t idc_list_consequence(const uint8_t *platforms_json, size_t platforms_json_len,
                             const uint8_t *card_state_json, size_t card_state_json_len,
                             const uint8_t *accounts_json, size_t accounts_json_len,
                             int64_t now, idc_buf *out);

#ifdef __cplusplus
}
#endif

#endif
