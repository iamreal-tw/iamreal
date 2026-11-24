package tw.iamreal.app.ui

import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.font.Font
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.em
import androidx.compose.ui.unit.sp
import tw.iamreal.app.R

/**
 * The values of design/tokens.json the screens draw with, each written as
 * tokens.json writes it, by the token's name (the name of the CSS variable).
 * What each means and where it is not to be used is design/DESIGN.md's;
 * ThemeTest compares every one with the file. A phone draws the phone's
 * values: the ones named `-phone` where tokens.json has one.
 */
internal object Tokens {
    val css: Map<String, String> = mapOf(
        "--bg" to "#FFFFFF",
        "--ink" to "#141414",
        "--text" to "#2E3135",
        "--mute" to "#5A5F64",
        "--line" to "#E3E5E7",
        "--soft" to "#F6F7F7",
        "--dot" to "#CDD2D6",
        "--you" to "#BF2150",
        "--you-hover" to "#A51A44",
        "--size-h2-phone" to "28px",
        "--size-h3-phone" to "21px",
        "--size-lead-phone" to "19px",
        "--size-body-phone" to "16px",
        "--size-kicker-phone" to "14px",
        "--size-small" to "14px",
        "--weight-heading" to "700",
        "--weight-account" to "800",
        "--weight-body" to "400",
        "--leading-h2" to "1.34",
        "--leading-h3" to "1.5",
        "--leading-body" to "1.85",
        "--leading-kicker" to "1.6",
        "--leading-small" to "1.7",
        "--gutter-phone" to "20px",
        "--button-height" to "56px",
        "--radius" to "4px",
        "--radius-panel" to "12px",
        "--min-target" to "44px",
    )

    private fun value(name: String): String = css[name] ?: throw IllegalArgumentException("$name is not a token of the theme")

    /** A colour, `#RRGGBB`, as an opaque ARGB number. */
    fun colour(name: String): Int = (0xFF000000 or value(name).removePrefix("#").toLong(16)).toInt()

    /** A length in CSS pixels: on the phone, dp or sp. */
    fun px(name: String): Float = value(name).removeSuffix("px").toFloat()

    /** A number with no unit: a weight, or a line height as a multiple of the size. */
    fun number(name: String): Float = value(name).toFloat()
}

/** The colours (design/DESIGN.md, "顏色"). Light only: the pages have no dark look either. */
internal object Colours {
    val bg = Color(Tokens.colour("--bg"))
    val ink = Color(Tokens.colour("--ink"))
    val text = Color(Tokens.colour("--text"))
    val mute = Color(Tokens.colour("--mute"))
    val line = Color(Tokens.colour("--line"))
    val soft = Color(Tokens.colour("--soft"))
    val dot = Color(Tokens.colour("--dot"))
    val you = Color(Tokens.colour("--you"))
    val youPressed = Color(Tokens.colour("--you-hover"))
}

/** Type and the sizes of things (design/DESIGN.md, "字", "元件"). */
internal object Type {
    /** GenRyuMin2 TW, the subset of design/fonts/ the build puts in the app: its one weight, bold. */
    val display = FontFamily(Font(R.font.genryumin2tw_b, FontWeight.Bold))

    /** The body is the system's sans-serif; numbers and addresses the system's monospace. */
    val mono = FontFamily.Monospace

    val heading = FontWeight(Tokens.number("--weight-heading").toInt())
    val account = FontWeight(Tokens.number("--weight-account").toInt())
    val body = FontWeight(Tokens.number("--weight-body").toInt())

    val h2 = Tokens.px("--size-h2-phone").sp
    val h3 = Tokens.px("--size-h3-phone").sp
    val lead = Tokens.px("--size-lead-phone").sp
    val bodySize = Tokens.px("--size-body-phone").sp
    val kicker = Tokens.px("--size-kicker-phone").sp
    val small = Tokens.px("--size-small").sp

    val leadingH2 = Tokens.number("--leading-h2").em
    val leadingH3 = Tokens.number("--leading-h3").em
    val leadingBody = Tokens.number("--leading-body").em
    val leadingKicker = Tokens.number("--leading-kicker").em
    val leadingSmall = Tokens.number("--leading-small").em

    val gutter = Tokens.px("--gutter-phone").dp
    val buttonHeight = Tokens.px("--button-height").dp
    val radius = Tokens.px("--radius").dp
    val radiusPanel = Tokens.px("--radius-panel").dp
    val minTarget = Tokens.px("--min-target").dp
}
