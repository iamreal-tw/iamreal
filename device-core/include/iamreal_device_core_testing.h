/*
 * For tests only: the one C function a library built with the cargo
 * feature `test-issuers` has besides those of iamreal_device_core.h. The
 * library of an app that goes out is built without the feature and has no
 * such function (device-core/README.md, "檢查都通過了").
 */
#ifndef IAMREAL_DEVICE_CORE_TESTING_H
#define IAMREAL_DEVICE_CORE_TESTING_H

#include "iamreal_device_core.h"

#ifdef __cplusplus
extern "C" {
#endif

/* Opens a session as idc_session_open does, but one that checks
 * certificates and CRLs against the issuer keys given in place of MOICA's:
 * how a test with a fake card, whose certificate a test key issued, gets
 * past step 1. The files the session checks are still the ones written
 * into the core.
 *
 * issuers_json: a JSON array of {"issuer":"G2","modulus":"<hex>"}; issuer
 * is G2 or G3, each at most once, at least one; modulus is the key's RSA
 * modulus, big-endian. IDC_ERR_INPUT for anything else. */
int32_t idc_testing_session_open(uint32_t roster,
                                 const uint8_t *issuers_json, size_t issuers_json_len,
                                 idc_session *out);

#ifdef __cplusplus
}
#endif

#endif
