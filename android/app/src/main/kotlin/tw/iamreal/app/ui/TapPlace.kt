package tw.iamreal.app.ui

import androidx.compose.foundation.Canvas
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.aspectRatio
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.text.BasicText
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.geometry.CornerRadius
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.graphics.Path
import androidx.compose.ui.graphics.PathEffect
import androidx.compose.ui.graphics.StrokeCap
import androidx.compose.ui.graphics.StrokeJoin
import androidx.compose.ui.graphics.drawscope.DrawScope
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.semantics.clearAndSetSemantics
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.text.SpanStyle
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.buildAnnotatedString
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.withStyle
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.em

/**
 * Where the card goes, on step 2 before the card is read (design/copy/card-proof.md, "2. 讀取卡片", app;
 * design/screens/card-proof-app-2-read-android-phone.png): the back of a phone with the card's place drawn in
 * red dashes, then the card held there, with arrows up and down. Ink lines, the cardholder's card in red
 * (design/DESIGN.md, "插圖"). A screen reader reads one sentence for the whole of it.
 */
@Composable
internal fun TapPlace(c: Copy) {
    Column(
        Modifier.fillMaxWidth().padding(top = 8.dp).clearAndSetSemantics { contentDescription = c.say("app_read.figure_android") }.testTag("tap-place"),
        horizontalAlignment = Alignment.CenterHorizontally,
        verticalArrangement = Arrangement.spacedBy(8.dp),
    ) {
        Canvas(Modifier.widthIn(max = WIDTH.dp).fillMaxWidth().aspectRatio(WIDTH / HEIGHT)) { phones(size.width / WIDTH) }
        Row(Modifier.widthIn(max = WIDTH.dp).fillMaxWidth()) {
            Caption(c.say("app_read.figure_flip"), c.say("app_read.figure_flip_emphasis"), Modifier.weight(1f))
            Caption(c.say("app_read.figure_middle"), c.say("app_read.figure_middle_emphasis"), Modifier.weight(1f))
        }
    }
}

/** One caption, its [emphasis] in ink and bold. */
@Composable
private fun Caption(text: String, emphasis: String, modifier: Modifier) {
    val at = text.indexOf(emphasis)
    val shown = buildAnnotatedString {
        if (at < 0) {
            append(text)
        } else {
            append(text.substring(0, at))
            withStyle(SpanStyle(color = Colours.ink, fontWeight = Type.weightHeading)) { append(emphasis) }
            append(text.substring(at + emphasis.length))
        }
    }
    BasicText(shown, modifier, style = TextStyle(color = Colours.text, fontSize = Type.sizeSmall, lineHeight = 1.5.em, textAlign = TextAlign.Center))
}

/** The drawing, in the units of a 350 × 210 box, [u] pixels each. */
private fun DrawScope.phones(u: Float) {
    fun at(x: Float, y: Float) = Offset(x * u, y * u)
    fun box(x: Float, y: Float, w: Float, h: Float) = Pair(at(x, y), Size(w * u, h * u))
    val ink = Stroke(2.5f * u)
    val thin = Stroke(2f * u)

    // A phone from the back: its body and the cameras at the top left.
    fun phone(x: Float) {
        box(x, 4f, 120f, 196f).let { (o, s) ->
            drawRoundRect(Colours.bg, o, s, CornerRadius(18f * u))
            drawRoundRect(Colours.ink, o, s, CornerRadius(18f * u), style = ink)
        }
        box(x + 12f, 14f, 26f, 62f).let { (o, s) ->
            drawRoundRect(Colours.soft, o, s, CornerRadius(13f * u))
            drawRoundRect(Colours.ink, o, s, CornerRadius(13f * u), style = thin)
        }
        for (cy in listOf(29f, 51f)) {
            drawCircle(Colours.bg, 7.5f * u, at(x + 25f, cy))
            drawCircle(Colours.ink, 7.5f * u, at(x + 25f, cy), style = thin)
        }
        drawCircle(Colours.ink, 3f * u, at(x + 25f, 68f))
    }

    // ① Turned over: where the card goes, in dashes.
    phone(14f)
    box(18f, 64f, 112f, 80f).let { (o, s) ->
        drawRoundRect(Colours.you, o, s, CornerRadius(8f * u), style = Stroke(2.5f * u, pathEffect = PathEffect.dashPathEffect(floatArrayOf(7f * u, 5f * u))))
    }

    // ② The card held there, and moved up and down when nothing happens.
    phone(196f)
    box(190f, 62f, 132f, 84f).let { (o, s) -> drawRoundRect(Colours.you, o, s, CornerRadius(9f * u), alpha = 0.88f) }
    box(204f, 86f, 22f, 16f).let { (o, s) -> drawRoundRect(Colours.bg, o, s, CornerRadius(3f * u), alpha = 0.85f) }
    val arrow = Stroke(2f * u, cap = StrokeCap.Round, join = StrokeJoin.Round)
    for ((from, to) in listOf(74f to 60f, 134f to 148f)) {
        val head = if (to < from) 6f else -6f
        val path = Path().apply {
            moveTo(334f * u, from * u)
            lineTo(334f * u, to * u)
            moveTo(328f * u, (to + head) * u)
            lineTo(334f * u, to * u)
            lineTo(340f * u, (to + head) * u)
        }
        drawPath(path, Colours.ink, style = arrow)
    }
}

private const val WIDTH = 350f
private const val HEIGHT = 210f
