import java.awt.Color;
import java.awt.Font;
import java.awt.Graphics2D;
import java.awt.RenderingHints;
import java.awt.font.FontRenderContext;
import java.awt.font.TextLayout;
import java.awt.geom.Rectangle2D;
import java.awt.image.BufferedImage;
import java.io.File;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.regex.Matcher;
import java.util.regex.Pattern;
import javax.imageio.ImageIO;

/**
 * The feature graphic of the app's page on Google Play (#489): 1024 by 500 pixels, the colour of a page's ground
 * (--bg of design/tokens.json) and the app's name in the typeface of the headings (design/fonts/), in ink (--ink). A first
 * version, until the icon is decided. Nothing but the JDK, which builds the app too:
 *
 *   java android/test/FeatureGraphic.java <path of the PNG to make>
 *
 * run from the repository's root.
 */
public class FeatureGraphic {
    static final int WIDTH = 1024;
    static final int HEIGHT = 500;
    /** The name's size, in pixels: four characters a little over half the width. */
    static final float SIZE = 140f;

    public static void main(String[] args) throws Exception {
        if (args.length != 1) throw new IllegalArgumentException("usage: java android/test/FeatureGraphic.java <path of the PNG to make>");
        String tokens = Files.readString(Path.of("design/tokens.json"));
        // The app's name, as the splash writes it (design/copy/app.json, splash.name).
        Matcher named = Pattern.compile("\"splash\":\\s*\\{[^}]*\"name\":\\s*\"([^\"]+)\"").matcher(Files.readString(Path.of("design/copy/app.json")));
        if (!named.find()) throw new IllegalStateException("design/copy/app.json has no splash.name");
        String name = named.group(1);
        Font font = Font.createFont(Font.TRUETYPE_FONT, new File("design/fonts/GenRyuMin2TW-B.otf")).deriveFont(SIZE);
        if (font.canDisplayUpTo(name) != -1) throw new IllegalStateException("design/fonts/GenRyuMin2TW-B.otf has no glyph for the name");

        BufferedImage image = new BufferedImage(WIDTH, HEIGHT, BufferedImage.TYPE_INT_RGB);
        Graphics2D g = image.createGraphics();
        g.setRenderingHint(RenderingHints.KEY_ANTIALIASING, RenderingHints.VALUE_ANTIALIAS_ON);
        g.setRenderingHint(RenderingHints.KEY_TEXT_ANTIALIASING, RenderingHints.VALUE_TEXT_ANTIALIAS_ON);
        g.setRenderingHint(RenderingHints.KEY_FRACTIONALMETRICS, RenderingHints.VALUE_FRACTIONALMETRICS_ON);
        g.setColor(color(tokens, "--bg"));
        g.fillRect(0, 0, WIDTH, HEIGHT);
        // In the middle by the ink of the characters, not by the font's ascent and descent.
        FontRenderContext context = g.getFontRenderContext();
        TextLayout layout = new TextLayout(name, font, context);
        Rectangle2D ink = layout.getBounds();
        float x = (float) ((WIDTH - ink.getWidth()) / 2 - ink.getX());
        float y = (float) ((HEIGHT - ink.getHeight()) / 2 - ink.getY());
        g.setColor(color(tokens, "--ink"));
        layout.draw(g, x, y);
        g.dispose();
        if (!ImageIO.write(image, "png", new File(args[0]))) throw new IllegalStateException("no PNG writer");
    }

    /** A colour of design/tokens.json, which writes each as #RRGGBB. */
    static Color color(String tokens, String name) {
        Matcher m = Pattern.compile("\"" + Pattern.quote(name) + "\":\\s*\"#([0-9A-Fa-f]{6})\"").matcher(tokens);
        if (!m.find()) throw new IllegalStateException("design/tokens.json has no colour " + name);
        return new Color(Integer.parseInt(m.group(1), 16));
    }
}
