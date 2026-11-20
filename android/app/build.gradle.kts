// The test app (README.md). What this file decides: the identifiers, the
// one Android version the app is built for, how the native library and the
// bundled files get into the installer, and the checks of what was built.
import com.android.build.api.artifact.SingleArtifact
import java.security.MessageDigest
import java.util.zip.ZipFile
import javax.inject.Inject
import javax.xml.parsers.DocumentBuilderFactory

plugins {
    id("com.android.application")
}

// The lowest Android the app runs on: API 29 (Android 10). Barretenberg's
// library for Android keeps its thread-local variables the way Android
// supports from API 29 on (README.md, "minSdk").
val minApi = 29
// The files every installer carries, each with its SHA-256: the circuits and their keys, and the parameter files.
val bundledLists = files(rootProject.file("bundled.sha256"), rootProject.file("../device-core/crs.sha256"))
// The one app this directory builds (ADR-0036).
val appId = "tw.iamreal.app.test"
// The permissions the merged manifest may ask for. None yet.
val allowedPermissions = emptyList<String>()

android {
    namespace = "tw.iamreal.app"
    compileSdk = 36
    buildToolsVersion = "36.0.0"
    ndkVersion = "29.0.14206865"

    defaultConfig {
        // The test app (ADR-0036). The site it talks to and the roster it signs for are in Environment.kt.
        applicationId = appId
        minSdk = minApi
        targetSdk = 36
        versionCode = 1
        versionName = "2026.11.20"
    }

    buildTypes {
        debug {
            // For a phone on a cable and for the emulator.
            ndk { abiFilters += listOf("arm64-v8a", "x86_64") }
        }
        release {
            // What goes out: phones only.
            ndk { abiFilters += "arm64-v8a" }
            isMinifyEnabled = true
            proguardFiles("proguard-rules.pro")
        }
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
    // Only for the tests on the JVM. The app itself uses no library but Kotlin's own.
    testImplementation("junit:junit:4.13.2")
    // The JSON reader Android has built in, for the JVM: the tests read spec/vectors/ with it.
    testImplementation("org.json:json:20260814")
}

/** Runs build-native.sh for each ABI: `out/<abi>/libiamreal_device_core_jni.so`. */
abstract class BuildNative : DefaultTask() {
    @get:Input abstract val abis: ListProperty<String>
    @get:Input abstract val api: Property<Int>
    @get:Input abstract val ndk: Property<String>
    @get:InputFiles @get:PathSensitive(PathSensitivity.RELATIVE) abstract val sources: ConfigurableFileCollection
    @get:Internal abstract val script: RegularFileProperty
    @get:OutputDirectory abstract val out: DirectoryProperty
    @get:Inject abstract val exec: ExecOperations

    @TaskAction
    fun build() {
        for (abi in abis.get()) {
            exec.exec {
                environment("ANDROID_NDK_ROOT", ndk.get())
                commandLine(script.get().asFile.path, abi, api.get().toString(), out.get().dir(abi).asFile.path)
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

/** Fails when the merged manifest is of another app, asks for a permission that is not allowed, or names the advertising ID anywhere. */
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
        val nodes = root.getElementsByTagName("*")
        for (i in 0 until nodes.length) {
            val node = nodes.item(i) as org.w3c.dom.Element
            if (node.tagName.startsWith("uses-permission")) {
                asked += node.getAttributeNS("http://schemas.android.com/apk/res/android", "name")
            }
        }
        val extra = asked - allowed.get().toSet()
        if (extra.isNotEmpty()) throw GradleException("the merged manifest asks for permissions that are not in app/build.gradle.kts: $extra")
    }
}

/**
 * Fails when an installer is not what goes out (README.md, "建置時的檢查"):
 * a native library for anything but the ABIs given, or any but ours; a
 * bundled file missing, extra or changed; the production site or the
 * production roster's scope string in the Kotlin code; a way to Android's
 * log.
 */
abstract class CheckApk : DefaultTask() {
    @get:InputDirectory abstract val apks: DirectoryProperty
    @get:InputFiles abstract val lists: ConfigurableFileCollection
    @get:Input abstract val abis: ListProperty<String>
    @get:Input abstract val silent: Property<Boolean>

    @TaskAction
    fun check() {
        val files = apks.get().asFile.listFiles { f -> f.extension == "apk" }.orEmpty()
        if (files.size != 1) throw GradleException("not exactly one installer in ${apks.get().asFile}")
        val problems = mutableListOf<String>()
        ZipFile(files[0]).use { zip ->
            val names = zip.entries().asSequence().map { it.name }.toList()
            val read = { name: String -> zip.getInputStream(zip.getEntry(name)).use { it.readBytes() } }

            val libs = names.filter { it.startsWith("lib/") }.sorted()
            val wantLibs = abis.get().map { "lib/$it/libiamreal_device_core_jni.so" }.sorted()
            if (libs != wantLibs) problems += "the native libraries are $libs, not $wantLibs"

            val bundled = Hashes.readBundled(lists.files)
            val assets = names.filter { it.startsWith("assets/") }.map { it.removePrefix("assets/") }.sorted()
            if (assets != bundled.keys.sorted()) problems += "the bundled files are $assets, not ${bundled.keys.sorted()}"
            for (name in assets) {
                if (bundled[name] != null && Hashes.sha256(read("assets/$name")) != bundled[name]) problems += "the SHA-256 of assets/$name is not the listed one"
            }

            // Every library the native library asks the system for is named in it as text.
            for (lib in libs) {
                if (String(read(lib), Charsets.ISO_8859_1).contains("liblog.so")) problems += "$lib links Android's log (liblog.so)"
            }
            // A class, a method or a text the Kotlin code refers to is in the dex file as text.
            for (dex in names.filter { it.endsWith(".dex") }) {
                val text = String(read(dex), Charsets.ISO_8859_1)
                // The test app talks to the test site and signs for the test roster only (ADR-0036).
                for (production in listOf("//iamreal.tw", "//data.iamreal.tw", "iamreal:public:")) {
                    if (text.contains(production)) problems += "$dex holds $production: the test app names nothing of production"
                }
                if (!silent.get()) continue
                // System.out and System.err are PrintStreams; printStackTrace writes to System.err.
                for (log in listOf("Landroid/util/Log;", "Ljava/io/PrintStream;", "Ljava/util/logging/Logger;", "printStackTrace")) {
                    if (text.contains(log)) problems += "$dex refers to $log: a release build writes no log"
                }
            }
        }
        if (problems.isNotEmpty()) throw GradleException("${files[0]}:\n" + problems.joinToString("\n"))
    }
}

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
    sources.from(nativeSources)
    script = rootProject.file("build-native.sh")
    out = layout.buildDirectory.dir("native/host")
}

androidComponents {
    onVariants { variant ->
        val name = variant.name.replaceFirstChar { it.uppercase() }
        val release = variant.buildType == "release"
        val variantAbis = if (release) listOf("arm64-v8a") else listOf("arm64-v8a", "x86_64")

        val native = tasks.register<BuildNative>("buildNative$name") {
            abis = variantAbis
            api = minApi
            ndk = androidComponents.sdkComponents.ndkDirectory.map { it.asFile.path }
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

        val checkManifest = tasks.register<CheckManifest>("checkManifest$name") {
            manifest = variant.artifacts.get(SingleArtifact.MERGED_MANIFEST)
            allowed = allowedPermissions
            id = appId
        }
        val checkApk = tasks.register<CheckApk>("checkApk$name") {
            apks = variant.artifacts.get(SingleArtifact.APK)
            lists.from(bundledLists)
            abis = variantAbis
            silent = release
        }
        tasks.named("check") { dependsOn(checkManifest, checkApk) }
        // Whoever assembles an installer, a job that uploads included, gets it checked.
        tasks.matching { it.name == "assemble$name" }.configureEach { finalizedBy(checkManifest, checkApk) }
    }
}

// The unit tests run on the JVM of this machine, against the same Rust and the same JNI layer built for it.
tasks.withType<Test>().configureEach {
    dependsOn(buildNativeHost)
    systemProperty("java.library.path", layout.buildDirectory.dir("native/host").get().asFile.path)
    systemProperty("iamreal.vectors", rootProject.file("../spec/vectors").path)
    systemProperty("iamreal.copy", rootProject.file("../design/copy").path)
    systemProperty("iamreal.strings", file("src/main/res/values/strings.xml").path)
    inputs.dir(rootProject.file("../spec/vectors"))
    inputs.file(rootProject.file("../design/copy/card-proof.md"))
}
