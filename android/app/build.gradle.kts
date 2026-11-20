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
// The files every installer carries, each with its SHA-256.
val bundledList = rootProject.file("bundled.sha256")
// The permissions the merged manifest may ask for. None yet.
val allowedPermissions = emptyList<String>()

android {
    namespace = "tw.iamreal.app"
    compileSdk = 36
    buildToolsVersion = "36.0.0"
    ndkVersion = "29.0.14206865"

    defaultConfig {
        // The test app (ADR-0036). The site it talks to and the roster it signs for are in Environment.kt.
        applicationId = "tw.iamreal.app.test"
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

    /** `bundled.sha256` as name to SHA-256. */
    fun readBundled(list: File): Map<String, String> =
        list.readLines().filter { it.isNotBlank() }.associate {
            val (hash, name) = it.split("  ", limit = 2)
            name to hash
        }
}

/** Copies the bundled files into `out`, each only after its SHA-256 is the one in `bundled.sha256`. */
abstract class BundleFiles : DefaultTask() {
    @get:InputFile abstract val list: RegularFileProperty
    @get:InputFiles abstract val from: ConfigurableFileCollection
    @get:OutputDirectory abstract val out: DirectoryProperty

    @TaskAction
    fun bundle() {
        val dir = out.get().asFile
        dir.deleteRecursively()
        dir.mkdirs()
        for ((name, hash) in Hashes.readBundled(list.get().asFile)) {
            val source = from.files.map { it.resolve(name) }.firstOrNull { it.isFile }
                ?: throw GradleException("$name of bundled.sha256 is in none of ${from.files} (the parameter files: ./fetch-crs.sh)")
            if (Hashes.sha256(source.readBytes()) != hash) throw GradleException("the SHA-256 of $source is not the one in bundled.sha256")
            source.copyTo(dir.resolve(name))
        }
    }
}

/** Fails when the merged manifest asks for a permission that is not allowed, or names the advertising ID anywhere. */
abstract class CheckManifest : DefaultTask() {
    @get:InputFile abstract val manifest: RegularFileProperty
    @get:Input abstract val allowed: ListProperty<String>

    @TaskAction
    fun check() {
        val file = manifest.get().asFile
        if (file.readText().contains("AD_ID")) throw GradleException("the merged manifest names AD_ID: $file")
        val factory = DocumentBuilderFactory.newInstance().apply { isNamespaceAware = true }
        val root = factory.newDocumentBuilder().parse(file).documentElement
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
 * bundled file missing, extra or changed; a way to Android's log.
 */
abstract class CheckApk : DefaultTask() {
    @get:InputDirectory abstract val apks: DirectoryProperty
    @get:InputFile abstract val list: RegularFileProperty
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

            val bundled = Hashes.readBundled(list.get().asFile)
            val assets = names.filter { it.startsWith("assets/") }.map { it.removePrefix("assets/") }.sorted()
            if (assets != bundled.keys.sorted()) problems += "the bundled files are $assets, not ${bundled.keys.sorted()}"
            for (name in assets) {
                if (bundled[name] != null && Hashes.sha256(read("assets/$name")) != bundled[name]) problems += "the SHA-256 of assets/$name is not the one in bundled.sha256"
            }

            // Every library the native library asks the system for is named in it as text.
            for (lib in libs) {
                if (String(read(lib), Charsets.ISO_8859_1).contains("liblog.so")) problems += "$lib links Android's log (liblog.so)"
            }
            if (silent.get()) {
                // A class the code refers to is named in the dex file as text.
                for (dex in names.filter { it.endsWith(".dex") }) {
                    val text = String(read(dex), Charsets.ISO_8859_1)
                    for (cls in listOf("Landroid/util/Log;", "Ljava/io/PrintStream;", "Ljava/util/logging/Logger;")) {
                        if (text.contains(cls)) problems += "$dex refers to $cls: a release build writes no log"
                    }
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
    core.resolve("include"),
    fileTree(core.resolve("checks")) { include("Cargo.toml", "src/**") },
    fileTree(core.resolve("prover")) { include("Cargo.toml", "src/**") },
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
            list = bundledList
            // Where each file comes from: the circuits the page uses, the verifier's keys, the parameter files fetch-crs.sh checked.
            from.from(rootProject.file("../web/circuits"), rootProject.file("../verifier/vk"), rootProject.file("vendor/crs"))
        }
        variant.sources.assets!!.addGeneratedSourceDirectory(bundle, BundleFiles::out)

        val checkManifest = tasks.register<CheckManifest>("checkManifest$name") {
            manifest = variant.artifacts.get(SingleArtifact.MERGED_MANIFEST)
            allowed = allowedPermissions
        }
        val checkApk = tasks.register<CheckApk>("checkApk$name") {
            apks = variant.artifacts.get(SingleArtifact.APK)
            list = bundledList
            abis = variantAbis
            silent = release
        }
        tasks.named("check") { dependsOn(checkManifest, checkApk) }
    }
}

// The unit tests run on the JVM of this machine, against the same Rust and the same JNI layer built for it.
tasks.withType<Test>().configureEach {
    dependsOn(buildNativeHost)
    systemProperty("java.library.path", layout.buildDirectory.dir("native/host").get().asFile.path)
    systemProperty("iamreal.vectors", rootProject.file("../spec/vectors").path)
}
