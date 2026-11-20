// The Android app (README.md). Plugins and libraries come from Google's
// Maven repository and Maven Central only; what was downloaded is checked
// against gradle/verification-metadata.xml.
pluginManagement {
    repositories {
        google()
        mavenCentral()
    }
}

dependencyResolutionManagement {
    repositoriesMode = RepositoriesMode.FAIL_ON_PROJECT_REPOS
    repositories {
        google()
        mavenCentral()
    }
}

rootProject.name = "iamreal-android"
include(":app")
