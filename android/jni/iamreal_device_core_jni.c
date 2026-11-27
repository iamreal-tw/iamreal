/*
 * The JNI layer over the C functions of device-core/
 * (device-core/include/iamreal_device_core.h): what the Kotlin object
 * tw.iamreal.app.core.DeviceCore calls. It keeps the conventions of
 * device-core/README.md:
 *
 * - Bytes in: a Java byte[] is copied out for the length of the call, and
 *   the copy is overwritten with zeros before it is freed. The byte[]
 *   stays the caller's.
 * - Bytes out: the idc_buf is copied into a new byte[] and given back to
 *   the core with idc_buf_free, which overwrites it.
 * - Any code but IDC_OK becomes a DeviceCoreException that carries the
 *   code and nothing else.
 *
 * Only idc_ functions are called here. Nothing here logs, opens a file or
 * a socket, or takes a PIN.
 */
#include <jni.h>
#include <stdint.h>
#include <stdlib.h>

#include "iamreal_device_core.h"
#ifdef IDC_TESTING
#include "iamreal_device_core_testing.h"
#endif

/* Failures of this layer itself (no memory, a class not found) use the core's code for its own failures. */
#define EXCEPTION_CLASS "tw/iamreal/app/core/DeviceCoreException"

static void throw_code(JNIEnv *env, int32_t code) {
  if ((*env)->ExceptionCheck(env)) return;
  jclass cls = (*env)->FindClass(env, EXCEPTION_CLASS);
  if (cls == NULL) return;
  jmethodID init = (*env)->GetMethodID(env, cls, "<init>", "(I)V");
  if (init == NULL) return;
  jobject e = (*env)->NewObject(env, cls, init, (jint)code);
  if (e != NULL) (*env)->Throw(env, (jthrowable)e);
}

/* Overwrites with zeros in a way the compiler does not take out. */
static void wipe(uint8_t *p, size_t n) {
  volatile uint8_t *v = p;
  while (n--) *v++ = 0;
}

typedef struct {
  uint8_t *ptr;
  size_t len;
} copy;

/* Copies a byte[] out. False, with an exception pending, when it cannot. */
static int copy_in(JNIEnv *env, jbyteArray array, copy *out) {
  out->ptr = NULL;
  out->len = 0;
  if (array == NULL) {
    throw_code(env, IDC_ERR_ARGUMENT);
    return 0;
  }
  jsize len = (*env)->GetArrayLength(env, array);
  if (len == 0) return 1;
  uint8_t *p = malloc((size_t)len);
  if (p == NULL) {
    throw_code(env, IDC_ERR_INTERNAL);
    return 0;
  }
  (*env)->GetByteArrayRegion(env, array, 0, len, (jbyte *)p);
  out->ptr = p;
  out->len = (size_t)len;
  return 1;
}

/* As copy_in, but a null byte[] is no bytes: (NULL, 0). */
static int copy_in_optional(JNIEnv *env, jbyteArray array, copy *out) {
  if (array == NULL) {
    out->ptr = NULL;
    out->len = 0;
    return 1;
  }
  return copy_in(env, array, out);
}

static void copy_free(copy *c) {
  if (c->ptr != NULL) {
    wipe(c->ptr, c->len);
    free(c->ptr);
  }
  c->ptr = NULL;
  c->len = 0;
}

/* Copies `n` byte[]s out. False, with an exception pending and nothing left to free, when one cannot be. */
static int copy_all(JNIEnv *env, int n, const jbyteArray *arrays, copy *out) {
  for (int i = 0; i < n; i++) {
    if (!copy_in(env, arrays[i], &out[i])) {
      while (i-- > 0) copy_free(&out[i]);
      return 0;
    }
  }
  return 1;
}

static void copy_free_all(int n, copy *copies) {
  for (int i = 0; i < n; i++) copy_free(&copies[i]);
}

/* The bytes of `buf` as a new byte[], or an exception for `code`. Gives `buf` back to the core either way. */
static jbyteArray result(JNIEnv *env, int32_t code, idc_buf *buf) {
  jbyteArray array = NULL;
  if (code != IDC_OK) {
    throw_code(env, code);
  } else if (buf->len > (size_t)INT32_MAX) {
    throw_code(env, IDC_ERR_INTERNAL);
  } else {
    array = (*env)->NewByteArray(env, (jsize)buf->len);
    if (array != NULL) (*env)->SetByteArrayRegion(env, array, 0, (jsize)buf->len, (const jbyte *)buf->ptr);
  }
  idc_buf_free(buf);
  return array;
}

/* Refuses to load next to a core whose functions are not the ones of the header this file was built with. */
JNIEXPORT jint JNICALL JNI_OnLoad(JavaVM *vm, void *reserved) {
  (void)vm;
  (void)reserved;
  if (idc_abi_version() != IDC_ABI_VERSION) return JNI_ERR;
  return JNI_VERSION_1_6;
}

JNIEXPORT void JNICALL Java_tw_iamreal_app_core_DeviceCore_nativeSelfCheck(JNIEnv *env, jobject self) {
  (void)self;
  int32_t code = idc_self_check();
  if (code != IDC_OK) throw_code(env, code);
}

JNIEXPORT jbyteArray JNICALL Java_tw_iamreal_app_core_DeviceCore_nativeScopeString(JNIEnv *env, jobject self, jint proof_log) {
  (void)self;
  idc_buf out = {NULL, 0};
  int32_t code = idc_scope_string((uint32_t)proof_log, &out);
  return result(env, code, &out);
}

JNIEXPORT jbyteArray JNICALL Java_tw_iamreal_app_core_DeviceCore_nativeDeclarationCode(JNIEnv *env, jobject self, jint proof_log,
                                                                                      jbyteArray accounts_json, jbyteArray challenge) {
  (void)self;
  copy accounts, chal;
  if (!copy_in(env, accounts_json, &accounts)) return NULL;
  if (!copy_in(env, challenge, &chal)) {
    copy_free(&accounts);
    return NULL;
  }
  idc_buf out = {NULL, 0};
  int32_t code = idc_declaration_code((uint32_t)proof_log, accounts.ptr, accounts.len, chal.ptr, chal.len, &out);
  copy_free(&accounts);
  copy_free(&chal);
  return result(env, code, &out);
}

JNIEXPORT jbyteArray JNICALL Java_tw_iamreal_app_core_DeviceCore_nativeListConsequence(JNIEnv *env, jobject self, jbyteArray platforms_json,
                                                                                      jbyteArray card_state_json, jbyteArray known_platforms_json,
                                                                                      jbyteArray accounts_json, jlong now) {
  (void)self;
  copy in[4];
  if (!copy_all(env, 4, (jbyteArray[]){platforms_json, card_state_json, known_platforms_json, accounts_json}, in)) return NULL;
  idc_buf out = {NULL, 0};
  int32_t code = idc_list_consequence(in[0].ptr, in[0].len, in[1].ptr, in[1].len, in[2].ptr, in[2].len, in[3].ptr, in[3].len, (int64_t)now, &out);
  copy_free_all(4, in);
  return result(env, code, &out);
}

JNIEXPORT jbyteArray JNICALL Java_tw_iamreal_app_core_DeviceCore_nativeCardStatus(JNIEnv *env, jobject self, jbyteArray platforms_json,
                                                                                 jbyteArray card_state_json, jbyteArray known_platforms_json,
                                                                                 jlong now) {
  (void)self;
  copy in[3];
  if (!copy_all(env, 3, (jbyteArray[]){platforms_json, card_state_json, known_platforms_json}, in)) return NULL;
  idc_buf out = {NULL, 0};
  int32_t code = idc_card_status(in[0].ptr, in[0].len, in[1].ptr, in[1].len, in[2].ptr, in[2].len, (int64_t)now, &out);
  copy_free_all(3, in);
  return result(env, code, &out);
}

JNIEXPORT jbyteArray JNICALL Java_tw_iamreal_app_core_DeviceCore_nativeShortId(JNIEnv *env, jobject self, jbyteArray scoped_id) {
  (void)self;
  copy in;
  if (!copy_in(env, scoped_id, &in)) return NULL;
  idc_buf out = {NULL, 0};
  int32_t code = idc_short_id(in.ptr, in.len, &out);
  copy_free(&in);
  return result(env, code, &out);
}

JNIEXPORT jbyteArray JNICALL Java_tw_iamreal_app_core_DeviceCore_nativeMinApp(JNIEnv *env, jobject self, jbyteArray config, jint app_build,
                                                                             jlong now) {
  (void)self;
  /* A build is 1 or more; one below 0 is not a build, and is not passed on as a large one. */
  if (app_build < 0) return result(env, IDC_ERR_ARGUMENT, &(idc_buf){NULL, 0});
  copy in;
  if (!copy_in(env, config, &in)) return NULL;
  idc_buf out = {NULL, 0};
  int32_t code = idc_min_app(in.ptr, in.len, IDC_CLIENT_ANDROID, (uint32_t)app_build, (int64_t)now, &out);
  copy_free(&in);
  return result(env, code, &out);
}

JNIEXPORT jbyteArray JNICALL Java_tw_iamreal_app_core_DeviceCore_nativeCount(JNIEnv *env, jobject self, jbyteArray count) {
  (void)self;
  copy in;
  if (!copy_in(env, count, &in)) return NULL;
  idc_buf out = {NULL, 0};
  int32_t code = idc_count(in.ptr, in.len, &out);
  copy_free(&in);
  return result(env, code, &out);
}

JNIEXPORT jbyteArray JNICALL Java_tw_iamreal_app_core_DeviceCore_nativeCountDeviceId(JNIEnv *env, jobject self, jbyteArray stored,
                                                                                     jlong now, jbyteArray random) {
  (void)self;
  copy kept;
  if (!copy_in(env, stored, &kept)) return NULL;
  copy bytes;
  if (!copy_in(env, random, &bytes)) {
    copy_free(&kept);
    return NULL;
  }
  idc_buf out = {NULL, 0};
  int32_t code = idc_count_device_id(kept.ptr, kept.len, (int64_t)now, bytes.ptr, bytes.len, &out);
  copy_free(&kept);
  copy_free(&bytes);
  return result(env, code, &out);
}

JNIEXPORT jbyteArray JNICALL Java_tw_iamreal_app_core_DeviceCore_nativeCountTook(JNIEnv *env, jobject self, jlong ms) {
  (void)self;
  /* A time that runs backwards is no duration, and is not passed on as a large one. */
  if (ms < 0) return result(env, IDC_ERR_ARGUMENT, &(idc_buf){NULL, 0});
  idc_buf out = {NULL, 0};
  int32_t code = idc_count_took((uint64_t)ms, &out);
  return result(env, code, &out);
}

JNIEXPORT jbyteArray JNICALL Java_tw_iamreal_app_core_DeviceCore_nativeRecordsResponse(JNIEnv *env, jobject self, jbyteArray response,
                                                                                      jbyteArray rows_json) {
  (void)self;
  copy in[2];
  if (!copy_all(env, 2, (jbyteArray[]){response, rows_json}, in)) return NULL;
  idc_buf out = {NULL, 0};
  int32_t code = idc_records_response(in[0].ptr, in[0].len, in[1].ptr, in[1].len, &out);
  copy_free_all(2, in);
  return result(env, code, &out);
}

JNIEXPORT jlong JNICALL Java_tw_iamreal_app_core_DeviceCore_nativeSessionOpen(JNIEnv *env, jobject self, jint proof_log) {
  (void)self;
  idc_session session = 0;
  int32_t code = idc_session_open((uint32_t)proof_log, &session);
  if (code != IDC_OK) throw_code(env, code);
  return (jlong)session;
}

JNIEXPORT void JNICALL Java_tw_iamreal_app_core_DeviceCore_nativeSessionClose(JNIEnv *env, jobject self, jlong session) {
  (void)env;
  (void)self;
  idc_session_close((idc_session)session);
}

JNIEXPORT void JNICALL Java_tw_iamreal_app_core_DeviceCore_nativeSessionAddCertificate(JNIEnv *env, jobject self, jlong session,
                                                                                      jbyteArray certificate) {
  (void)self;
  copy cert;
  if (!copy_in(env, certificate, &cert)) return;
  int32_t code = idc_session_add_certificate((idc_session)session, cert.ptr, cert.len);
  copy_free(&cert);
  if (code != IDC_OK) throw_code(env, code);
}

JNIEXPORT jbyteArray JNICALL Java_tw_iamreal_app_core_DeviceCore_nativeSessionCheckCertificates(JNIEnv *env, jobject self, jlong session,
                                                                                               jlong now) {
  (void)self;
  idc_buf out = {NULL, 0};
  int32_t code = idc_session_check_certificates((idc_session)session, (int64_t)now, &out);
  return result(env, code, &out);
}

JNIEXPORT jbyteArray JNICALL Java_tw_iamreal_app_core_DeviceCore_nativeSessionChooseCrl(JNIEnv *env, jobject self, jlong session,
                                                                                       jbyteArray index) {
  (void)self;
  copy in;
  if (!copy_in(env, index, &in)) return NULL;
  idc_buf out = {NULL, 0};
  int32_t code = idc_session_choose_crl((idc_session)session, in.ptr, in.len, &out);
  copy_free(&in);
  return result(env, code, &out);
}

/* `highest` may be null: the device remembers no CRL number for the issuer. */
JNIEXPORT jbyteArray JNICALL Java_tw_iamreal_app_core_DeviceCore_nativeSessionCheckCrl(JNIEnv *env, jobject self, jlong session, jbyteArray crl,
                                                                                      jbyteArray config, jbyteArray highest) {
  (void)self;
  copy in[2], high;
  if (!copy_all(env, 2, (jbyteArray[]){crl, config}, in)) return NULL;
  if (!copy_in_optional(env, highest, &high)) {
    copy_free_all(2, in);
    return NULL;
  }
  idc_buf out = {NULL, 0};
  int32_t code = idc_session_check_crl((idc_session)session, in[0].ptr, in[0].len, in[1].ptr, in[1].len, high.ptr, high.len, &out);
  copy_free_all(2, in);
  copy_free(&high);
  return result(env, code, &out);
}

JNIEXPORT void JNICALL Java_tw_iamreal_app_core_DeviceCore_nativeSessionBuildTree(JNIEnv *env, jobject self, jlong session) {
  (void)self;
  int32_t code = idc_session_build_tree((idc_session)session);
  if (code != IDC_OK) throw_code(env, code);
}

JNIEXPORT void JNICALL Java_tw_iamreal_app_core_DeviceCore_nativeSessionCheckArtifacts(JNIEnv *env, jobject self, jlong session,
                                                                                      jbyteArray circuit, jbyteArray verification_key,
                                                                                      jbyteArray crs_g1, jbyteArray crs_g2) {
  (void)self;
  copy in[4];
  if (!copy_all(env, 4, (jbyteArray[]){circuit, verification_key, crs_g1, crs_g2}, in)) return;
  int32_t code = idc_session_check_artifacts((idc_session)session, in[0].ptr, in[0].len, in[1].ptr, in[1].len, in[2].ptr, in[2].len, in[3].ptr,
                                             in[3].len);
  copy_free_all(4, in);
  if (code != IDC_OK) throw_code(env, code);
}

JNIEXPORT jbyteArray JNICALL Java_tw_iamreal_app_core_DeviceCore_nativeSessionCheckDate(JNIEnv *env, jobject self, jlong session, jlong now) {
  (void)self;
  idc_buf out = {NULL, 0};
  int32_t code = idc_session_check_date((idc_session)session, (int64_t)now, &out);
  return result(env, code, &out);
}

JNIEXPORT jbyteArray JNICALL Java_tw_iamreal_app_core_DeviceCore_nativeSessionCheckChallenge(JNIEnv *env, jobject self, jlong session, jlong now,
                                                                                             jbyteArray challenge) {
  (void)self;
  copy in;
  if (!copy_in(env, challenge, &in)) return NULL;
  idc_buf out = {NULL, 0};
  int32_t code = idc_session_check_challenge((idc_session)session, (int64_t)now, in.ptr, in.len, &out);
  copy_free(&in);
  return result(env, code, &out);
}

JNIEXPORT jbyteArray JNICALL Java_tw_iamreal_app_core_DeviceCore_nativeSessionCardStateRequest(JNIEnv *env, jobject self, jlong session,
                                                                                              jlong now, jbyteArray scope_signature) {
  (void)self;
  copy in;
  if (!copy_in(env, scope_signature, &in)) return NULL;
  idc_buf out = {NULL, 0};
  int32_t code = idc_session_card_state_request((idc_session)session, (int64_t)now, in.ptr, in.len, &out);
  copy_free(&in);
  return result(env, code, &out);
}

JNIEXPORT jbyteArray JNICALL Java_tw_iamreal_app_core_DeviceCore_nativeSessionRecordsRequest(
    JNIEnv *env, jobject self, jlong session, jbyteArray circuit, jbyteArray verification_key, jbyteArray crs_g1, jbyteArray crs_g2,
    jbyteArray accounts_json, jbyteArray challenge, jbyteArray scope_signature, jbyteArray declaration_code_signature) {
  (void)self;
  copy in[8];
  if (!copy_all(env, 8,
                (jbyteArray[]){circuit, verification_key, crs_g1, crs_g2, accounts_json, challenge, scope_signature, declaration_code_signature},
                in))
    return NULL;
  idc_buf out = {NULL, 0};
  int32_t code = idc_session_records_request((idc_session)session, in[0].ptr, in[0].len, in[1].ptr, in[1].len, in[2].ptr, in[2].len, in[3].ptr,
                                             in[3].len, in[4].ptr, in[4].len, in[5].ptr, in[5].len, in[6].ptr, in[6].len, in[7].ptr, in[7].len,
                                             &out);
  copy_free_all(8, in);
  return result(env, code, &out);
}

#ifdef IDC_TESTING
/* Only in the library of the tests (build-native.sh, "test-issuers"): a session that trusts the issuer keys given, for a fake card. */
JNIEXPORT jlong JNICALL Java_tw_iamreal_app_core_TestingCore_nativeSessionOpen(JNIEnv *env, jobject self, jint proof_log, jbyteArray issuers_json) {
  (void)self;
  copy in;
  if (!copy_in(env, issuers_json, &in)) return 0;
  idc_session session = 0;
  int32_t code = idc_testing_session_open((uint32_t)proof_log, in.ptr, in.len, &session);
  copy_free(&in);
  if (code != IDC_OK) throw_code(env, code);
  return (jlong)session;
}
#endif
