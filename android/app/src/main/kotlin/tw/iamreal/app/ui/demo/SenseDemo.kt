package tw.iamreal.app.ui.demo

import androidx.compose.foundation.Canvas
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.aspectRatio
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.derivedStateOf
import androidx.compose.runtime.getValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clipToBounds
import androidx.compose.ui.geometry.CornerRadius
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.RoundRect
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.graphics.Path
import androidx.compose.ui.graphics.PathEffect
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.graphics.drawscope.clipPath
import androidx.compose.ui.semantics.clearAndSetSemantics
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.testTag
import androidx.compose.ui.unit.dp
import tw.iamreal.app.ui.Colours
import tw.iamreal.app.ui.Type

// The demonstration of step 2 (design/copy/card-proof.md, "示範"; design/motion/README.md, "感應位置"): the phone,
// its front to the cardholder, does not move; the card, red, comes from the right and goes behind it, moves slowly up
// and down its back, and stops where the phone reads it: a red ring, once. What the phone hides of the card shows
// through as a red dashed outline. No hand, no turning the phone, no library.
//
// What the picture is at a moment is senseStateAt's to say (SenseMotion.kt, design/motion/sense.json); this file
// draws that state. It plays three rounds, then rests with the card in place.

/** The platform whose rounds the app shows: the card looks for its place, which differs from one Android phone to another. */
private const val VARIANT = "android"

/** The picture: this wide for its height. */
private const val ASPECT = 1.5f

/** A phone and a card by their sizes in millimetres: a phone about 75 by 160, a card 85.6 by 54 (ISO/IEC 7810, ID-1). */
private val PHONE = Size(75f, 160f)
private val CARD = Size(85.6f, 54f)

/** The demonstration's time, for one visit of step 2. */
internal class SenseDemoPlayer private constructor(val timeline: SenseTimeline) : DemoPlayer(timeline.length) {
    /** [json]: design/motion/sense.json. */
    constructor(json: String) : this(SenseTimeline(json, VARIANT))

    /** The picture at this moment. */
    val state: SenseState by derivedStateOf { senseStateAt(timeline, seconds) }
}

/**
 * The picture of the demonstration. It starts by itself when step 2 comes up, once. To a screen reader it is one
 * element that reads [told].
 */
@Composable
internal fun SenseDemo(player: SenseDemoPlayer, told: String, modifier: Modifier = Modifier) {
    LaunchedEffect(player) { player.playOnce() }
    Frames(player)
    Canvas(
        modifier
            .fillMaxWidth()
            .aspectRatio(ASPECT)
            .background(Colours.soft, RoundedCornerShape(Type.radiusPanel))
            .clipToBounds()
            .clearAndSetSemantics {
                contentDescription = told
                testTag = "sense-demo"
            },
    ) {
        val state = player.state
        // The phone stands in the middle, a little to the left: the card comes from the right.
        val height = size.height * 0.86f
        val unit = height / PHONE.height
        val phone = Size(PHONE.width * unit, height)
        val at = Offset(size.width * 0.42f - phone.width / 2, (size.height - height) / 2)
        val card = Size(CARD.width * unit, CARD.height * unit)
        // The card's centre: `y` down the phone, `x` phone widths to the right of the phone's middle.
        val centre = Offset(at.x + phone.width / 2 + state.card.x.toFloat() * phone.width, at.y + state.card.y.toFloat() * phone.height)
        val cardAt = Offset(centre.x - card.width / 2, centre.y - card.height / 2)
        val cardCorner = CornerRadius(card.height * 0.08f)
        val shows = state.card.opacity.toFloat().coerceIn(0f, 1f)
        val body = CornerRadius(phone.width * 0.14f)
        val line = 2.dp.toPx()

        // The card, behind the phone.
        if (shows > 0f) drawRoundRect(Colours.you, cardAt, card, cardCorner, alpha = shows)
        // The phone, its front to the cardholder: its screen, and the camera's dot at the top.
        drawRoundRect(Colours.bg, at, phone, body)
        drawRoundRect(Colours.ink, at, phone, body, style = Stroke(line))
        val edge = phone.width * 0.045f
        drawRoundRect(Colours.soft, at + Offset(edge, edge), Size(phone.width - 2 * edge, phone.height - 2 * edge), CornerRadius(phone.width * 0.1f))
        drawCircle(Colours.ink, phone.width * 0.035f, Offset(at.x + phone.width / 2, at.y + phone.width * 0.13f))
        // What the phone hides of the card: its outline, dashed, only over the phone.
        if (shows > 0f) {
            clipPath(Path().apply { addRoundRect(RoundRect(at.x, at.y, at.x + phone.width, at.y + phone.height, body)) }) {
                drawRoundRect(Colours.you, cardAt, card, cardCorner, alpha = shows, style = Stroke(line, pathEffect = PathEffect.dashPathEffect(floatArrayOf(5.dp.toPx(), 4.dp.toPx()))))
            }
        }
        // The phone reads it: a ring about the card's centre. One that has gone out is drawn as none.
        val ring = state.ring
        if (ring != null && ring.opacity > 0) {
            drawCircle(Colours.you, phone.width * 0.25f * ring.scale.toFloat(), centre, alpha = ring.opacity.toFloat().coerceIn(0f, 1f), style = Stroke(3.dp.toPx()))
        }
    }
}
