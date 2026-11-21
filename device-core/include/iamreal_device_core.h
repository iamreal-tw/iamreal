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
 *   not stay in memory. What the core does keep, it keeps in a session
 *   and overwrites with zeros when the session is closed.
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
/* The session has not passed the checks this function needs first. */
#define IDC_ERR_REFUSED 4

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
 * ascending order of platform, each platform at most once, each username 1
 * or more printable ASCII characters without '"' and '\'.
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
 * known_platforms_json: the platforms the app has its own definition of
 * (its names, how it writes an account), a JSON array of platform IDs, none
 * twice. Built into the app, never from the server.
 * accounts_json: the cardholder's list for the platforms offered, in the
 * shape of a record's accounts (ascending order of platform, each platform
 * at most once), each username as typed after the app tidied it. The kept
 * accounts are not in it: the core adds them.
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
 * names a platform that is not offered or is not in the shape above (a
 * mistake of the app, but one the core sees only in the bytes), when the
 * known platforms are not in the shape above, or when now is outside the
 * years 2000 to 2049 in Taiwan. */
int32_t idc_list_consequence(const uint8_t *platforms_json, size_t platforms_json_len,
                             const uint8_t *card_state_json, size_t card_state_json_len,
                             const uint8_t *known_platforms_json, size_t known_platforms_json_len,
                             const uint8_t *accounts_json, size_t accounts_json_len,
                             int64_t now, idc_buf *out);

/* The state of a card as the screen of its accounts shows it, before the
 * cardholder changes the list (spec/list-consequence.md, "The card's
 * state, as shown"): JSON in *out.
 *
 * platforms_json, card_state_json, known_platforms_json and now are those
 * of idc_list_consequence, and are read the same way.
 *
 * *out is:
 *   {"last_card_proof":"2026-11-04","days_since":12,"daily_limit":false,
 *    "known_platforms":["threads"],
 *    "rows":[{"platform":"test-example","known":false,"current":"alice-b"},
 *            {"platform":"threads","known":true,"current":"alice","last_declared":"alice",
 *             "switch_count":1,"switches_left":4,"correction_today":false}]}
 * last_card_proof is the date of the card's last valid record, or null;
 * days_since the days from it to today, or null; daily_limit that the card
 * has 3 valid records dated today, so no list can be declared today;
 * known_platforms the platforms of the table the device knows, in
 * ascending order, offered or not. rows, in ascending order of platform:
 * one for every platform offered (known true: the entry of the state, the
 * switches left by the rules, and whether a change today is a correction)
 * and one for every kept account (known false: shown as it is, not
 * changed).
 *
 * IDC_ERR_INPUT when the table or the state cannot be read, when the known
 * platforms are not in the shape idc_list_consequence takes, or when now is
 * outside the years 2000 to 2049 in Taiwan. */
int32_t idc_card_status(const uint8_t *platforms_json, size_t platforms_json_len,
                        const uint8_t *card_state_json, size_t card_state_json_len,
                        const uint8_t *known_platforms_json, size_t known_platforms_json_len,
                        int64_t now, idc_buf *out);

/* The short ID of a scoped ID (spec/scoped-id.md): the first 10 characters
 * of its text form, in *out. The screens and the address of the card's
 * page write it.
 *
 * scoped_id: the 52 characters of a scoped ID in its one spelling, as the
 * body of idc_session_card_state_request has it. IDC_ERR_INPUT for
 * anything else. */
int32_t idc_short_id(const uint8_t *scoped_id, size_t scoped_id_len, idc_buf *out);

/*
 * A session: one card proof in progress (device-core/README.md, "檢查都通過
 * 了"). The core keeps what it checked; the app holds the number that names
 * the session. The steps, each allowed only after the ones before it
 * (IDC_ERR_REFUSED otherwise):
 *
 *   idc_session_add_certificate, once per certificate the card returned
 *   idc_session_check_certificates       1. the certificate
 *   idc_session_choose_crl               2. the CRL: which file,
 *   idc_session_check_crl                   then the file
 *   idc_session_build_tree               3. the tree
 *   idc_session_check_artifacts          4. the circuit and its parameters
 *                                           (any time after step 1)
 *   idc_session_check_date               the date conditions again, when
 *                                        the date has changed
 *   idc_session_card_state_request       only after 1 to 4 all passed,
 *                                        on the date they hold for
 *   idc_session_records_request          likewise, on the date of the
 *                                        challenge: the proof
 *
 * Step 1 again starts the session over; step 2 again forgets the tree.
 *
 * A step whose answer is a reason code of spec/device-checks.md returns
 * IDC_OK and JSON with "ok": false and "problem": the card proof stops
 * there, and the session passes nothing further until the step is done
 * again and passes. The JSON of each function is described in
 * prover/src/session.rs.
 *
 * `now` is the device's clock, in seconds since 1970-01-01T00:00:00Z; the
 * core takes the date in Taiwan from it. What a session checked holds for
 * one date: the date of step 1, which the CRL is checked on too, until
 * idc_session_check_date moves it. IDC_ERR_ARGUMENT for a number that
 * names no session, and for a clock outside the years 2000 to 2049: no
 * certificate is valid then, the app says to check the phone's clock, and
 * the session starts over (the certificates added are overwritten).
 *
 * One call at a time runs on a session; a second call waits. Every idc_buf
 * a session function fills is the caller's to give back with idc_buf_free.
 */
typedef uint64_t idc_session;

/* Opens a session on `roster`: its number in *out, never 0. Close it with
 * idc_session_close, whatever happened in between. */
int32_t idc_session_open(uint32_t roster, idc_session *out);

/* Closes a session. The certificate, the name on it and everything the
 * core computed from them are overwritten with zeros and released; if
 * another thread is inside a call on the session, when that call returns.
 * A number that names no session (0, one already closed) does nothing. */
void idc_session_close(idc_session session);

/* Adds one certificate the card returned (DER), in the card's order. The
 * core keeps a copy until idc_session_check_certificates, which overwrites
 * every copy but the chosen certificate's; the caller overwrites its own
 * bytes when it no longer needs them. */
int32_t idc_session_add_certificate(idc_session session,
                                    const uint8_t *certificate, size_t certificate_len);

/* Step 1 (spec/device-checks.md, "The certificate"): chooses and checks
 * the certificate among those added. JSON in *out:
 *   {"ok":true,"chosen":0,"issuer":"G3","name":"...","not_before":"YYMMDDHHMMSS","not_after":"..."}
 *   {"ok":false,"problem":"expired","not_after":"..."}
 * `chosen` is the certificate's place among those added; `name` is the
 * name to show before the PIN, and goes nowhere else. *out holds that
 * name: give it back as soon as the name is on the screen. */
int32_t idc_session_check_certificates(idc_session session, int64_t now, idc_buf *out);

/* Step 2, first half ("Choosing a file from the index"). index: the body
 * of the mirror's index.jsonl. JSON in *out:
 *   {"ok":true,"crl_number":"...","sha256":"..."}    download <sha256>.crl
 *   {"ok":false,"problem":"crl_unavailable"}
 * An index or a file that cannot be downloaded is crl_unavailable too;
 * the app says so without asking the core. */
int32_t idc_session_choose_crl(idc_session session,
                               const uint8_t *index, size_t index_len, idc_buf *out);

/* Step 2, second half ("Checking the file"), on the date of step 1, and
 * whether the certificate is on the CRL.
 *   crl:     the body of <sha256>.crl
 *   config:  the body of GET /api/v1/config; crl_max_age_days is read
 *   highest: the highest CRL number this device remembers for the issuer,
 *            in decimal digits; (NULL, 0) for none
 * JSON in *out; "highest_after" is what the app remembers for the issuer
 * from now on (null for none):
 *   {"ok":true,"crl_number":"...","crl_date":"YYYY-MM-DD","sha256":"...","highest_after":"..."}
 *   {"ok":false,"problem":"crl_hash","highest_after":...}
 *   {"ok":false,"problem":"crl_unusable","reason":"not_usable_...","highest_after":...}
 *   {"ok":false,"problem":"crl_rollback","crl_number":"...","highest":"...","highest_after":...}
 *   {"ok":false,"problem":"crl_stale","days":4,"max_age_days":3,"highest_after":...}
 *   {"ok":false,"problem":"revoked","highest_after":"..."}
 *   {"ok":false,"problem":"malformed_response","highest_after":...}
 * IDC_ERR_INPUT when `highest` is not a number in decimal. */
int32_t idc_session_check_crl(idc_session session,
                              const uint8_t *crl, size_t crl_len,
                              const uint8_t *config, size_t config_len,
                              const uint8_t *highest, size_t highest_len,
                              idc_buf *out);

/* Step 3: builds the revocation tree of the CRL that passed, and the path
 * of the certificate's serial number, in 4 parts on 4 threads. Returns
 * when it is built: call it from a background thread. */
int32_t idc_session_build_tree(idc_session session);

/* Step 4 (ADR-0035): the files the app carries are the ones whose SHA-256
 * is written into the core: the compiled circuit of the certificate's
 * issuer (card_proof_rs2048 for G2, card_proof_rs4096 for G3), its
 * verification key, the points of G1 and the point of G2 of the common
 * reference string. The core keeps none of them. IDC_ERR_INPUT when any
 * is another file. */
int32_t idc_session_check_artifacts(idc_session session,
                                    const uint8_t *circuit, size_t circuit_len,
                                    const uint8_t *verification_key, size_t verification_key_len,
                                    const uint8_t *crs_g1, size_t crs_g1_len,
                                    const uint8_t *crs_g2, size_t crs_g2_len);

/* The date conditions again, on the date of `now`: the certificate is
 * still valid and the CRL that passed is no older than the bound it was
 * checked against. Call it when the date in Taiwan has changed since step
 * 1, and before asking for a challenge and before the second signature (a
 * card proof can cross midnight). JSON in *out:
 *   {"ok":true}                                   the session holds for this date
 *   {"ok":false,"problem":"expired","not_after":"..."}
 *   {"ok":false,"problem":"not_yet_valid","not_before":"..."}
 *   {"ok":false,"problem":"crl_stale","days":8,"max_age_days":7}
 * With "ok": false the card proof stops and the session starts over.
 * IDC_ERR_REFUSED before step 1 passed. */
int32_t idc_session_check_date(idc_session session, int64_t now, idc_buf *out);

/* The body of POST /api/v1/card-state, {"scope_string":"...","scoped_id":"..."},
 * in *out: the scoped ID computed from the card's signature over the scope
 * string of the session's roster (256 bytes).
 * IDC_ERR_REFUSED unless steps 1 to 4 all passed and the date of `now` is
 * the date they hold for (idc_session_check_date). IDC_ERR_INPUT when the
 * signature is not the one of the session's certificate over that scope
 * string. The core keeps no copy of the signature; the caller overwrites
 * its own when the card proof ends. */
int32_t idc_session_card_state_request(idc_session session, int64_t now,
                                       const uint8_t *scope_signature, size_t scope_signature_len,
                                       idc_buf *out);

/* The body of POST /api/v1/records in *out: the fields of a record except
 * seq (spec/record.md), with the proof, made here from the session's
 * certificate and path.
 *   circuit, verification_key, crs_g1, crs_g2:
 *                 the four files of step 4, passed again: the core kept
 *                 none of them, and checks their SHA-256 again before it
 *                 uses them. The first proof of the process hands the
 *                 common reference string to Barretenberg, which keeps it.
 *   accounts_json: the whole list the card declares, as for
 *                 idc_declaration_code
 *   challenge:    the challenge as the server issued it
 *   scope_signature, declaration_code_signature:
 *                 the card's signatures over idc_scope_string and over
 *                 idc_declaration_code of this list and challenge (256
 *                 bytes each)
 * The proof takes seconds, on as many threads as the device has cores, and
 * several hundred MiB (issue #88): call it from a background thread. One
 * proof is made at a time; a second call waits. The core compares the
 * proof's public inputs with the ones it expects and returns nothing if
 * any differs.
 *
 * IDC_ERR_REFUSED unless steps 1 to 4 all passed and the challenge's date
 * is the date they hold for (idc_session_check_date): the record is dated
 * the challenge's date, so this function takes no clock.
 * IDC_ERR_INPUT when a file is not the one written into the core (step 4
 * must then pass again), the list or the challenge is not what
 * idc_declaration_code takes, a signature is not the card's over its
 * message, or the circuit has no proof for these inputs.
 * The core keeps no copy of either signature: its own copies, the
 * circuit's inputs and the witness are overwritten before the call
 * returns. What Barretenberg (C++) copied of the witness is not reached
 * (device-core/README.md, "清掉"). The caller overwrites its own. */
int32_t idc_session_records_request(idc_session session,
                                    const uint8_t *circuit, size_t circuit_len,
                                    const uint8_t *verification_key, size_t verification_key_len,
                                    const uint8_t *crs_g1, size_t crs_g1_len,
                                    const uint8_t *crs_g2, size_t crs_g2_len,
                                    const uint8_t *accounts_json, size_t accounts_json_len,
                                    const uint8_t *challenge, size_t challenge_len,
                                    const uint8_t *scope_signature, size_t scope_signature_len,
                                    const uint8_t *declaration_code_signature,
                                    size_t declaration_code_signature_len,
                                    idc_buf *out);

#ifdef __cplusplus
}
#endif

#endif
