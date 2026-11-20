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

static void copy_free(copy *c) {
  if (c->ptr != NULL) {
    wipe(c->ptr, c->len);
    free(c->ptr);
  }
  c->ptr = NULL;
  c->len = 0;
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

JNIEXPORT jbyteArray JNICALL Java_tw_iamreal_app_core_DeviceCore_nativeScopeString(JNIEnv *env, jobject self, jint roster) {
  (void)self;
  idc_buf out = {NULL, 0};
  int32_t code = idc_scope_string((uint32_t)roster, &out);
  return result(env, code, &out);
}

JNIEXPORT jbyteArray JNICALL Java_tw_iamreal_app_core_DeviceCore_nativeDeclarationCode(JNIEnv *env, jobject self, jint roster,
                                                                                      jbyteArray accounts_json, jbyteArray challenge) {
  (void)self;
  copy accounts, chal;
  if (!copy_in(env, accounts_json, &accounts)) return NULL;
  if (!copy_in(env, challenge, &chal)) {
    copy_free(&accounts);
    return NULL;
  }
  idc_buf out = {NULL, 0};
  int32_t code = idc_declaration_code((uint32_t)roster, accounts.ptr, accounts.len, chal.ptr, chal.len, &out);
  copy_free(&accounts);
  copy_free(&chal);
  return result(env, code, &out);
}
