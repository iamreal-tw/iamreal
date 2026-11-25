// The app, as its two builds (README.md, ADR-0037). What this file decides: the identifiers, the
// one Android version the app is built for, how the native library and the
// bundled files get into the installer, and the checks of what was built.
import com.android.build.api.artifact.SingleArtifact
import org.gradle.api.artifacts.component.ModuleComponentIdentifier
import java.nio.ByteBuffer
import java.nio.ByteOrder
import java.security.MessageDigest
import java.util.zip.ZipFile
import javax.inject.Inject
import javax.xml.parsers.DocumentBuilderFactory

plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.plugin.compose")
}

// The lowest Android the app runs on: API 29 (Android 10). Barretenberg's
// library for Android keeps its thread-local variables the way Android
// supports from API 29 on (README.md, "minSdk").
val minApi = 29
// The files every installer carries, each with its SHA-256: the circuits and their keys, and the parameter files.
val bundledLists = files(rootProject.file("bundled.sha256"), rootProject.file("../device-core/crs.sha256"))
// The build type of the emulator test (README.md, "模擬器上過一次卡"): a fake card, the library of the
// tests, a server on this machine. It is installed next to the app under its own identifier and goes nowhere.
val fakeBuild = "fake"
// The identifier each build type must come out with (ADR-0037): release is the store's build, debug the
// development build, which a phone can have next to the store's. checkManifest holds each build to it.
val ids = mapOf("release" to "tw.iamreal.app", "debug" to "tw.iamreal.app.dev", fakeBuild to "tw.iamreal.app.dev.fake")
// The ABIs of each kind of build: what goes out is for phones only; a debug build is also for the emulator on x86-64.
val releaseAbis = listOf("arm64-v8a")
val debugAbis = listOf("arm64-v8a", "x86_64")
// The libraries the app may carry: Kotlin's own and the annotations it names; Jetpack Compose for the
// screens (ui, foundation) and androidx.activity, and what those three bring with them, each by name.
// No SDK of anyone else, no Google Play services, nothing that sends anything anywhere.
val allowedLibraries = listOf(
    "org.jetbrains.kotlin:kotlin-stdlib",
    "org.jetbrains:annotations",
    // Asked for by name (dependencies, below).
    "androidx.activity:activity",
    "androidx.compose.foundation:foundation",
    "androidx.compose.ui:ui",
    // What they bring with them.
    "androidx.activity:activity-ktx",
    "androidx.annotation:annotation-experimental",
    "androidx.annotation:annotation-jvm",
    "androidx.arch.core:core-common",
    "androidx.arch.core:core-runtime",
    "androidx.autofill:autofill",
    "androidx.collection:collection-jvm",
    "androidx.collection:collection-ktx",
    "androidx.compose.animation:animation-android",
    "androidx.compose.animation:animation-core-android",
    "androidx.compose.foundation:foundation-android",
    "androidx.compose.foundation:foundation-layout-android",
    "androidx.compose.runtime:runtime-android",
    "androidx.compose.runtime:runtime-annotation-android",
    "androidx.compose.runtime:runtime-retain-android",
    "androidx.compose.runtime:runtime-saveable-android",
    "androidx.compose.ui:ui-android",
    "androidx.compose.ui:ui-geometry-android",
    "androidx.compose.ui:ui-graphics-android",
    "androidx.compose.ui:ui-text-android",
    "androidx.compose.ui:ui-unit-android",
    "androidx.compose.ui:ui-util-android",
    "androidx.concurrent:concurrent-futures",
    "androidx.core:core",
    "androidx.core:core-ktx",
    "androidx.core:core-viewtree",
    "androidx.customview:customview-poolingcontainer",
    "androidx.documentfile:documentfile",
    "androidx.dynamicanimation:dynamicanimation",
    "androidx.emoji2:emoji2",
    "androidx.graphics:graphics-path",
    "androidx.interpolator:interpolator",
    "androidx.legacy:legacy-support-core-utils",
    "androidx.lifecycle:lifecycle-common-jvm",
    "androidx.lifecycle:lifecycle-livedata",
    "androidx.lifecycle:lifecycle-livedata-core",
    "androidx.lifecycle:lifecycle-livedata-core-ktx",
    "androidx.lifecycle:lifecycle-process",
    "androidx.lifecycle:lifecycle-runtime-android",
    "androidx.lifecycle:lifecycle-runtime-compose-android",
    "androidx.lifecycle:lifecycle-runtime-ktx-android",
    "androidx.lifecycle:lifecycle-viewmodel",
    "androidx.lifecycle:lifecycle-viewmodel-android",
    "androidx.lifecycle:lifecycle-viewmodel-ktx",
    "androidx.lifecycle:lifecycle-viewmodel-savedstate-android",
    "androidx.loader:loader",
    "androidx.localbroadcastmanager:localbroadcastmanager",
    "androidx.navigationevent:navigationevent-android",
    "androidx.print:print",
    "androidx.profileinstaller:profileinstaller",
    "androidx.savedstate:savedstate-android",
    "androidx.savedstate:savedstate-compose-android",
    "androidx.savedstate:savedstate-ktx",
    "androidx.startup:startup-runtime",
    "androidx.tracing:tracing",
    "androidx.transition:transition",
    "androidx.versionedparcelable:versionedparcelable",
    "androidx.window:window",
    "androidx.window:window-core-android",
    "com.google.guava:listenablefuture",
    "org.jetbrains.kotlinx:kotlinx-coroutines-android",
    "org.jetbrains.kotlinx:kotlinx-coroutines-core-jvm",
    "org.jetbrains.kotlinx:kotlinx-serialization-core-jvm",
    "org.jspecify:jspecify",
)
// The permissions the merged manifest may ask for: the network, for the server and the CRL archive; NFC, to read
// the card (issue #173); the reminder's notification, and being told the phone restarted, which forgets its alarm
// (issue #297).
val allowedPermissions = listOf(
    "android.permission.INTERNET",
    "android.permission.NFC",
    "android.permission.POST_NOTIFICATIONS",
    "android.permission.RECEIVE_BOOT_COMPLETED",
)

android {
    namespace = "tw.iamreal.app"
    compileSdk = 36
    buildToolsVersion = "36.0.0"
    ndkVersion = "29.0.14206865"

    defaultConfig {
        // The store's build (ADR-0037). The site it talks to and the proof log it signs for are in Environment.kt.
        applicationId = "tw.iamreal.app"
        minSdk = minApi
        targetSdk = 36
        // The version (ADR-0036): a build for Google Play gets it from .github/workflows/upload-android.yml
        // (android-version.sh) as two Gradle properties, the date and the run's number. Any other build is 1, "dev".
        versionCode = providers.gradleProperty("iamreal.versionCode").map { it.toInt() }.getOrElse(1)
        versionName = providers.gradleProperty("iamreal.versionName").getOrElse("dev")
    }

    buildTypes {
        debug {
            // The development build (ADR-0037): for a phone on a cable and for the emulator, next to the store's.
            applicationIdSuffix = ".dev"
            ndk { abiFilters += debugAbis }
        }
        release {
            // The store's build (ADR-0037): phones only.
            ndk { abiFilters += releaseAbis }
            isMinifyEnabled = true
            proguardFiles("proguard-rules.pro")
        }
        create(fakeBuild) {
            // The emulator test's: a debug build with src/fake/ in place of src/real/ (sourceSets, below).
            initWith(getByName("debug"))
            applicationIdSuffix = ".dev.$fakeBuild"
        }
    }

    buildFeatures {
        compose = true
    }

    sourceSets {
        // What the app is wired to (Target.kt): the card and the server of the installers that go out
        // and of a phone on a cable, or the fake card and this machine's server of the emulator test.
        getByName("debug").kotlin.directories.add("src/real/kotlin")
        getByName("release").kotlin.directories.add("src/real/kotlin")
        // TestingCore, for the library of the tests: in the fake build and the unit tests only.
        getByName(fakeBuild).kotlin.directories.add("src/testing/kotlin")
        // The emulator test's build is a development build: it has that build's name under the icon.
        getByName(fakeBuild).res.directories.add("src/debug/res")
        getByName("test").kotlin.directories.add("src/testing/kotlin")
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }

    androidResources {
        // The parameter file is random points: nothing to gain from compressing it.
        noCompress += "dat"
    }

    packaging {
        // Descriptions of Kotlin's built-in types, read only by Kotlin's reflection library, which the app does not have.
        resources.excludes += "**/*.kotlin_builtins"
        // The one native library the installer has is ours (checkApk). androidx.graphics:graphics-path, which
        // comes with Compose, brings one for walking the segments of a path on Android 13 and older; the
        // screens draw no path, and the emulator test goes through every screen without it.
        jniLibs.excludes += "**/libandroidx.graphics.path.so"
    }

    // The list of libraries AGP would put in the installer, encrypted for Google Play: left out.
    dependenciesInfo {
        includeInApk = false
        includeInBundle = false
    }

    lint {
        abortOnError = true
        checkReleaseBuilds = true
    }
}

dependencies {
    // The screens (README.md, "工具和套件"). Exact versions; what they bring is in allowedLibraries.
    implementation("androidx.activity:activity:1.13.0")
    implementation("androidx.compose.foundation:foundation:1.11.4")
    implementation("androidx.compose.ui:ui:1.11.4")
    // Only for the tests on the JVM. The app itself uses no library but Kotlin's own.
    testImplementation("junit:junit:4.13.2")
    // The JSON reader Android has built in, for the JVM: the tests read spec/vectors/ with it.
    testImplementation("org.json:json:20260814")
}

/**
 * One build of the native library at a time: cargo leaves device-core/'s static library at the same path
 * with and without the feature `test-issuers`, and build-native.sh links what is there when cargo is done.
 */
abstract class OneAtATime : BuildService<BuildServiceParameters.None>

val nativeBuilds = gradle.sharedServices.registerIfAbsent("nativeBuilds", OneAtATime::class) { maxParallelUsages = 1 }

/** Runs build-native.sh for each ABI: `out/<abi>/libiamreal_device_core_jni.so`. */
abstract class BuildNative : DefaultTask() {
    @get:Input abstract val abis: ListProperty<String>
    @get:Input abstract val api: Property<Int>
    @get:Input abstract val ndk: Property<String>
    /** The library of the tests (build-native.sh, "test-issuers"): for the fake build only. */
    @get:Input abstract val testing: Property<Boolean>
    @get:InputFiles @get:PathSensitive(PathSensitivity.RELATIVE) abstract val sources: ConfigurableFileCollection
    @get:Internal abstract val script: RegularFileProperty
    @get:OutputDirectory abstract val out: DirectoryProperty
    @get:Inject abstract val exec: ExecOperations

    @TaskAction
    fun build() {
        for (abi in abis.get()) {
            exec.exec {
                environment("ANDROID_NDK_ROOT", ndk.get())
                commandLine(listOf(script.get().asFile.path, abi, api.get().toString(), out.get().dir(abi).asFile.path) + if (testing.get()) listOf("test-issuers") else emptyList())
            }
        }
    }
}

/** Runs build-native.sh for this machine: the library the unit tests load on the JVM. */
abstract class BuildNativeHost : DefaultTask() {
    @get:InputFiles @get:PathSensitive(PathSensitivity.RELATIVE) abstract val sources: ConfigurableFileCollection
    @get:Internal abstract val script: RegularFileProperty
    @get:OutputDirectory abstract val out: DirectoryProperty
    @get:Inject abstract val exec: ExecOperations

    @TaskAction
    fun build() {
        exec.exec {
            environment("JAVA_HOME", System.getProperty("java.home"))
            commandLine(script.get().asFile.path, "host", out.get().asFile.path)
        }
    }
}

/** The SHA-256 of files, and `bundled.sha256` read. */
object Hashes {
    fun sha256(bytes: ByteArray): String =
        MessageDigest.getInstance("SHA-256").digest(bytes).joinToString("") { "%02x".format(it) }

    /** Lists in the format of `sha256sum`, as name to SHA-256. */
    fun readBundled(lists: Iterable<File>): Map<String, String> =
        lists.flatMap { it.readLines() }.filter { it.isNotBlank() }.associate {
            val (hash, name) = it.split("  ", limit = 2)
            name to hash
        }
}

/** The methods a dex file calls or defines, each as the class's descriptor and the method's name: `Ljava/io/PrintStream;` to `println`. */
object Dex {
    fun methods(dex: ByteArray): List<Pair<String, String>> {
        val b = ByteBuffer.wrap(dex).order(ByteOrder.LITTLE_ENDIAN)
        // The header (Android's "Dalvik executable format"): the size and the place of each table.
        val (stringCount, strings) = b.getInt(0x38) to b.getInt(0x3c)
        val types = b.getInt(0x44)
        val (methodCount, methods) = b.getInt(0x58) to b.getInt(0x5c)
        fun string(i: Int): String {
            require(i in 0 until stringCount)
            var at = b.getInt(strings + 4 * i)
            // The length in UTF-16 units, as ULEB128, then the bytes up to a zero.
            while (dex[at].toInt() and 0x80 != 0) at++
            at++
            var end = at
            while (dex[end].toInt() != 0) end++
            return String(dex, at, end - at, Charsets.UTF_8)
        }
        return (0 until methodCount).map {
            val item = methods + 8 * it
            string(b.getInt(types + 4 * (b.getShort(item).toInt() and 0xffff))) to string(b.getInt(item + 4))
        }
    }
}

/** Copies the bundled files into `out`, each only after its SHA-256 is the one in the lists. */
abstract class BundleFiles : DefaultTask() {
    @get:InputFiles abstract val lists: ConfigurableFileCollection
    @get:InputFiles abstract val from: ConfigurableFileCollection
    @get:OutputDirectory abstract val out: DirectoryProperty

    @TaskAction
    fun bundle() {
        val dir = out.get().asFile
        dir.deleteRecursively()
        dir.mkdirs()
        for ((name, hash) in Hashes.readBundled(lists.files)) {
            val source = from.files.map { it.resolve(name) }.firstOrNull { it.isFile }
                ?: throw GradleException("$name is in none of ${from.files} (the parameter files: device-core/fetch-crs.sh)")
            if (Hashes.sha256(source.readBytes()) != hash) throw GradleException("the SHA-256 of $source is not the listed one")
            source.copyTo(dir.resolve(name))
        }
    }
}

/** Copies design/'s files into the app's resources (res/), as they are: designResources. */
abstract class CopyDesign : DefaultTask() {
    /** Each file, by where it goes in res/. */
    @get:Internal abstract val resources: MapProperty<String, File>
    @get:InputFiles val sources get() = resources.get().values
    @get:Input val names get() = resources.get().keys.toList()
    @get:OutputDirectory abstract val out: DirectoryProperty

    @TaskAction
    fun copy() {
        val dir = out.get().asFile
        dir.deleteRecursively()
        for ((resource, source) in resources.get()) source.copyTo(dir.resolve(resource))
    }
}

/**
 * Fails when the merged manifest is of another app, asks for a permission that is not allowed, names the
 * advertising ID anywhere, or has a component other apps can call besides the app's one activity.
 */
abstract class CheckManifest : DefaultTask() {
    @get:InputFile abstract val manifest: RegularFileProperty
    @get:Input abstract val id: Property<String>
    @get:Input abstract val allowed: ListProperty<String>

    @TaskAction
    fun check() {
        val file = manifest.get().asFile
        if (file.readText().contains("AD_ID")) throw GradleException("the merged manifest names AD_ID: $file")
        val factory = DocumentBuilderFactory.newInstance().apply { isNamespaceAware = true }
        val root = factory.newDocumentBuilder().parse(file).documentElement
        if (root.getAttribute("package") != id.get()) throw GradleException("the merged manifest is of ${root.getAttribute("package")}, not ${id.get()}")
        val asked = mutableListOf<String>()
        val open = mutableListOf<String>()
        val android = "http://schemas.android.com/apk/res/android"
        val nodes = root.getElementsByTagName("*")
        for (i in 0 until nodes.length) {
            val node = nodes.item(i) as org.w3c.dom.Element
            if (node.tagName.startsWith("uses-permission")) asked += node.getAttributeNS(android, "name")
            // A component a library brought in that other apps could call.
            if (node.tagName in listOf("activity", "activity-alias", "service", "receiver", "provider") && node.getAttributeNS(android, "exported") == "true") {
                open += node.getAttributeNS(android, "name")
            }
        }
        val extra = asked - allowed.get().toSet()
        if (extra.isNotEmpty()) throw GradleException("the merged manifest asks for permissions that are not in app/build.gradle.kts: $extra")
        if (open != listOf("tw.iamreal.app.MainActivity")) throw GradleException("the components of the merged manifest that other apps can call are $open, not the one activity")
    }
}

/** Fails when the app carries a library that is not on the list: an SDK of someone else, or anything that came with one. */
abstract class CheckLibraries : DefaultTask() {
    @get:Input abstract val libraries: SetProperty<String>
    @get:Input abstract val allowed: ListProperty<String>

    @TaskAction
    fun check() {
        val extra = libraries.get() - allowed.get().toSet()
        if (extra.isNotEmpty()) throw GradleException("the app carries libraries that are not in app/build.gradle.kts: $extra")
    }
}

/**
 * Fails when an installer (an APK, or the bundle Google Play takes) is not
 * what goes out (README.md, "建置時的檢查"):
 * a native library for anything but the ABIs given, or any but ours; a
 * bundled file missing, extra or changed; the production site or the
 * production log's scope string in the Kotlin code; a call that writes
 * to Android's log; the fake card, or the library of the tests with its test issuer
 * keys (unless `testing`: the fake build, which goes nowhere).
 */
abstract class CheckApk : DefaultTask() {
    @get:InputDirectory @get:Optional abstract val apks: DirectoryProperty
    @get:InputFile @get:Optional abstract val aab: RegularFileProperty
    @get:InputFiles abstract val lists: ConfigurableFileCollection
    @get:Input abstract val abis: ListProperty<String>
    @get:Input abstract val silent: Property<Boolean>
    @get:Input abstract val id: Property<String>
    @get:Input abstract val allowed: ListProperty<String>
    @get:Input abstract val testing: Property<Boolean>
    /** design/'s files the installer carries as they are (designResources). */
    @get:InputFiles abstract val design: ConfigurableFileCollection

    @TaskAction
    fun check() {
        val file = if (aab.isPresent) {
            aab.get().asFile
        } else {
            val files = apks.get().asFile.listFiles { f -> f.extension == "apk" }.orEmpty()
            if (files.size != 1) throw GradleException("not exactly one installer in ${apks.get().asFile}")
            files[0]
        }
        // A bundle holds the app's one module under base/, with what an APK has at its top.
        val top = if (aab.isPresent) "base/" else ""
        val problems = mutableListOf<String>()
        ZipFile(file).use { zip ->
            val all = zip.entries().asSequence().map { it.name }.toList()
            val modules = all.filter { "/" in it && !it.startsWith("BUNDLE-METADATA/") }.map { it.substringBefore("/") }.toSet()
            if (aab.isPresent && modules != setOf("base")) problems += "the modules are $modules, not base alone"
            val names = all.filter { it.startsWith(top) }.map { it.removePrefix(top) }
            val read = { name: String -> zip.getInputStream(zip.getEntry(top + name)).use { it.readBytes() } }

            if (aab.isPresent) {
                // The manifest a bundle carries is not text, but the names in it are: the app's
                // identifier, and any permission it asks for.
                val manifest = String(read("manifest/AndroidManifest.xml"), Charsets.ISO_8859_1)
                if (!manifest.contains(id.get())) problems += "the manifest is not of ${id.get()}"
                if (manifest.contains("AD_ID")) problems += "the manifest names AD_ID"
                val asked = Regex("[A-Za-z0-9_.]+\\.permission\\.[A-Za-z0-9_.]+").findAll(manifest).map { it.value }.toSet()
                val extra = asked - allowed.get().toSet()
                if (extra.isNotEmpty()) problems += "the manifest asks for permissions that are not in app/build.gradle.kts: $extra"
            }

            val libs = names.filter { it.startsWith("lib/") }.sorted()
            val wantLibs = abis.get().map { "lib/$it/libiamreal_device_core_jni.so" }.sorted()
            if (libs != wantLibs) problems += "the native libraries are $libs, not $wantLibs"

            val bundled = Hashes.readBundled(lists.files)
            val assets = names.filter { it.startsWith("assets/") }.map { it.removePrefix("assets/") }.sorted()
            if (assets != bundled.keys.sorted()) problems += "the bundled files are $assets, not ${bundled.keys.sorted()}"
            for (name in assets) {
                if (bundled[name] != null && Hashes.sha256(read("assets/$name")) != bundled[name]) problems += "the SHA-256 of assets/$name is not the listed one"
            }

            // design/'s files are in the resources as they are in the repository, byte for byte. Found by their
            // bytes: a release APK has its resources under shortened names (res/c7.otf), a bundle under their own.
            val resources = names.filter { it.startsWith("res/") }
            for (source in design.files) {
                val want = source.readBytes()
                val sameSize = resources.filter { zip.getEntry(top + it).size == want.size.toLong() }
                if (sameSize.none { read(it).contentEquals(want) }) problems += "no file in res/ is $source as it is"
            }

            // Every library the native library asks the system for is named in it as text.
            for (lib in libs) {
                val text = String(read(lib), Charsets.ISO_8859_1)
                if (text.contains("liblog.so")) problems += "$lib links Android's log (liblog.so)"
                // The mark of device-core/prover/src/lib.rs: the library takes issuer keys from its caller.
                if (!testing.get() && text.contains("iamreal-device-core:testing-issuer-keys")) problems += "$lib is the library of the tests: it trusts issuer keys other than MOICA's"
            }
            // A class, a method or a text the Kotlin code refers to is in the dex file as text.
            // Until launch both builds talk to the test site (ADR-0037, Environment.kt): its address is in a dex (in a
            // release build, as the start of the addresses R8 put together). The fake build talks to this machine instead.
            val testSite = "https://test.iamreal.tw"
            var talksToTestSite = false
            for (dex in names.filter { it.endsWith(".dex") }) {
                val text = String(read(dex), Charsets.ISO_8859_1)
                if (text.contains(testSite)) talksToTestSite = true
                // Until launch every build signs for the test log only (ADR-0037).
                for (production in listOf("//iamreal.tw", "//data.iamreal.tw", "iamreal:public:")) {
                    if (text.contains(production)) problems += "$dex holds $production: until launch no build names anything of production"
                }
                // The fake card and the session that trusts test keys are in the emulator test's build alone.
                for (fake in listOf("Ltw/iamreal/app/fake/", "TestingCore")) {
                    if (!testing.get() && text.contains(fake)) problems += "$dex holds $fake: only the fake build has the fake card and the test keys"
                }
                if (!silent.get()) continue
                // Android's own log is not referred to at all. System.out and System.err are PrintStreams, and
                // java.util.logging ends in Android's log too: no method of either is called but the one that
                // makes a Logger, which writes nothing. printStackTrace writes to System.err.
                if (text.contains("Landroid/util/Log;")) problems += "$dex refers to Landroid/util/Log;: a release build writes no log"
                val writes = Dex.methods(read(dex)).filter { (owner, method) ->
                    owner == "Landroid/util/Log;" || owner == "Ljava/io/PrintStream;" || (owner == "Ljava/util/logging/Logger;" && method != "getLogger") || method == "printStackTrace"
                }.map { (owner, method) -> "$owner.$method" }.toSet()
                if (writes.isNotEmpty()) problems += "$dex calls $writes: a release build writes no log"
            }
            if (!testing.get() && !talksToTestSite) problems += "no dex holds $testSite: every build talks to the test site until launch"
        }
        if (problems.isNotEmpty()) throw GradleException("$file:\n" + problems.joinToString("\n"))
    }
}

/**
 * design/'s files the app carries as they are, by where they go in its resources (res/): the sentences of the
 * card proof and of the app, and the subset of the headings' typeface. Each is design/'s own file, not a copy kept here.
 */
val designResources = mapOf(
    "raw/card_proof_copy.json" to rootProject.file("../design/copy/card-proof.json"),
    "raw/app_copy.json" to rootProject.file("../design/copy/app.json"),
    "font/genryumin2tw_b.otf" to rootProject.file("../design/fonts/GenRyuMin2TW-B.otf"),
)

val core = rootProject.file("../device-core")
val nativeSources = files(
    rootProject.file("build-native.sh"),
    rootProject.file("fetch-zig.sh"),
    rootProject.file("zig.sha256"),
    rootProject.file("jni"),
    core.resolve("Cargo.toml"),
    core.resolve("Cargo.lock"),
    core.resolve("rust-toolchain.toml"),
    core.resolve("barretenberg.sha256"),
    core.resolve("fetch-barretenberg.sh"),
    core.resolve(".cargo/config.toml"),
    core.resolve("include"),
    fileTree(core.resolve("checks")) { include("Cargo.toml", "build.rs", "src/**") },
    fileTree(core.resolve("prover")) { include("Cargo.toml", "build.rs", "src/**") },
)

val buildNativeHost = tasks.register<BuildNativeHost>("buildNativeHost") {
    usesService(nativeBuilds)
    sources.from(nativeSources)
    script = rootProject.file("build-native.sh")
    out = layout.buildDirectory.dir("native/host")
}

androidComponents {
    // The unit tests run against the code of the app that goes out; the fake build has the emulator test.
    beforeVariants { variant ->
        if (variant.buildType == fakeBuild) (variant as com.android.build.api.variant.HasUnitTestBuilder).enableUnitTest = false
    }
    onVariants { variant ->
        val name = variant.name.replaceFirstChar { it.uppercase() }
        val release = variant.buildType == "release"
        val fake = variant.buildType == fakeBuild
        val variantAbis = if (release) releaseAbis else debugAbis
        val variantId = ids.getValue(variant.buildType!!)
        // The network, and what androidx.core declares for itself: a permission of this app's own, which only this app holds.
        val variantPermissions = allowedPermissions + "$variantId.DYNAMIC_RECEIVER_NOT_EXPORTED_PERMISSION"

        val native = tasks.register<BuildNative>("buildNative$name") {
            abis = variantAbis
            api = minApi
            ndk = androidComponents.sdkComponents.ndkDirectory.map { it.asFile.path }
            testing = fake
            usesService(nativeBuilds)
            sources.from(nativeSources)
            script = rootProject.file("build-native.sh")
        }
        variant.sources.jniLibs!!.addGeneratedSourceDirectory(native, BuildNative::out)

        val bundle = tasks.register<BundleFiles>("bundleFiles$name") {
            lists.from(bundledLists)
            // Where each file comes from: the circuits the page uses, the verifier's keys, the parameter files device-core/fetch-crs.sh checked.
            from.from(rootProject.file("../web/circuits"), rootProject.file("../verifier/vk"), rootProject.file("../device-core/vendor/crs"))
        }
        variant.sources.assets!!.addGeneratedSourceDirectory(bundle, BundleFiles::out)

        val copyDesign = tasks.register<CopyDesign>("copyDesign$name") {
            resources = designResources
        }
        variant.sources.res!!.addGeneratedSourceDirectory(copyDesign, CopyDesign::out)

        val checkManifest = tasks.register<CheckManifest>("checkManifest$name") {
            manifest = variant.artifacts.get(SingleArtifact.MERGED_MANIFEST)
            allowed = variantPermissions
            id = variantId
        }
        val checkApk = tasks.register<CheckApk>("checkApk$name") {
            design.from(designResources.values)
            apks = variant.artifacts.get(SingleArtifact.APK)
            lists.from(bundledLists)
            abis = variantAbis
            silent = release
            id = variantId
            allowed = variantPermissions
            testing = fake
        }
        val checkLibraries = tasks.register<CheckLibraries>("checkLibraries$name") {
            // Every file the app is packaged with, by where it came from: a module of a repository
            // as group:name, anything else (a jar or an aar given as a file) as Gradle names it.
            libraries = variant.runtimeConfiguration.incoming.artifacts.resolvedArtifacts.map { artifacts ->
                artifacts.map { it.id.componentIdentifier }
                    .map { if (it is ModuleComponentIdentifier) "${it.group}:${it.module}" else it.displayName }
                    .toSet()
            }
            allowed = allowedLibraries
        }
        tasks.named("check") { dependsOn(checkManifest, checkApk, checkLibraries) }
        val checkBundle = tasks.register<CheckApk>("checkBundle$name") {
            design.from(designResources.values)
            aab = variant.artifacts.get(SingleArtifact.BUNDLE)
            lists.from(bundledLists)
            abis = variantAbis
            silent = release
            id = variantId
            allowed = variantPermissions
            testing = fake
        }
        // Whoever makes an installer gets it checked, whichever task makes it: an APK
        // (assemble, package) or the bundle Google Play takes (bundle).
        tasks.matching { it.name == "assemble$name" || it.name == "package$name" }.configureEach { finalizedBy(checkManifest, checkApk, checkLibraries) }
        tasks.matching { it.name == "bundle$name" }.configureEach { finalizedBy(checkManifest, checkBundle, checkLibraries) }
    }
}

// No start-up profile in the installer: the libraries of the screens bring one (a list of their methods for
// Android to compile ahead), which the build would add to assets/ next to the bundled files.
tasks.configureEach {
    if (name.matches(Regex("(compile|merge|expand).*ArtProfile.*"))) enabled = false
}

// The unit tests run on the JVM of this machine, against the same Rust and the same JNI layer built for it.
tasks.withType<Test>().configureEach {
    // The library is an input: a change in device-core/ or jni/ runs the tests again.
    inputs.files(buildNativeHost)
    systemProperty("java.library.path", layout.buildDirectory.dir("native/host").get().asFile.path)
    systemProperty("iamreal.vectors", rootProject.file("../spec/vectors").path)
    // The files an installer carries, where bundleFiles takes them from.
    systemProperty("iamreal.bundled", listOf("../web/circuits", "../verifier/vk", "../device-core/vendor/crs").joinToString(File.pathSeparator) { rootProject.file(it).path })
    systemProperty("iamreal.copy", rootProject.file("../design/copy").path)
    // The name under the icon of each build: the store's in main/, the development build's in debug/.
    systemProperty("iamreal.strings.store", file("src/main/res/values/strings.xml").path)
    systemProperty("iamreal.strings.dev", file("src/debug/res/values/strings.xml").path)
    inputs.files("src/main/res/values/strings.xml", "src/debug/res/values/strings.xml")
    inputs.dir(rootProject.file("../spec/vectors"))
    inputs.files(rootProject.file("../design/copy/app.md"), rootProject.file("../design/copy/app.json"))
}
