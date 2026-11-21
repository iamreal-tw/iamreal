package tw.iamreal.app.ui

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
import androidx.compose.foundation.isSystemInDarkTheme
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.defaultMinSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.BasicText
import androidx.compose.foundation.text.BasicTextField
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.runtime.staticCompositionLocalOf
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.alpha
import androidx.compose.ui.draw.clip
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.graphics.StrokeCap
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.text.TextRange
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.input.KeyboardCapitalization
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.input.TextFieldValue
import androidx.compose.ui.text.style.TextDecoration
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp

// What the screens are drawn with. A first version: the colours, sizes and
// spacing are not decided yet (design/README.md, tokens.json), so there are
// two colours, ink on paper, and the system's own type.

internal class Colours(val ink: Color, val paper: Color, val faint: Color)

internal val LocalColours = staticCompositionLocalOf { Colours(Color(0xFF1A1A1A), Color(0xFFFAF8F3), Color(0xFF6B6B6B)) }

@Composable
internal fun WithColours(content: @Composable () -> Unit) {
    val colours = if (isSystemInDarkTheme()) Colours(Color(0xFFF2EFE8), Color(0xFF161616), Color(0xFFA8A8A8)) else Colours(Color(0xFF1A1A1A), Color(0xFFFAF8F3), Color(0xFF6B6B6B))
    CompositionLocalProvider(LocalColours provides colours, content = content)
}

@Composable
internal fun Title(text: String) = BasicText(text, style = TextStyle(color = LocalColours.current.ink, fontSize = 26.sp, lineHeight = 34.sp, fontWeight = FontWeight.Bold))

@Composable
internal fun Heading(text: String) = BasicText(text, style = TextStyle(color = LocalColours.current.ink, fontSize = 19.sp, lineHeight = 27.sp, fontWeight = FontWeight.Bold))

/** A sentence as plain to see as any other on the screen. */
@Composable
internal fun Lead(text: String, modifier: Modifier = Modifier) = BasicText(text, modifier, style = TextStyle(color = LocalColours.current.ink, fontSize = 17.sp, lineHeight = 27.sp))

@Composable
internal fun Body(text: String, modifier: Modifier = Modifier) = BasicText(text, modifier, style = TextStyle(color = LocalColours.current.ink, fontSize = 15.sp, lineHeight = 24.sp))

@Composable
internal fun Small(text: String, modifier: Modifier = Modifier) = BasicText(text, modifier, style = TextStyle(color = LocalColours.current.faint, fontSize = 13.sp, lineHeight = 20.sp))

/** A sentence that says something went wrong: where it stopped and why. */
@Composable
internal fun Problem(text: String, modifier: Modifier = Modifier) =
    BasicText(text, modifier.fillMaxWidth().border(1.dp, LocalColours.current.ink, RoundedCornerShape(6.dp)).padding(12.dp), style = TextStyle(color = LocalColours.current.ink, fontSize = 15.sp, lineHeight = 24.sp))

@Composable
internal fun Button(label: String, modifier: Modifier = Modifier, primary: Boolean = false, enabled: Boolean = true, onClick: () -> Unit) {
    val c = LocalColours.current
    Box(
        modifier
            .alpha(if (enabled) 1f else 0.4f)
            .clip(RoundedCornerShape(8.dp))
            .background(if (primary) c.ink else Color.Transparent)
            .border(1.dp, c.ink, RoundedCornerShape(8.dp))
            .clickable(enabled = enabled, role = Role.Button, onClick = onClick)
            .defaultMinSize(minWidth = 96.dp, minHeight = 48.dp)
            .padding(horizontal = 18.dp, vertical = 12.dp),
        contentAlignment = Alignment.Center,
    ) {
        BasicText(label, style = TextStyle(color = if (primary) c.paper else c.ink, fontSize = 16.sp, fontWeight = FontWeight.Medium))
    }
}

/** A line of text that is pressed: a link, or "取消". */
@Composable
internal fun TextButton(label: String, modifier: Modifier = Modifier, onClick: () -> Unit) = BasicText(
    label,
    modifier.clickable(role = Role.Button, onClick = onClick).defaultMinSize(minHeight = 40.dp).padding(vertical = 8.dp),
    style = TextStyle(color = LocalColours.current.ink, fontSize = 15.sp, textDecoration = TextDecoration.Underline),
)

/** The buttons of a step, side by side. */
@Composable
internal fun Actions(content: @Composable () -> Unit) = Row(Modifier.fillMaxWidth().padding(top = 8.dp), horizontalArrangement = Arrangement.spacedBy(12.dp), verticalAlignment = Alignment.CenterVertically) { content() }

/** A question that opens to its answer. */
@Composable
internal fun Question(question: String, vararg answers: String) {
    var open by remember { mutableStateOf(false) }
    Column {
        BasicText(
            (if (open) "▾ " else "▸ ") + question,
            Modifier.fillMaxWidth().clickable(role = Role.Button) { open = !open }.defaultMinSize(minHeight = 40.dp).padding(vertical = 8.dp),
            style = TextStyle(color = LocalColours.current.ink, fontSize = 15.sp, lineHeight = 24.sp),
        )
        if (open) for (a in answers) Body(a, Modifier.padding(start = 18.dp, bottom = 6.dp))
    }
}

/** The mark before an item of a list: nothing yet, turning, a check in ink; none for an item that stopped. */
@Composable
internal fun Mark(state: ItemState) {
    val ink = LocalColours.current.ink
    val turn = if (state == ItemState.NOW) {
        val transition = rememberInfiniteTransition(label = "turning")
        transition.animateFloat(0f, 360f, infiniteRepeatable(tween(1000, easing = LinearEasing), RepeatMode.Restart), label = "angle").value
    } else {
        0f
    }
    Canvas(Modifier.padding(top = 4.dp).size(16.dp)) {
        val stroke = Stroke(1.5.dp.toPx(), cap = StrokeCap.Round)
        when (state) {
            ItemState.NONE -> drawCircle(ink, radius = size.minDimension / 2 - stroke.width, style = stroke, alpha = 0.4f)
            ItemState.NOW -> drawArc(ink, turn, 270f, false, Offset(stroke.width, stroke.width), Size(size.width - 2 * stroke.width, size.height - 2 * stroke.width), style = stroke)
            ItemState.DONE -> {
                drawLine(ink, Offset(size.width * 0.15f, size.height * 0.55f), Offset(size.width * 0.4f, size.height * 0.8f), stroke.width, StrokeCap.Round)
                drawLine(ink, Offset(size.width * 0.4f, size.height * 0.8f), Offset(size.width * 0.88f, size.height * 0.22f), stroke.width, StrokeCap.Round)
            }
            ItemState.HALT -> {}
        }
    }
}

/** A list of what the app is doing: each item, its state after it, and under the one that stopped, why. */
@Composable
internal fun TaskList(copy: Copy, labels: List<String>, states: List<ItemState>, message: String?, tag: String) = Column(Modifier.testTag(tag), verticalArrangement = Arrangement.spacedBy(10.dp)) {
    for ((i, label) in labels.withIndex()) {
        Row(horizontalArrangement = Arrangement.spacedBy(10.dp)) {
            Mark(states[i])
            Column(verticalArrangement = Arrangement.spacedBy(6.dp)) {
                Body(label)
                when (states[i]) {
                    ItemState.NOW -> Small(copy.say("common.working"))
                    ItemState.DONE -> Small(copy.say("common.done"))
                    ItemState.HALT -> {
                        Small(copy.say("common.halted"))
                        if (message != null) Problem(message)
                    }
                    ItemState.NONE -> {}
                }
            }
        }
    }
}

@Composable
private fun fieldStyle() = TextStyle(color = LocalColours.current.ink, fontSize = 17.sp)

/** A field for an account name. */
@Composable
internal fun AccountField(value: String, enabled: Boolean, tag: String, modifier: Modifier = Modifier, onChange: (String) -> Unit) {
    val c = LocalColours.current
    BasicTextField(
        value,
        { typed -> onChange(typed.filter { it != '\n' }) },
        modifier.alpha(if (enabled) 1f else 0.5f).border(1.dp, c.ink, RoundedCornerShape(6.dp)).padding(horizontal = 12.dp, vertical = 12.dp).testTag(tag),
        enabled = enabled,
        singleLine = true,
        textStyle = fieldStyle(),
        cursorBrush = SolidColor(c.ink),
        keyboardOptions = KeyboardOptions(capitalization = KeyboardCapitalization.None, autoCorrectEnabled = false, keyboardType = KeyboardType.Ascii, imeAction = ImeAction.Done),
    )
}

/**
 * The PIN's field. What it holds is a row of dots: each character typed
 * goes into [pin], which the app overwrites, and never into the field's
 * text. Typing adds at the end and deleting takes from the end.
 */
@Composable
internal fun PinInput(pin: PinField, enabled: Boolean, tag: String, modifier: Modifier = Modifier) {
    val c = LocalColours.current
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
        modifier.alpha(if (enabled) 1f else 0.5f).border(1.dp, c.ink, RoundedCornerShape(6.dp)).padding(horizontal = 12.dp, vertical = 12.dp).testTag(tag),
        enabled = enabled,
        singleLine = true,
        textStyle = fieldStyle(),
        cursorBrush = SolidColor(c.ink),
        keyboardOptions = KeyboardOptions(capitalization = KeyboardCapitalization.None, autoCorrectEnabled = false, keyboardType = KeyboardType.Password, imeAction = ImeAction.Done),
    )
}

private const val DOT = '•'
