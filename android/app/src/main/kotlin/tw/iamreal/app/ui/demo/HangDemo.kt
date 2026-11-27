package tw.iamreal.app.ui.demo

import androidx.compose.foundation.Canvas
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.BoxScope
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.aspectRatio
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.wrapContentSize
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.BasicText
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.derivedStateOf
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clipToBounds
import androidx.compose.ui.draw.drawWithContent
import androidx.compose.ui.geometry.CornerRadius
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Rect
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.StrokeCap
import androidx.compose.ui.graphics.TransformOrigin
import androidx.compose.ui.graphics.drawscope.DrawScope
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.layout.Layout
import androidx.compose.ui.layout.boundsInWindow
import androidx.compose.ui.layout.findRootCoordinates
import androidx.compose.ui.layout.onGloballyPositioned
import androidx.compose.ui.layout.onSizeChanged
import androidx.compose.ui.layout.positionInRoot
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.semantics.clearAndSetSemantics
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.testTag
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.Constraints
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.IntSize
import androidx.compose.ui.unit.dp
import tw.iamreal.app.ui.Colours
import tw.iamreal.app.ui.Copy
import tw.iamreal.app.ui.Type

// The demonstration of step 6 (design/copy/card-proof.md, "示範"; design/copy/hang.md, "五個示意畫面"): five
// screens in a row, the app's own and four of Threads drawn by hand, and a picture of 4:5 that looks at a part of
// the row. What the picture is at a moment is hangStateAt's to say (HangMotion.kt, design/motion/hang.json); this
// file draws that state and keeps the time, by the frames the system gives it (withFrameNanos). No library.
//
// The system's setting that turns animations off is not asked: the demonstration plays all the same, and the one
// button beside it stops it (issue #369, the maintainer's note of 2026-11-26).

/** The platform whose way back the app shows: on Threads for Android, the cross at the top left. */
private const val VARIANT = "android"

/** How much of the picture must be on the screen, or how much of the screen it must fill, before the demonstration starts by itself: as on the site's page. */
private const val MOST = 0.6f


/** What the demonstration shows of this card proof: its account, its link, and the words of the app's own step 6. */
internal class HangDemoWords(
    /** hang.title_single, or hang.title: the title of step 6. */
    val title: String,
    /** The account as the screens write it: `@alice`. */
    val account: String,
    /** The card's link without a scheme, as step 6 writes it. */
    val link: String,
    /** The same link as it is copied, with its scheme: what is pasted. */
    val url: String,
    /** "打開 Threads": the button of step 6 that opens the profile. */
    val openProfile: String,
)

/**
 * The demonstration's time and where its boxes are: one of it as long as step 6 is up. The time is the only thing
 * that changes while it plays; the state is worked out from it, once a frame.
 */
internal class HangDemoPlayer(val timeline: HangTimeline) : DemoPlayer(timeline.duration) {
    /** Most of the picture is on the screen. */
    private var inSight = false

    /** The picture at this moment. */
    val state: HangState by derivedStateOf { hangStateAt(timeline, VARIANT, seconds) }

    /** Which of the written steps is being shown: read where only a change of it matters. */
    val step: Int by derivedStateOf { state.step }

    /** The boxes the screens must report before the camera can be aimed: every box of the timeline but another platform's own. */
    private val needed: Set<String> = timeline.variants.let { all ->
        val own = all[VARIANT]?.values?.toSet() ?: emptySet()
        timeline.boxes - (all.values.flatMap { it.values }.toSet() - own)
    }
    private val reported = HashMap<String, Rect>()
    private var rowAt: Offset? = null

    /** Where each box is in the row, in pixels, once every one has reported: the row is then as it was laid out, not moved, nothing shifted. */
    var places by mutableStateOf<Map<String, Rect>?>(null)
        private set

    /** The size of the picture, in pixels. */
    var picture by mutableStateOf(IntSize.Zero)

    fun rowPlaced(at: Offset) {
        if (places != null) return
        rowAt = at
        settle()
    }

    fun boxPlaced(name: String, at: Offset, size: IntSize) {
        if (places != null) return
        reported[name] = Rect(at, Size(size.width.toFloat(), size.height.toFloat()))
        settle()
    }

    /** The row tells where it is after its boxes may have: the camera is aimed only when all of them have. */
    private fun settle() {
        val origin = rowAt ?: return
        if (!reported.keys.containsAll(needed)) return
        places = reported.mapValues { it.value.translate(-origin.x, -origin.y) }
        startOnce()
    }

    /** Whether most of the picture is on the screen now: the first time it is, the demonstration plays. */
    fun sight(most: Boolean) {
        inSight = most
        startOnce()
    }

    /** By itself once, when the picture is in sight and the camera can be aimed. */
    private fun startOnce() {
        if (inSight && places != null) playOnce()
    }

    /** The density of the screen the boxes' places are for. On another, they are forgotten and asked again. */
    private var measured = 0f

    fun measuredAt(density: Float) {
        if (measured != 0f && measured != density) {
            reported.clear()
            rowAt = null
            places = null
        }
        measured = density
    }

    /** The row's scale and place for a framing (design/motion/README.md, "取景"), or null before the boxes are known. */
    fun pose(frame: String): Pose? {
        val at = places ?: return null
        val f = timeline.frames[frame] ?: return null
        // The unit of a framing's span: the width of a screen, which the framing the timeline starts at is aimed at.
        val screen = at[timeline.frames[timeline.start]?.x?.t] ?: return null
        val x = at[f.x.t] ?: return null
        val y = at[f.y.t] ?: return null
        val scale = picture.width / (f.span * screen.width / timeline.screen)
        return Pose(
            scale.toFloat(),
            (picture.width * f.x.v - scale * (x.left + x.width * f.x.a)).toFloat(),
            (picture.height * f.y.v - scale * (y.top + y.height * f.y.a)).toFloat(),
        )
    }
}

/** The row as the camera has it: its scale, and where its top left corner is in the picture. */
internal class Pose(val scale: Float, val x: Float, val y: Float)

/**
 * The picture of the demonstration; its control is the screen's (`ui.Demo`). To a screen reader the picture is one element
 * that reads [told]; what is drawn in it is not read.
 */
@Composable
internal fun HangDemo(player: HangDemoPlayer, copy: Copy, words: HangDemoWords, told: String, modifier: Modifier = Modifier) {
    val timeline = player.timeline
    // The row's lengths are pixels of this screen: on a screen of another density the boxes are asked again where they are.
    val density = LocalDensity.current.density
    LaunchedEffect(density) { player.measuredAt(density) }
    Frames(player)
    Box(
        modifier
            .fillMaxWidth()
            .aspectRatio(timeline.aspect)
            .background(Colours.soft, RoundedCornerShape(Type.radiusPanel))
            .clipToBounds()
            .onSizeChanged { player.picture = it }
            // Most of it on the screen, or it fills most of the screen: then it starts, once.
            .onGloballyPositioned { c ->
                val shown = c.boundsInWindow().height
                player.sight(c.size.height > 0 && (shown >= MOST * c.size.height || shown >= MOST * c.findRootCoordinates().size.height))
            }
            // One element to a screen reader, and to a test: nothing drawn in it is read.
            .clearAndSetSemantics {
                contentDescription = told
                testTag = "hang-demo"
            },
    ) {
        Row(
            Modifier
                .wrapContentSize(Alignment.TopStart, unbounded = true)
                .graphicsLayer {
                    // Until every box has told where it is, the row is where it was laid out and is not seen.
                    val state = player.state
                    val from = player.pose(state.camera.from)
                    val to = player.pose(state.camera.to)
                    transformOrigin = TransformOrigin(0f, 0f)
                    if (from == null || to == null) {
                        alpha = 0f
                    } else {
                        val p = state.camera.progress.toFloat()
                        val scale = from.scale + (to.scale - from.scale) * p
                        scaleX = scale
                        scaleY = scale
                        translationX = from.x + (to.x - from.x) * p
                        translationY = from.y + (to.y - from.y) * p
                    }
                }
                .onGloballyPositioned { player.rowPlaced(it.positionInRoot()) },
            horizontalArrangement = Arrangement.spacedBy(GAP),
        ) {
            val demo = Drawn(player, copy)
            demo.Own(words)
            demo.Profile(words)
            demo.EditProfile()
            demo.Links(words)
            demo.AddLink(words)
        }
    }
}

/** Between two screens of the row. */
private val GAP = 80.dp

/** A screen: as wide as the timeline's unit says a screen is when a dp is a unit. */
private val SHOT_WIDTH = 360.dp
private val SHOT_HEIGHT = 440.dp

/** Where the label of a mark goes: under the box in the middle, under it at its right edge, or beside it. */
private enum class TagAt { BELOW, BELOW_END, BESIDE }

/**
 * The five screens, drawn. Lengths are the row's own, in dp, and so are the sizes of the words (not the system's
 * font size: the camera scales the row, and an account of 30 characters stays on its line, cut at the end).
 */
private class Drawn(val player: HangDemoPlayer, val c: Copy) {
    private val ink = Colours.ink

    @Composable
    private fun style(size: Dp, colour: Color = ink, weight: FontWeight = Type.weightBody, family: FontFamily? = null, align: TextAlign = TextAlign.Start): TextStyle {
        val density = LocalDensity.current
        return TextStyle(color = colour, fontSize = with(density) { size.toSp() }, lineHeight = with(density) { (size * 1.4f).toSp() }, fontWeight = weight, fontFamily = family, textAlign = align)
    }

    /** Words on one line, cut at the end when they do not fit. */
    @Composable
    private fun Line(text: String, style: TextStyle, modifier: Modifier = Modifier) = BasicText(text, modifier, style = style, maxLines = 1, overflow = TextOverflow.Ellipsis)

    /** A grey bar where the real screen has words the demonstration does not need. */
    @Composable
    private fun Blank(modifier: Modifier) = Box(modifier.height(12.dp).background(Colours.line, RoundedCornerShape(6.dp)))

    /** How far a change of the screens has gone, read where it is drawn. Nothing has changed while the boxes are asked where they are: a part that moves is then where it was laid out. */
    private fun changed(change: String): Float = if (player.places == null) 0f else (player.state.states[change] ?: 0.0).toFloat()

    /** How much the mark of a box shows. */
    private fun marked(name: String): Float = (player.state.marks[name] ?: 0.0).toFloat().coerceIn(0f, 1f)

    /** The frame of a mark, around a box and a little outside it. */
    private fun DrawScope.frame(colour: Color, shows: Float) {
        val out = 6.dp.toPx()
        drawRoundRect(colour, Offset(-out, -out), Size(size.width + 2 * out, size.height + 2 * out), CornerRadius(12.dp.toPx()), Stroke(2.dp.toPx()), alpha = shows)
    }

    /**
     * A box the timeline names: where it is is told to the player; over it, the ink that darkens it while it is
     * pressed and the ring of the press; around it the frame of its mark, and the mark's label [tag].
     */
    @Composable
    fun Target(name: String, modifier: Modifier = Modifier, tag: String? = null, tagAt: TagAt = TagAt.BELOW, corner: Dp = 12.dp, content: @Composable BoxScope.() -> Unit) {
        Box(
            modifier
                .onGloballyPositioned { player.boxPlaced(name, it.positionInRoot(), it.size) }
                .drawWithContent {
                    drawContent()
                    val state = player.state
                    val tap = state.tap?.takeIf { it.target == name }
                    if (tap != null) drawRoundRect(ink, alpha = (tap.pressed * player.timeline.tap.press).toFloat().coerceIn(0f, 1f), cornerRadius = CornerRadius(corner.toPx()))
                    val mark = marked(name)
                    if (mark > 0f) frame(Colours.you, mark)
                    // A ring that has gone out is drawn as none: at the last moment of a press it may be either.
                    if (tap != null && tap.ring.opacity > 0) {
                        drawCircle(Colours.you, (RING / 2).toPx() * tap.ring.scale.toFloat(), center, alpha = tap.ring.opacity.toFloat().coerceIn(0f, 1f), style = Stroke(3.dp.toPx()))
                    }
                },
        ) {
            content()
            if (tag != null) Tag(tag, Colours.you, tagAt) { marked(name) }
        }
    }

    /** The label of a mark, outside the box it belongs to: it takes no room there. */
    @Composable
    private fun BoxScope.Tag(text: String, colour: Color, at: TagAt, shows: () -> Float) {
        Layout(
            content = {
                BasicText(text, Modifier.background(colour, RoundedCornerShape(6.dp)).padding(horizontal = 9.dp, vertical = 6.dp), style = style(12.dp, Colours.bg), maxLines = 1, softWrap = false)
            },
            modifier = Modifier.matchParentSize().graphicsLayer { alpha = shows().coerceIn(0f, 1f) },
        ) { measurables, constraints ->
            val label = measurables[0].measure(Constraints())
            val w = constraints.maxWidth
            val h = constraints.maxHeight
            layout(w, h) {
                when (at) {
                    TagAt.BELOW -> label.place((w - label.width) / 2, h + 10.dp.roundToPx())
                    TagAt.BELOW_END -> label.place(w + 6.dp.roundToPx() - label.width, h + 10.dp.roundToPx())
                    TagAt.BESIDE -> label.place(w + 14.dp.roundToPx(), (h - label.height) / 2)
                }
            }
        }
    }

    /** A screen of the row: its small heading above it, and the screen, which the timeline names [name]. */
    @Composable
    private fun Shot(name: String, kick: String, content: @Composable () -> Unit) = Column {
        Line(kick, style(13.dp, Colours.mute), Modifier.padding(start = 4.dp, bottom = 10.dp))
        Target(name, Modifier.size(SHOT_WIDTH, SHOT_HEIGHT).background(Colours.bg, RoundedCornerShape(18.dp)).border(1.dp, Colours.line, RoundedCornerShape(18.dp)), corner = 18.dp) {
            Column(Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 22.dp)) { content() }
        }
    }

    /** The first screen: the app's own step 6, with its words. */
    @Composable
    fun Own(words: HangDemoWords) = Shot("s0", c.say("app_demo_hang.kick_own")) {
        BasicText(words.title, Modifier.padding(top = 20.dp, bottom = 18.dp), style = style(25.dp, weight = Type.weightHeading, family = Type.display), maxLines = 2, overflow = TextOverflow.Ellipsis)
        Line(words.link, style(14.dp, family = Type.mono), Modifier.fillMaxWidth().background(Colours.soft, RoundedCornerShape(8.dp)).padding(12.dp))
        Row(Modifier.fillMaxWidth().padding(top = 16.dp), horizontalArrangement = Arrangement.spacedBy(12.dp)) {
            val button = Modifier.weight(1f).height(52.dp)
            Target("copy", button.background(Colours.you, RoundedCornerShape(Type.radius)), corner = Type.radius) {
                // The button's words change where they are: one over the other.
                val label = style(14.dp, Colours.bg, Type.weightHeading, align = TextAlign.Center)
                Line(c.say("hang.copy"), label, Modifier.align(Alignment.Center).graphicsLayer { alpha = 1 - changed("copied") })
                Line(c.say("done.copied"), label, Modifier.align(Alignment.Center).graphicsLayer { alpha = changed("copied") })
            }
            Target("open", button.border(1.5.dp, ink, RoundedCornerShape(Type.radius)), corner = Type.radius) {
                Line(words.openProfile, style(14.dp, weight = Type.weightHeading, align = TextAlign.Center), Modifier.align(Alignment.Center).padding(horizontal = 8.dp))
            }
        }
        Column(Modifier.padding(top = 34.dp), verticalArrangement = Arrangement.spacedBy(14.dp)) {
            for (width in listOf(0.78f, 0.52f, 0.64f, 0.86f)) Blank(Modifier.fillMaxWidth(width))
        }
    }

    /** The profile on Threads: the button that edits it, and at the end the line of the link, which what is under it makes room for. */
    @Composable
    fun Profile(words: HangDemoWords) = Shot("s1", c.say("app_demo_hang.kick_profile")) {
        Row(Modifier.fillMaxWidth().padding(top = 18.dp), horizontalArrangement = Arrangement.spacedBy(16.dp)) {
            Column(Modifier.weight(1f)) {
                Box(Modifier.size(120.dp, 18.dp).background(Colours.line, RoundedCornerShape(6.dp)))
                Line(words.account, style(16.dp), Modifier.padding(top = 10.dp))
            }
            Box(Modifier.size(64.dp).background(Colours.line, CircleShape))
        }
        Column(Modifier.padding(top = 20.dp), verticalArrangement = Arrangement.spacedBy(9.dp)) {
            Blank(Modifier.fillMaxWidth(0.82f))
            Blank(Modifier.fillMaxWidth(0.6f))
        }
        Box(Modifier.fillMaxWidth()) {
            // The line a visitor looks for: framed in ink, not in the red of what to press.
            Target("linkrow", Modifier.padding(top = 16.dp).graphicsLayer { alpha = changed("linkOnProfile") }, corner = 6.dp) {
                Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    LinkIcon()
                    Line(words.link, style(15.dp, weight = Type.weightHeading))
                }
                Box(Modifier.matchParentSize().drawWithContent { frame(ink, changed("resultLabel")) })
                Tag(c.say("app_demo_hang.found"), ink, TagAt.BELOW) { changed("resultLabel") }
            }
            // What is under it makes room for the line, and then for the label under the line.
            Column(Modifier.fillMaxWidth().graphicsLayer { translationY = changed("linkOnProfile") * LINK_ROW.toPx() + changed("resultLabel") * FOUND_TAG.toPx() }) {
                Blank(Modifier.padding(top = 16.dp).fillMaxWidth(0.34f))
                Row(Modifier.fillMaxWidth().padding(top = 22.dp), horizontalArrangement = Arrangement.spacedBy(10.dp)) {
                    val button = Modifier.weight(1f).height(38.dp).border(1.dp, Colours.dot, RoundedCornerShape(10.dp))
                    Target("edit", button, tag = c.say("app_demo_hang.press"), corner = 10.dp) {
                        Line(c.say("app_demo_hang.edit"), style(14.dp, weight = Type.weightHeading), Modifier.align(Alignment.Center))
                    }
                    Box(button, contentAlignment = Alignment.Center) { Blank(Modifier.fillMaxWidth(0.56f)) }
                }
            }
        }
    }

    /** The mark of a link before its address on a profile: a small slanted ring. */
    @Composable
    private fun LinkIcon() = Canvas(Modifier.size(16.dp, 12.dp)) {
        val stroke = 1.5.dp.toPx()
        drawLine(Colours.mute, Offset(stroke, size.height - stroke), Offset(size.width - stroke, stroke), 6.dp.toPx(), StrokeCap.Round)
        drawLine(Colours.bg, Offset(stroke, size.height - stroke), Offset(size.width - stroke, stroke), 3.dp.toPx(), StrokeCap.Round)
    }

    /** The top of a screen of Threads: its title, and what is at its two ends. */
    @Composable
    private fun Top(content: @Composable () -> Unit) = Row(Modifier.fillMaxWidth().height(40.dp), horizontalArrangement = Arrangement.SpaceBetween, verticalAlignment = Alignment.CenterVertically) { content() }

    /** A row of a list, with a line under it. */
    @Composable
    private fun ListRow(label: String, modifier: Modifier = Modifier, end: @Composable () -> Unit = {}) = Row(
        modifier.fillMaxWidth().height(ROW).drawWithContent {
            drawContent()
            drawLine(Colours.line, Offset(0f, size.height), Offset(size.width, size.height), 1.dp.toPx())
        },
        horizontalArrangement = Arrangement.SpaceBetween,
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Line(label, style(15.dp))
        end()
    }

    /** Editing the profile: a list, of which the row of links is the one to press. */
    @Composable
    fun EditProfile() = Shot("s2", c.say("app_demo_hang.kick_edit")) {
        Top { Line(c.say("app_demo_hang.edit"), style(17.dp, weight = Type.weightHeading)) }
        val value = @Composable { Blank(Modifier.width(96.dp)) }
        Column(Modifier.padding(top = 10.dp)) {
            for (name in listOf("row_name", "row_username", "row_bio", "row_interests")) ListRow(c.say("app_demo_hang.$name"), end = value)
            Target("links", tag = c.say("app_demo_hang.press"), corner = 6.dp) {
                ListRow(c.say("app_demo_hang.row_links")) {
                    Canvas(Modifier.padding(end = 4.dp).size(8.dp)) {
                        val s = 1.5.dp.toPx()
                        drawLine(Colours.mute, Offset(size.width / 4, 0f), Offset(size.width * 3 / 4, size.height / 2), s, StrokeCap.Round)
                        drawLine(Colours.mute, Offset(size.width * 3 / 4, size.height / 2), Offset(size.width / 4, size.height), s, StrokeCap.Round)
                    }
                }
            }
            ListRow(c.say("app_demo_hang.row_featured"), end = value)
        }
    }

    /**
     * The links: the row that adds one, which moves down when the link is listed above it. On Android the way back
     * from here is the cross at the top left; what is at the top right is grey and cannot be pressed.
     */
    @Composable
    fun Links(words: HangDemoWords) = Shot("s3", c.say("app_demo_hang.kick_links")) {
        Top {
            Target("x3", Modifier.size(34.dp), tag = c.say("app_demo_hang.press"), tagAt = TagAt.BESIDE, corner = 8.dp) {
                Canvas(Modifier.align(Alignment.Center).size(14.dp)) {
                    val s = 2.dp.toPx()
                    drawLine(ink, Offset(0f, 0f), Offset(size.width, size.height), s, StrokeCap.Round)
                    drawLine(ink, Offset(size.width, 0f), Offset(0f, size.height), s, StrokeCap.Round)
                }
            }
            Line(c.say("app_demo_hang.row_links"), style(17.dp, weight = Type.weightHeading))
            Line(c.say("app_demo_hang.done"), style(16.dp, Colours.dot, Type.weightHeading), Modifier.padding(horizontal = 4.dp))
        }
        Box(Modifier.fillMaxWidth().padding(top = 10.dp).height(ROW * 2)) {
            Box(Modifier.graphicsLayer { alpha = changed("linkListed") }) { ListRow(words.link) }
            Target("add", Modifier.graphicsLayer { translationY = changed("linkListed") * ROW.toPx() }, tag = c.say("app_demo_hang.press"), corner = 6.dp) {
                ListRow(c.say("app_demo_hang.add"))
            }
        }
    }

    /** Adding a link: the field of the address, the paste bubble over it after a long press, and what is at the top right to end with. */
    @Composable
    fun AddLink(words: HangDemoWords) = Shot("s4", c.say("app_demo_hang.kick_add")) {
        Top {
            Line(c.say("app_demo_hang.add"), style(17.dp, weight = Type.weightHeading))
            Target("done4", Modifier.padding(horizontal = 4.dp, vertical = 6.dp), tag = c.say("app_demo_hang.press_then"), tagAt = TagAt.BELOW_END, corner = 8.dp) {
                Line(c.say("app_demo_hang.done"), style(16.dp, weight = Type.weightHeading))
            }
        }
        val label = style(12.dp, Colours.mute)
        val field = Modifier.fillMaxWidth().height(46.dp).border(1.dp, Colours.dot, RoundedCornerShape(10.dp))
        // Room above the field for the bubble that comes over it.
        Line(c.say("app_demo_hang.url"), label, Modifier.padding(top = 56.dp, bottom = 6.dp))
        Target("urlfield", field, tag = c.say("app_demo_hang.paste_here"), tagAt = TagAt.BELOW_END, corner = 10.dp) {
            Line(words.url, style(12.5.dp, family = Type.mono), Modifier.align(Alignment.CenterStart).padding(horizontal = 12.dp).graphicsLayer { alpha = changed("pasted") })
            // The bubble is a box of its own, which the timeline presses: its ring stays to the end where the bubble was.
            Layout(
                content = {
                    Target("paste", corner = 9.dp) {
                        Box(Modifier.graphicsLayer { alpha = changed("pasteMenu") * (1 - changed("pasted")) }.background(ink, RoundedCornerShape(9.dp)).padding(horizontal = 16.dp, vertical = 9.dp)) {
                            Line(c.say("app_demo_hang.paste"), style(14.dp, Colours.bg))
                        }
                    }
                },
                modifier = Modifier.matchParentSize(),
            ) { measurables, constraints ->
                val bubble = measurables[0].measure(Constraints())
                layout(constraints.maxWidth, constraints.maxHeight) { bubble.place(18.dp.roundToPx(), -bubble.height - 8.dp.roundToPx()) }
            }
        }
        Line(c.say("app_demo_hang.link_title"), label, Modifier.padding(top = 34.dp, bottom = 6.dp))
        Box(field)
    }

    private companion object {
        /** The ring of a press, as it is drawn at once its size. */
        val RING = 56.dp

        /** A row of a list. */
        val ROW = 54.dp

        /** How far what is under the profile's link moves down to make room for it. */
        val LINK_ROW = 38.dp

        /** And how much further for the label under that line. */
        val FOUND_TAG = 46.dp
    }
}
