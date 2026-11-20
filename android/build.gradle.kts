// Exact versions, as CONTRIBUTING.md requires of every package (README.md, "工具和套件").
plugins {
    id("com.android.application") version "9.5.1" apply false
    // The Kotlin that AGP's built-in support compiles with, in place of the older one AGP names by itself.
    id("org.jetbrains.kotlin.android") version "2.4.21" apply false
}
