package tw.iamreal.app.core

import tw.iamreal.app.Environment

/**
 * device-core/ (ADR-0034) as Kotlin calls it. Each function is one C
 * function of device-core/include/iamreal_device_core.h, reached through
 * the JNI layer (android/jni/); the roster is always the one this app is
 * built for. The app's code calls the core here and nowhere else.
 *
 * A function may be called from any thread and returns when its work is
 * done. One that fails throws [DeviceCoreException]. The byte arrays
 * passed in stay the caller's: the caller overwrites what must not stay in
 * memory.
 */
object DeviceCore {
    init {
        // Fails when the library's functions are not the ones of the header the JNI layer was built with.
        System.loadLibrary("iamreal_device_core_jni")
    }

    /** Checks that the Barretenberg linked into the library answers and computes the Poseidon2 of spec/scoped-id.md. */
    fun selfCheck() = nativeSelfCheck()

    /** The scope string a card signs first (spec/scope.md): 31 bytes. */
    fun scopeString(): ByteArray = nativeScopeString(Environment.ROSTER)

    /**
     * The declaration code (spec/declaration-code.md) a card signs second: 31 bytes.
     *
     * [accountsJson] is a JSON array of `{"platform":"...","username":"..."}` in ascending order of
     * platform, each platform at most once; [challenge] is the challenge as the server issued it.
     */
    fun declarationCode(accountsJson: ByteArray, challenge: ByteArray): ByteArray =
        nativeDeclarationCode(Environment.ROSTER, accountsJson, challenge)

    /**
     * What a list does on every platform, before the card signs it (spec/list-consequence.md): JSON, as
     * `idc_list_consequence` of the header describes it.
     *
     * [platformsJson] is the `platforms` of the server's config and [cardStateJson] the answer of
     * card-state, both as the server sent them; [knownPlatformsJson] the platforms the app has its own
     * definition of; [accountsJson] the cardholder's list; [now] the phone's clock, in seconds since 1970.
     */
    fun listConsequence(platformsJson: ByteArray, cardStateJson: ByteArray, knownPlatformsJson: ByteArray, accountsJson: ByteArray, now: Long): ByteArray =
        nativeListConsequence(platformsJson, cardStateJson, knownPlatformsJson, accountsJson, now)

    /**
     * The card's state as step 4 shows it (spec/list-consequence.md, "The card's state, as shown"): JSON, as
     * `idc_card_status` of the header describes it. The arguments are those of [listConsequence], without a list.
     */
    fun cardStatus(platformsJson: ByteArray, cardStateJson: ByteArray, knownPlatformsJson: ByteArray, now: Long): ByteArray =
        nativeCardStatus(platformsJson, cardStateJson, knownPlatformsJson, now)

    /** The short ID (spec/scoped-id.md) of a scoped ID in its text form: 10 characters. */
    fun shortId(scopedId: ByteArray): ByteArray = nativeShortId(scopedId)

    /**
     * The answer to a submission as step 6 tells it (spec/records-response.md): JSON, as
     * `idc_records_response` of the header describes it.
     *
     * [response] is the body of the server's `201`, as it sent it; [rowsJson] the `rows` of [listConsequence]
     * for the list the card signed. A body the core cannot read is not a failure: the record is in the roster.
     */
    fun recordsResponse(response: ByteArray, rowsJson: ByteArray): ByteArray = nativeRecordsResponse(response, rowsJson)

    /**
     * Opens a session, one card proof in the core (device-core/README.md, "檢查都通過了"): the number that
     * names it. Whoever opens one closes it with [sessionClose], whatever happened in between.
     */
    fun sessionOpen(): Long = nativeSessionOpen(Environment.ROSTER)

    /** Closes a session: the core overwrites what it kept of the card. A number that names none does nothing. */
    fun sessionClose(session: Long) = nativeSessionClose(session)

    /** Adds one certificate the card returned (DER), in the card's order. */
    fun sessionAddCertificate(session: Long, certificate: ByteArray) = nativeSessionAddCertificate(session, certificate)

    /** Step 1: chooses and checks the certificate. JSON; with `"ok": true` it holds the name to show before the PIN. */
    fun sessionCheckCertificates(session: Long, now: Long): ByteArray = nativeSessionCheckCertificates(session, now)

    /** Step 2, first half: which file of the CRL archive's index to download. JSON. */
    fun sessionChooseCrl(session: Long, index: ByteArray): ByteArray = nativeSessionChooseCrl(session, index)

    /**
     * Step 2, second half: checks the downloaded CRL, and that the certificate is not on it. JSON, with
     * `highest_after`, what the app remembers for the issuer from now on. [highest] is what it remembers
     * now, in decimal digits, or null for nothing.
     */
    fun sessionCheckCrl(session: Long, crl: ByteArray, config: ByteArray, highest: ByteArray?): ByteArray =
        nativeSessionCheckCrl(session, crl, config, highest)

    /** Step 3: builds the revocation tree. Returns when it is built: for a background thread. */
    fun sessionBuildTree(session: Long) = nativeSessionBuildTree(session)

    /** Step 4: the files the app carries are the ones written into the core. Throws with [DeviceCoreException.INPUT] if one is not. */
    fun sessionCheckArtifacts(session: Long, circuit: ByteArray, verificationKey: ByteArray, crsG1: ByteArray, crsG2: ByteArray) =
        nativeSessionCheckArtifacts(session, circuit, verificationKey, crsG1, crsG2)

    /** The date conditions again, on the date of [now]. JSON. */
    fun sessionCheckDate(session: Long, now: Long): ByteArray = nativeSessionCheckDate(session, now)

    /**
     * The body of `POST /api/v1/card-state`, with the scoped ID computed from the card's signature over the
     * scope string. Throws with [DeviceCoreException.REFUSED] unless every check passed.
     */
    fun sessionCardStateRequest(session: Long, now: Long, scopeSignature: ByteArray): ByteArray =
        nativeSessionCardStateRequest(session, now, scopeSignature)

    /**
     * The body of `POST /api/v1/records`, with the proof made here. Takes seconds and several hundred
     * MiB: for a background thread. Throws with [DeviceCoreException.REFUSED] unless every check passed.
     */
    fun sessionRecordsRequest(
        session: Long,
        circuit: ByteArray,
        verificationKey: ByteArray,
        crsG1: ByteArray,
        crsG2: ByteArray,
        accountsJson: ByteArray,
        challenge: ByteArray,
        scopeSignature: ByteArray,
        declarationCodeSignature: ByteArray,
    ): ByteArray = nativeSessionRecordsRequest(session, circuit, verificationKey, crsG1, crsG2, accountsJson, challenge, scopeSignature, declarationCodeSignature)

    private external fun nativeSelfCheck()

    private external fun nativeScopeString(roster: Int): ByteArray

    private external fun nativeDeclarationCode(roster: Int, accountsJson: ByteArray, challenge: ByteArray): ByteArray

    private external fun nativeListConsequence(platformsJson: ByteArray, cardStateJson: ByteArray, knownPlatformsJson: ByteArray, accountsJson: ByteArray, now: Long): ByteArray

    private external fun nativeCardStatus(platformsJson: ByteArray, cardStateJson: ByteArray, knownPlatformsJson: ByteArray, now: Long): ByteArray

    private external fun nativeShortId(scopedId: ByteArray): ByteArray

    private external fun nativeRecordsResponse(response: ByteArray, rowsJson: ByteArray): ByteArray

    private external fun nativeSessionOpen(roster: Int): Long

    private external fun nativeSessionClose(session: Long)

    private external fun nativeSessionAddCertificate(session: Long, certificate: ByteArray)

    private external fun nativeSessionCheckCertificates(session: Long, now: Long): ByteArray

    private external fun nativeSessionChooseCrl(session: Long, index: ByteArray): ByteArray

    private external fun nativeSessionCheckCrl(session: Long, crl: ByteArray, config: ByteArray, highest: ByteArray?): ByteArray

    private external fun nativeSessionBuildTree(session: Long)

    private external fun nativeSessionCheckArtifacts(session: Long, circuit: ByteArray, verificationKey: ByteArray, crsG1: ByteArray, crsG2: ByteArray)

    private external fun nativeSessionCheckDate(session: Long, now: Long): ByteArray

    private external fun nativeSessionCardStateRequest(session: Long, now: Long, scopeSignature: ByteArray): ByteArray

    private external fun nativeSessionRecordsRequest(
        session: Long,
        circuit: ByteArray,
        verificationKey: ByteArray,
        crsG1: ByteArray,
        crsG2: ByteArray,
        accountsJson: ByteArray,
        challenge: ByteArray,
        scopeSignature: ByteArray,
        declarationCodeSignature: ByteArray,
    ): ByteArray
}
