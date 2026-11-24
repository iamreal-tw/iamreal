package tw.iamreal.app.ui

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.safeDrawingPadding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.text.BasicText
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.unit.em
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp

/**
 * What the app shows when it opens, before step 1 (design/copy/app.md,
 * "啟動畫面"; design/screens/app-splash-phone.png): the mark in the middle,
 * and at the bottom the name and the site, a thin line between them, as
 * beside the name in the pages' header. The words are app.json's.
 */
@Composable
internal fun Splash(name: String, site: String) = Box(Modifier.fillMaxSize().background(Colours.bg)) {
    // In the middle of the whole screen, where the system's splash draws it (res/values-v31/).
    Logo(Modifier.size(SPLASH_MARK).align(Alignment.Center))
    Row(
        Modifier.align(Alignment.BottomCenter).safeDrawingPadding().padding(bottom = 56.dp),
        horizontalArrangement = Arrangement.spacedBy(12.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        BasicText(name, style = TextStyle(color = Colours.ink, fontSize = 17.sp, lineHeight = 1.em, fontWeight = Type.heading, fontFamily = Type.display, letterSpacing = 0.08.em))
        Box(Modifier.width(1.dp).height(16.dp).background(Colours.line))
        BasicText(site, style = TextStyle(color = Colours.mute, fontSize = 15.sp, lineHeight = 1.em, fontFamily = Type.display))
    }
}

/** The mark's size on the splash; the system's own splash (Android 12 on, res/values-v31/) draws it as large. */
internal val SPLASH_MARK = 112.dp
