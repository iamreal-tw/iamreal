// The test app (README.md). What this file decides: the identifiers, the
// one Android version the app is built for, how the native library and the
// bundled files get into the installer, and the checks of what was built.
import com.android.build.api.artifact.SingleArtifact
import org.gradle.api.artifacts.component.ModuleComponentIdentifier
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
// The ABIs of each kind of build: what goes out is for phones only; a debug build is also for the emulator on x86-64.
val releaseAbis = listOf("arm64-v8a")
val debugAbis = listOf("arm64-v8a", "x86_64")
// The libraries the app may carry: Kotlin's own, and the annotations it names. No SDK of anyone else.
val allowedLibraries = listOf("org.jetbrains.kotlin:kotlin-stdlib", "org.jetbrains:annotations")
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
            ndk { abiFilters += debugAbis }
        }
        release {
            // What goes out: phones only.
            ndk { abiFilters += releaseAbis }
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
 * production roster's scope string in the Kotlin code; a way to Android's
 * log.
 */
abstract class CheckApk : DefaultTask() {
    @get:InputDirectory @get:Optional abstract val apks: DirectoryProperty
    @get:InputFile @get:Optional abstract val aab: RegularFileProperty
    @get:InputFiles abstract val lists: ConfigurableFileCollection
    @get:Input abstract val abis: ListProperty<String>
    @get:Input abstract val silent: Property<Boolean>

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
        if (problems.isNotEmpty()) throw GradleException("$file:\n" + problems.joinToString("\n"))
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
        val variantAbis = if (release) releaseAbis else debugAbis

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
            aab = variant.artifacts.get(SingleArtifact.BUNDLE)
            lists.from(bundledLists)
            abis = variantAbis
            silent = release
        }
        // Whoever makes an installer gets it checked, whichever task makes it: an APK
        // (assemble, package) or the bundle Google Play takes (bundle).
        tasks.matching { it.name == "assemble$name" || it.name == "package$name" }.configureEach { finalizedBy(checkManifest, checkApk, checkLibraries) }
        tasks.matching { it.name == "bundle$name" }.configureEach { finalizedBy(checkManifest, checkBundle, checkLibraries) }
    }
}

// The unit tests run on the JVM of this machine, against the same Rust and the same JNI layer built for it.
tasks.withType<Test>().configureEach {
    // The library is an input: a change in device-core/ or jni/ runs the tests again.
    inputs.files(buildNativeHost)
    systemProperty("java.library.path", layout.buildDirectory.dir("native/host").get().asFile.path)
    systemProperty("iamreal.vectors", rootProject.file("../spec/vectors").path)
    systemProperty("iamreal.copy", rootProject.file("../design/copy").path)
    systemProperty("iamreal.strings", file("src/main/res/values/strings.xml").path)
    inputs.file(file("src/main/res/values/strings.xml"))
    inputs.dir(rootProject.file("../spec/vectors"))
    inputs.file(rootProject.file("../design/copy/app.md"))
}
