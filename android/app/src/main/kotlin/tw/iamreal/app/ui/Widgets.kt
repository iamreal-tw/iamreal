package tw.iamreal.app.ui

import androidx.compose.animation.core.Animatable
import androidx.compose.animation.core.CubicBezierEasing
import androidx.compose.animation.core.FastOutSlowInEasing
import androidx.compose.animation.core.LinearEasing
import androidx.compose.animation.core.RepeatMode
import androidx.compose.animation.core.animateFloat
import androidx.compose.animation.core.infiniteRepeatable
import androidx.compose.animation.core.rememberInfiniteTransition
import androidx.compose.animation.core.tween
import androidx.compose.foundation.Canvas
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.gestures.detectTapGestures
import androidx.compose.foundation.interaction.MutableInteractionSource
import androidx.compose.foundation.interaction.collectIsPressedAsState
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ColumnScope
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.RowScope
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.defaultMinSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.BasicText
import androidx.compose.foundation.text.BasicTextField
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberUpdatedState
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.alpha
import androidx.compose.ui.draw.clip
import androidx.compose.ui.geometry.CornerRadius
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.Path
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.graphics.StrokeCap
import androidx.compose.ui.graphics.StrokeJoin
import androidx.compose.ui.graphics.drawscope.DrawScope
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.graphics.drawscope.rotate
import androidx.compose.ui.graphics.drawscope.scale
import androidx.compose.ui.graphics.drawscope.translate
import androidx.compose.ui.graphics.drawscope.withTransform
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.layout.Layout
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.SpanStyle
import androidx.compose.ui.text.TextRange
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.buildAnnotatedString
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.input.KeyboardCapitalization
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.input.TextFieldValue
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextDecoration
import androidx.compose.ui.text.withStyle
import androidx.compose.ui.unit.Constraints
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.TextUnit
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.em
import androidx.compose.ui.unit.sp
import tw.iamreal.app.ui.demo.DemoPlayer

// What the screens are drawn with, after design/DESIGN.md and
// design/screens/card-proof-app-*: the values are Theme.kt's, which are
// design/tokens.json's. Headings in GenRyuMin2 TW, the body in the system's
// sans-serif. Nothing here means a conclusion: no green, no lock or shield;
// a check mark only in the two lists of what the app is doing (steps 2 and
// 5), in ink (docs/design/principles.md).

private fun style(size: TextUnit, leading: TextUnit, colour: Color = Colours.text, weight: FontWeight = Type.weightBody, display: Boolean = false, mono: Boolean = false) = TextStyle(
    color = colour,
    fontSize = size,
    lineHeight = leading,
    fontWeight = weight,
    fontFamily = if (display) Type.display else if (mono) Type.mono else null,
)

/** The heading of a step: the largest words on the screen. */
@Composable
internal fun Title(text: String, modifier: Modifier = Modifier) = BasicText(text, modifier, style = style(Type.sizeH2, Type.leadingH2, Colours.ink, Type.weightHeading, display = true))

/** A heading in the type of the headings, smaller: a stress, the title next to the small card. */
@Composable
internal fun Stress(text: String, modifier: Modifier = Modifier) = BasicText(text, modifier, style = style(Type.sizeLead, Type.leadingH3, Colours.ink, Type.weightHeading, display = true))

/** The heading of a part of a step, in the body's type. */
@Composable
internal fun Subhead(text: String, modifier: Modifier = Modifier) = BasicText(text, modifier, style = style(Type.sizeBody, Type.leadingH3, Colours.ink, Type.weightHeading))

/** A sentence of the body. `strong`: in ink and bold, as plain to see as the title's first lines. */
@Composable
internal fun Body(text: String, modifier: Modifier = Modifier, strong: Boolean = false) =
    BasicText(text, modifier, style = if (strong) style(Type.sizeBody, Type.leadingBody, Colours.ink, Type.weightHeading) else style(Type.sizeBody, Type.leadingBody))

/** Small print: a note, what is under a row. */
@Composable
internal fun Small(text: String, modifier: Modifier = Modifier, colour: Color = Colours.mute) = BasicText(text, modifier, style = style(Type.sizeSmall, Type.leadingSmall, colour))

/** A sentence that says something went wrong: where it stopped and why. */
@Composable
internal fun Problem(text: String, modifier: Modifier = Modifier) = BasicText(
    text,
    modifier.fillMaxWidth().background(Colours.soft, RoundedCornerShape(6.dp)).padding(horizontal = 14.dp, vertical = 10.dp),
    style = style(Type.sizeBody, Type.leadingSmall, Colours.ink),
)

/** A line across, between the parts of a screen. */
@Composable
internal fun Rule(modifier: Modifier = Modifier, colour: Color = Colours.line, thickness: Dp = 1.dp) = Box(modifier.fillMaxWidth().height(thickness).background(colour))

/**
 * A button as wide as the screen: the step's one primary button is filled
 * with the red of what you do, the others are framed in ink.
 */
@Composable
internal fun Button(label: String, modifier: Modifier = Modifier, primary: Boolean = false, enabled: Boolean = true, height: Dp = Type.buttonHeight, told: String? = null, onClick: () -> Unit) {
    val press = remember { MutableInteractionSource() }
    val pressed by press.collectIsPressedAsState()
    val shape = RoundedCornerShape(Type.radius)
    Box(
        modifier
            .alpha(if (enabled) 1f else 0.4f)
            .clip(shape)
            .background(if (!primary) Colours.bg else if (pressed) Colours.youPressed else Colours.you)
            .then(if (primary) Modifier else Modifier.border(1.5.dp, Colours.ink, shape))
            .clickable(interactionSource = press, indication = null, enabled = enabled, role = Role.Button, onClick = onClick)
            .heightIn(min = height)
            .padding(horizontal = 16.dp),
        contentAlignment = Alignment.Center,
    ) {
        // `told`: what a screen reader reads in place of a label too short to say what the button does.
        BasicText(
            label,
            if (told != null) Modifier.semantics { contentDescription = told } else Modifier,
            style = TextStyle(color = if (primary) Colours.bg else Colours.ink, fontSize = Type.sizeBody, fontWeight = Type.weightHeading, textAlign = TextAlign.Center),
        )
    }
}

/**
 * A square button as tall as a button, drawn as Android's share symbol (three dots joined by two lines): step 8's share sheet.
 * `description`: what a screen reader reads, as the button has no words.
 */
@Composable
internal fun ShareSymbol(description: String, modifier: Modifier = Modifier, onClick: () -> Unit) {
    val shape = RoundedCornerShape(Type.radius)
    Box(
        modifier
            .size(Type.buttonHeight)
            .clip(shape)
            .background(Colours.bg)
            .border(1.5.dp, Colours.ink, shape)
            .clickable(role = Role.Button, onClick = onClick)
            .semantics { contentDescription = description },
        contentAlignment = Alignment.Center,
    ) {
        Canvas(Modifier.size(22.dp)) {
            val r = size.width * 0.14f
            val top = Offset(size.width - r, r)
            val middle = Offset(r, size.height / 2)
            val bottom = Offset(size.width - r, size.height - r)
            drawLine(Colours.ink, middle, top, strokeWidth = 2.dp.toPx())
            drawLine(Colours.ink, middle, bottom, strokeWidth = 2.dp.toPx())
            for (dot in listOf(top, middle, bottom)) drawCircle(Colours.ink, r, dot)
        }
    }
}

/** A line of text that is pressed: "取消". `action`: one of a step's other things to do ("改成別的帳號"), in ink and the body's size. */
@Composable
internal fun TextButton(label: String, modifier: Modifier = Modifier, action: Boolean = false, onClick: () -> Unit) = BasicText(
    label,
    modifier.clickable(role = Role.Button, onClick = onClick).defaultMinSize(minHeight = Type.minTarget).padding(vertical = 10.dp),
    style = TextStyle(color = if (action) Colours.ink else Colours.mute, fontSize = if (action) Type.sizeBody else 15.sp, textDecoration = TextDecoration.Underline),
)

/** A link inside the body: the red of what you do, underlined, bold. Opens a page outside the app. */
@Composable
internal fun Link(text: String, modifier: Modifier = Modifier, size: TextUnit = 17.sp, onClick: () -> Unit) = BasicText(
    text,
    modifier.clickable(role = Role.Button, onClick = onClick).defaultMinSize(minHeight = Type.minTarget).padding(vertical = 8.dp),
    style = TextStyle(color = Colours.you, fontSize = size, lineHeight = Type.leadingSmall, fontWeight = Type.weightHeading, textDecoration = TextDecoration.Underline),
)

/**
 * Two buttons side by side, each half the width, where both of their words fit on one line so; one under the other, each as
 * wide as the screen, where one's would not (a long account, the system's font made large), and where there are more than
 * two. One button alone is as wide as the screen. `firstOnRight`: side by side, the first is on the right (a step's way on,
 * [Actions]); otherwise on the left (step 6's 複製證明連結, as the first screen of its demonstration draws it).
 */
@Composable
internal fun SideBySide(modifier: Modifier = Modifier, firstOnRight: Boolean = false, content: @Composable () -> Unit) = Layout(content, modifier) { measurables, constraints ->
    val gap = 12.dp.roundToPx()
    val width = constraints.maxWidth
    val half = (width - gap) / 2
    val tall = Type.buttonHeight.roundToPx()
    // Its words on one line: as wide as a button needs to be when nothing makes it wrap.
    val beside = measurables.size == 2 && measurables.all { it.maxIntrinsicWidth(tall) <= half }
    val placed = measurables.map { it.measure(Constraints.fixedWidth(if (beside) half else width)) }
    if (beside) {
        val (left, right) = if (firstOnRight) placed[1] to placed[0] else placed[0] to placed[1]
        layout(width, placed.maxOf { it.height }) {
            left.place(0, 0)
            right.place(half + gap, 0)
        }
    } else {
        layout(width, placed.sumOf { it.height } + gap * (placed.size - 1).coerceAtLeast(0)) {
            var y = 0
            for (p in placed) {
                p.place(0, y)
                y += p.height + gap
            }
        }
    }
}

/**
 * A demonstration and its one control (design/copy/card-proof.md, "示範"): small words in the picture's bottom right corner,
 * "停止播放" while it plays and "再看一次" otherwise, and pressing the picture does the same. Small, so that the step's own button
 * is the one that stands out. A screen reader presses the words: the picture reads as its one sentence and nothing else.
 */
@Composable
internal fun DemoFrame(player: DemoPlayer, copy: Copy, tag: String, enabled: Boolean = true, picture: @Composable (Modifier) -> Unit) =
    Box(Modifier.fillMaxWidth()) {
        val toggle = { if (player.playing) player.stop() else player.play() }
        val onTap by rememberUpdatedState(toggle)
        picture(Modifier.pointerInput(enabled) { if (enabled) detectTapGestures { onTap() } })
        Box(
            Modifier
                .align(Alignment.BottomEnd)
                .padding(8.dp)
                .alpha(if (enabled) 1f else 0.4f)
                .clickable(enabled = enabled, role = Role.Button, onClick = toggle)
                .defaultMinSize(minHeight = Type.minTarget)
                .padding(horizontal = 12.dp)
                .testTag(tag),
            contentAlignment = Alignment.Center,
        ) {
            BasicText(
                if (player.playing) copy.say("app_demo.stop") else copy.say("app_demo.replay"),
                style = TextStyle(color = Colours.ink, fontSize = 15.sp, textDecoration = TextDecoration.Underline),
            )
        }
    }

/**
 * The buttons of a step (design/DESIGN.md, "元件", 按鈕), written the way on first: side by side, it is on the right and the
 * other (上一步, or what is not the step's way on) on the left; one under the other, it is on top ([SideBySide]).
 */
@Composable
internal fun Actions(content: @Composable () -> Unit) = SideBySide(Modifier.fillMaxWidth().padding(top = 20.dp), firstOnRight = true, content = content)

/** One of the points under a screen's main part: a dot in ink before it. `strong`: the words of it in bold ink (not red: design/DESIGN.md keeps red for what you do). */
@Composable
internal fun Point(text: String, strong: String? = null) = Row(horizontalArrangement = Arrangement.spacedBy(10.dp)) {
    Box(Modifier.width(18.dp).padding(top = 11.dp)) { Box(Modifier.size(6.dp).background(Colours.ink, RoundedCornerShape(3.dp))) }
    val at = if (strong.isNullOrEmpty()) -1 else text.indexOf(strong)
    val words = buildAnnotatedString {
        if (at < 0) {
            append(text)
        } else {
            append(text.substring(0, at))
            withStyle(SpanStyle(color = Colours.ink, fontWeight = Type.weightHeading)) { append(strong!!) }
            append(text.substring(at + strong!!.length))
        }
    }
    BasicText(words, Modifier.weight(1f), style = style(Type.sizeBody, 1.75.em))
}

/** The questions that open to their answers, between lines. */
@Composable
internal fun Questions(content: @Composable () -> Unit) = Column(Modifier.fillMaxWidth().padding(top = 8.dp)) {
    Rule()
    content()
}

/** A question that opens to its answer (design/DESIGN.md, "元件", 常見問題): between lines, an arrow on the right. */
@Composable
internal fun Question(question: String, answer: @Composable ColumnScope.() -> Unit) {
    var open by remember { mutableStateOf(false) }
    Column {
        Row(
            Modifier.fillMaxWidth().clickable(role = Role.Button) { open = !open }.heightIn(min = 48.dp).padding(vertical = 10.dp),
            horizontalArrangement = Arrangement.spacedBy(10.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            BasicText(question, Modifier.weight(1f), style = style(Type.sizeBody, Type.leadingH3, Colours.ink, Type.weightHeading))
            Chevron(open)
        }
        if (open) answer()
        Rule()
    }
}

/** A sentence of a question's answer. */
@Composable
internal fun Answer(text: String) = BasicText(text, Modifier.padding(bottom = 12.dp), style = style(15.sp, 1.75.em))

/** The arrow of a question: down while it is closed, up while it is open. Not part of the question's text. */
@Composable
private fun Chevron(open: Boolean) = Canvas(Modifier.size(16.dp)) {
    val w = size.width
    val (from, to) = if (open) 0.65f to 0.35f else 0.35f to 0.65f
    val arrow = Path().apply {
        moveTo(0.15f * w, from * w)
        lineTo(0.5f * w, to * w)
        lineTo(0.85f * w, from * w)
    }
    drawPath(arrow, Colours.ink, style = Stroke(1.5.dp.toPx(), cap = StrokeCap.Round, join = StrokeJoin.Round))
}

/** The mark before an item of a list: an empty ring, turning, a check in ink; a thick ring for the item that stopped. */
@Composable
internal fun Mark(state: ItemState) {
    val turn = if (state == ItemState.NOW) {
        val transition = rememberInfiniteTransition(label = "turning")
        transition.animateFloat(0f, 360f, infiniteRepeatable(tween(1000, easing = LinearEasing), RepeatMode.Restart), label = "angle").value
    } else {
        0f
    }
    Canvas(Modifier.size(18.dp)) {
        fun ring(colour: Color, width: Float) = drawCircle(colour, radius = (size.minDimension - width) / 2, style = Stroke(width))
        when (state) {
            ItemState.NONE -> ring(Colours.dot, 1.5.dp.toPx())
            ItemState.NOW -> {
                val w = 2.dp.toPx()
                ring(Colours.line, w)
                drawArc(Colours.ink, turn - 90f, 90f, false, Offset(w / 2, w / 2), Size(size.width - w, size.height - w), style = Stroke(w))
            }
            ItemState.DONE -> {
                // The check of design/screens/card-proof-app-5-progress-phone.png: 3.5,9.5 → 7,13 → 14.5,5 of 18.
                val u = size.width / 18f
                val tick = Path().apply {
                    moveTo(3.5f * u, 9.5f * u)
                    lineTo(7f * u, 13f * u)
                    lineTo(14.5f * u, 5f * u)
                }
                drawPath(tick, Colours.ink, style = Stroke(2.2f * u, cap = StrokeCap.Round, join = StrokeJoin.Round))
            }
            ItemState.HALT -> ring(Colours.ink, 2.5.dp.toPx())
        }
    }
}

/** A list of what the app is doing: each item, its state after it, and under the one that stopped, why. */
@Composable
internal fun TaskList(copy: Copy, labels: List<String>, states: List<ItemState>, message: String?, tag: String) = Column(Modifier.fillMaxWidth().padding(top = 12.dp).testTag(tag)) {
    Rule()
    for ((i, label) in labels.withIndex()) {
        val state = states[i]
        Column(Modifier.fillMaxWidth().padding(vertical = 13.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
            Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(12.dp)) {
                Box(Modifier.width(26.dp)) { Mark(state) }
                BasicText(label, Modifier.weight(1f), style = style(Type.sizeBody, Type.leadingSmall, if (state == ItemState.NONE) Colours.mute else Colours.text))
                val status = when (state) {
                    ItemState.NOW -> copy.say("common.working")
                    ItemState.DONE -> copy.say("common.done")
                    ItemState.HALT -> copy.say("common.halted")
                    ItemState.NONE -> null
                }
                if (status != null) {
                    val strong = state == ItemState.NOW || state == ItemState.HALT
                    BasicText(status, style = style(Type.sizeSmall, Type.leadingSmall, if (strong) Colours.ink else Colours.mute, if (strong) Type.weightHeading else Type.weightBody))
                }
            }
            if (state == ItemState.HALT && message != null) Row {
                Spacer(Modifier.width(38.dp))
                Problem(message)
            }
        }
        Rule()
    }
}

@Composable
private fun Field(enabled: Boolean, modifier: Modifier = Modifier, content: @Composable RowScope.() -> Unit) = Row(
    modifier
        .alpha(if (enabled) 1f else 0.5f)
        .border(1.5.dp, Colours.ink, RoundedCornerShape(Type.radius))
        .heightIn(min = 52.dp)
        .padding(horizontal = 14.dp),
    verticalAlignment = Alignment.CenterVertically,
    content = content,
)

/** A field for an account name, with the platform's prefix (`@`) in it, before what is typed. */
@Composable
internal fun AccountField(value: String, prefix: String, enabled: Boolean, tag: String, modifier: Modifier = Modifier, onChange: (String) -> Unit) = Field(enabled, modifier) {
    BasicText(prefix, Modifier.padding(end = 2.dp), style = TextStyle(color = Colours.mute, fontSize = 18.sp))
    BasicTextField(
        value,
        { typed -> onChange(typed.filter { it != '\n' }) },
        Modifier.weight(1f).testTag(tag),
        enabled = enabled,
        singleLine = true,
        textStyle = TextStyle(color = Colours.ink, fontSize = 18.sp),
        cursorBrush = SolidColor(Colours.ink),
        keyboardOptions = KeyboardOptions(capitalization = KeyboardCapitalization.None, autoCorrectEnabled = false, keyboardType = KeyboardType.Ascii, imeAction = ImeAction.Done),
    )
}

/**
 * The PIN's field. What it holds is a row of dots: each character typed
 * goes into [pin], which the app overwrites, and never into the field's
 * text. Typing adds at the end and deleting takes from the end.
 */
@Composable
internal fun PinInput(pin: PinField, enabled: Boolean, tag: String, modifier: Modifier = Modifier) = Field(enabled, modifier.heightIn(min = Type.buttonHeight)) {
    val dots = DOT.toString().repeat(pin.length)
    BasicTextField(
        TextFieldValue(dots, TextRange(dots.length)),
        { typed ->
            if (typed.text.length < pin.length) {
                repeat(pin.length - typed.text.length) { pin.removeLast() }
            } else {
                // What is past the characters already taken: a second key can come before the first one's dot is drawn.
                for (i in pin.length until typed.text.length) if (typed.text[i] != DOT) pin.append(typed.text[i])
            }
        },
        Modifier.weight(1f).testTag(tag),
        enabled = enabled,
        singleLine = true,
        textStyle = TextStyle(color = Colours.ink, fontSize = 22.sp, fontFamily = Type.mono, letterSpacing = 0.3.em),
        cursorBrush = SolidColor(Colours.ink),
        keyboardOptions = KeyboardOptions(capitalization = KeyboardCapitalization.None, autoCorrectEnabled = false, keyboardType = KeyboardType.Password, imeAction = ImeAction.Done),
    )
}

private const val DOT = '•'

/** Where in the steps: "第 2 步，共 8 步", then a bar a step, the steps up to this one in ink. */
@Composable
internal fun StepBar(copy: Copy, step: Int) = Column(Modifier.fillMaxWidth(), verticalArrangement = Arrangement.spacedBy(10.dp)) {
    BasicText(copy.say("common.step", "step" to step, "steps" to Step.COUNT), style = style(Type.sizeKicker, Type.leadingKicker, Colours.mute))
    Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(6.dp)) {
        for (i in 1..Step.COUNT) Box(Modifier.weight(1f).height(4.dp).background(if (i <= step) Colours.ink else Colours.line))
    }
}

/** The app's header: the mark and the service's name (design/copy/card-proof.md, "每一步都有的"). */
@Composable
internal fun Header(name: String, action: String? = null, onAction: () -> Unit = {}) = Column(Modifier.fillMaxWidth()) {
    Row(Modifier.fillMaxWidth().height(56.dp).padding(horizontal = Type.gutter), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
        Logo(Modifier.size(24.dp))
        BasicText(name, Modifier.weight(1f), style = TextStyle(color = Colours.ink, fontSize = 17.sp, lineHeight = 1.em, fontWeight = Type.weightHeading, fontFamily = Type.display))
        // On the right, where there is one: "設定".
        if (action != null) {
            BasicText(
                action,
                Modifier.clickable(role = Role.Button, onClick = onAction).defaultMinSize(minHeight = Type.minTarget).padding(vertical = 14.dp).testTag("header-action"),
                style = TextStyle(color = Colours.ink, fontSize = 15.sp),
            )
        }
    }
    Rule()
}

/**
 * The mark: a card set at a slant, the island standing up from behind it
 * (web/src/ui/logo.ts, the same drawing in its 64 × 64 units). `animated`:
 * the card slides in and the island stands up, once, as on the web's step 6;
 * with the system's animations off it is drawn still.
 */
@Composable
internal fun Logo(modifier: Modifier = Modifier, animated: Boolean = false) {
    val card = remember { Animatable(if (animated) 0f else 1f) }
    val island = remember { Animatable(if (animated) 0f else 1f) }
    if (animated) {
        LaunchedEffect(Unit) { card.animateTo(1f, tween(500, easing = FastOutSlowInEasing)) }
        LaunchedEffect(Unit) { island.animateTo(1f, tween(700, delayMillis = 350, easing = CubicBezierEasing(0.2f, 1.5f, 0.4f, 1f))) }
    }
    Canvas(modifier) {
        scale(size.minDimension / 64f, pivot = Offset.Zero) {
            drawMark(card.value, island.value)
        }
    }
}

/** The mark in its 64 × 64 units, the card and the island each `t` of the way in (0 to 1). */
private fun DrawScope.drawMark(cardT: Float, islandT: Float) {
    // The card: from 14° turned and 10 lower, about (27, 54), faded in.
    withTransform({
        rotate((1 - cardT) * 14f, Offset(27f, 54f))
        translate(0f, (1 - cardT) * 10f)
    }) {
        rotate(-9f, Offset(27f, 39f)) {
            drawRoundRect(Colours.you, Offset(3f, 24f), Size(46f, 30f), CornerRadius(5.5f), alpha = cardT.coerceIn(0f, 1f))
            drawRoundRect(Colours.bg, Offset(9.5f, 31f), Size(10f, 8f), CornerRadius(2f), alpha = cardT.coerceIn(0f, 1f))
        }
    }
    // The island: from 26 lower and 0.7 of its size, about (44, 60); the outline in the colour of the ground first, as paint-order: stroke.
    withTransform({
        translate(0f, (1 - islandT) * 26f)
        scale(0.7f + 0.3f * islandT, 0.7f + 0.3f * islandT, Offset(44f, 60f))
        translate(31.5f, 3f)
        scale(0.97f, 0.97f, Offset.Zero)
    }) {
        val alpha = islandT.coerceIn(0f, 1f)
        drawPath(TAIWAN, Colours.bg, alpha = alpha, style = Stroke(2.6f, join = StrokeJoin.Round))
        drawPath(TAIWAN, Colours.ink, alpha = alpha)
    }
}

/**
 * The outline of the main island, as web/src/ui/logo.ts writes it: from
 * Natural Earth's public-domain map data (1:50m). The system's splash draws
 * the same (res/drawable/splash_mark.xml; ThemeTest compares them).
 */
internal const val TAIWAN_OUTLINE =
    "M14.84 45.97 L13.85 48.00 L13.07 50.14 L12.75 52.17 L12.77 54.25 L12.55 56.14 L12.16 58.00 L10.62 57.46 L9.79 56.13 L9.59 53.94 " +
        "L8.48 51.29 L8.06 50.54 L6.45 49.06 L4.99 48.32 L3.86 47.23 L4.01 47.32 L3.18 45.85 L2.54 44.28 L1.23 39.83 L0.78 38.76 L0.17 37.78 " +
        "L0.00 36.81 L0.21 35.73 L0.77 34.12 L1.12 32.49 L0.84 30.29 L0.95 28.10 L1.37 27.13 L8.83 13.81 L10.85 10.98 L12.10 9.59 L13.14 8.02 " +
        "L14.13 6.04 L15.34 4.22 L16.21 3.67 L20.49 2.04 L21.82 0.48 L22.89 0.00 L24.10 0.03 L24.89 0.77 L25.58 1.65 L26.31 2.12 L28.21 2.98 " +
        "L29.04 3.81 L29.42 5.25 L28.26 6.60 L27.69 7.83 L27.58 9.18 L27.79 11.01 L27.82 12.85 L26.37 17.16 L24.83 19.84 L24.41 21.18 " +
        "L23.94 24.50 L23.03 27.84 L22.26 32.06 L20.99 36.41 L20.28 38.23 L19.38 39.98 L17.25 43.27 Z"

/** [TAIWAN_OUTLINE] as a path: its points, joined by straight lines and closed. */
private val TAIWAN: Path = Path().apply {
    val points = TAIWAN_OUTLINE.removeSuffix(" Z").split(" ").map { it.trimStart('M', 'L').toFloat() }.chunked(2)
    moveTo(points[0][0], points[0][1])
    for (p in points.drop(1)) lineTo(p[0], p[1])
    close()
}
