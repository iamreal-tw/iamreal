import java.awt.BasicStroke;
import java.awt.Color;
import java.awt.Font;
import java.awt.Graphics2D;
import java.awt.RenderingHints;
import java.awt.Shape;
import java.awt.font.TextLayout;
import java.awt.geom.AffineTransform;
import java.awt.geom.Path2D;
import java.awt.geom.Rectangle2D;
import java.awt.geom.RoundRectangle2D;
import java.awt.image.BufferedImage;
import java.io.File;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.regex.Matcher;
import java.util.regex.Pattern;
import javax.imageio.ImageIO;

/**
 * The app's icon as images (#490): the mark on the page's white, where the Android app's launcher puts it
 * (android/app/src/main/res/drawable/launcher_mark.xml):
 *
 * - the iOS app's icon, 1024 by 1024 with no alpha (App Store Connect refuses an icon with one), written in place:
 *   ios/App/Assets.xcassets/AppIcon.appiconset/AppIcon.png
 * - the icon of the app's page on Google Play, 512 by 512, a 32-bit PNG, at most 1 MB: play-icon.png
 * - the feature graphic of that page, 1024 by 500, a 24-bit PNG: the mark and the app's name in the typeface of the
 *   headings (design/fonts/), in ink: feature-graphic.png
 *
 * The two store images go to the directory it is given; the maintainer puts them on the store's page by hand. Nothing but
 * the JDK, which builds the app too. Run it from the repository's root after the mark or the launcher's icon changes:
 *
 *   java android/test/AppIcon.java <directory for the store's images>
 *
 * The icon shows what the launcher shows of an adaptive icon: the 72 units in the middle of its 108 (iOS and Google
 * Play round the corners themselves). Colours are design/tokens.json's.
 */
public class AppIcon {
    static final Path LAUNCHER = Path.of("android/app/src/main/res/drawable/launcher_mark.xml");
    static final Path IOS_ICON = Path.of("ios/App/Assets.xcassets/AppIcon.appiconset/AppIcon.png");
    /** Of an adaptive icon's layer of 108 units, where the part the launcher shows starts, and how wide it is. */
    static final double SHOWN_FROM = 18, SHOWN = 72;

    public static void main(String[] args) throws Exception {
        if (args.length != 1) throw new IllegalArgumentException("usage: java android/test/AppIcon.java <directory for the store's images>");
        Path out = Path.of(args[0]);
        Files.createDirectories(out);
        String tokens = Files.readString(Path.of("design/tokens.json"));
        Mark mark = Mark.of(Files.readString(LAUNCHER), color(tokens, "--you"), color(tokens, "--bg"), color(tokens, "--ink"));

        write(icon(mark, 1024, BufferedImage.TYPE_INT_RGB), IOS_ICON.toFile());
        File play = out.resolve("play-icon.png").toFile();
        write(icon(mark, 512, BufferedImage.TYPE_INT_ARGB), play);
        if (play.length() > 1024 * 1024) throw new IllegalStateException("play-icon.png is over 1 MB");
        write(featureGraphic(mark), out.resolve("feature-graphic.png").toFile());
    }

    /** The icon, `size` pixels square: the launcher's layer, the part it shows. */
    static BufferedImage icon(Mark mark, int size, int type) {
        BufferedImage image = new BufferedImage(size, size, type);
        Graphics2D g = drawing(image, mark.bg);
        double px = size / SHOWN;
        g.scale(px, px);
        g.translate(-SHOWN_FROM, -SHOWN_FROM);
        g.transform(mark.placed);
        mark.draw(g);
        g.dispose();
        return image;
    }

    /** The feature graphic: the mark and the app's name side by side, together in the middle. */
    static BufferedImage featureGraphic(Mark mark) throws Exception {
        final int width = 1024, height = 500;
        final double markHeight = 190, gap = 52;
        final float nameSize = 136f;
        // The app's name, as the splash writes it (design/copy/app.json, splash.name).
        Matcher named = Pattern.compile("\"splash\":\\s*\\{[^}]*\"name\":\\s*\"([^\"]+)\"").matcher(Files.readString(Path.of("design/copy/app.json")));
        if (!named.find()) throw new IllegalStateException("design/copy/app.json has no splash.name");
        String name = named.group(1);
        Font font = Font.createFont(Font.TRUETYPE_FONT, new File("design/fonts/GenRyuMin2TW-B.otf")).deriveFont(nameSize);
        if (font.canDisplayUpTo(name) != -1) throw new IllegalStateException("design/fonts/GenRyuMin2TW-B.otf has no glyph for the name");

        BufferedImage image = new BufferedImage(width, height, BufferedImage.TYPE_INT_RGB);
        Graphics2D g = drawing(image, mark.bg);
        TextLayout layout = new TextLayout(name, font, g.getFontRenderContext());
        Rectangle2D text = layout.getBounds();
        Rectangle2D markBounds = mark.bounds;
        double unit = markHeight / markBounds.getHeight();
        double markWidth = markBounds.getWidth() * unit;
        double left = (width - (markWidth + gap + text.getWidth())) / 2;

        AffineTransform unmoved = g.getTransform();
        // Each in the middle of the height by what it draws, not by the font's ascent and descent.
        g.translate(left, (height - markHeight) / 2);
        g.scale(unit, unit);
        g.translate(-markBounds.getX(), -markBounds.getY());
        mark.draw(g);
        g.setTransform(unmoved);
        g.setColor(mark.ink);
        layout.draw(g, (float) (left + markWidth + gap - text.getX()), (float) ((height - text.getHeight()) / 2 - text.getY()));
        g.dispose();
        return image;
    }

    static Graphics2D drawing(BufferedImage image, Color bg) {
        Graphics2D g = image.createGraphics();
        g.setRenderingHint(RenderingHints.KEY_ANTIALIASING, RenderingHints.VALUE_ANTIALIAS_ON);
        g.setRenderingHint(RenderingHints.KEY_TEXT_ANTIALIASING, RenderingHints.VALUE_TEXT_ANTIALIAS_ON);
        g.setRenderingHint(RenderingHints.KEY_FRACTIONALMETRICS, RenderingHints.VALUE_FRACTIONALMETRICS_ON);
        g.setRenderingHint(RenderingHints.KEY_STROKE_CONTROL, RenderingHints.VALUE_STROKE_PURE);
        g.setRenderingHint(RenderingHints.KEY_RENDERING, RenderingHints.VALUE_RENDER_QUALITY);
        g.setColor(bg);
        g.fillRect(0, 0, image.getWidth(), image.getHeight());
        return g;
    }

    static void write(BufferedImage image, File file) throws Exception {
        if (!ImageIO.write(image, "png", file)) throw new IllegalStateException("no PNG writer");
        System.out.println(file + " " + image.getWidth() + "x" + image.getHeight());
    }

    /** A colour of design/tokens.json, which writes each as #RRGGBB. */
    static Color color(String tokens, String name) {
        Matcher m = Pattern.compile("\"" + Pattern.quote(name) + "\":\\s*\"#([0-9A-Fa-f]{6})\"").matcher(tokens);
        if (!m.find()) throw new IllegalStateException("design/tokens.json: " + name + " is not a colour");
        return new Color(Integer.parseInt(m.group(1), 16));
    }

    /**
     * The mark in its 64 by 64 units, as web/src/ui/logo.ts draws it (ios/App/Mark.swift and the Android app's
     * drawables draw the same): a card in the cardholder's red, turned -9° about (27, 39), with a chip in the page's
     * white; the island in ink, scaled 0.97 and moved (31.5, 3), over its outline in the page's white, 2.6 wide with
     * round joins. Only two things are read from launcher_mark.xml: the island's outline, and the scale and the move
     * of its group "mark" (where the launcher puts the mark). The card, the chip and the numbers above are written
     * here as logo.ts writes them; ThemeTest checks launcher_mark.xml draws the same mark as splash_mark.xml.
     */
    record Mark(Shape card, Shape chip, Shape outline, Shape island, Color you, Color bg, Color ink, AffineTransform placed, Rectangle2D bounds) {
        static Mark of(String launcher, Color you, Color bg, Color ink) {
            Matcher group = Pattern.compile("android:name=\"mark\"\\s+android:scaleX=\"([0-9.]+)\"\\s+android:scaleY=\"([0-9.]+)\"\\s+android:translateX=\"([0-9.]+)\"\\s+android:translateY=\"([0-9.]+)\"").matcher(launcher);
            if (!group.find()) throw new IllegalStateException(LAUNCHER + " has no group \"mark\" with a scale and a move");
            AffineTransform placed = new AffineTransform();
            placed.translate(Double.parseDouble(group.group(3)), Double.parseDouble(group.group(4)));
            placed.scale(Double.parseDouble(group.group(1)), Double.parseDouble(group.group(2)));

            Matcher island = Pattern.compile("android:pathData=\"(M[0-9. L]+Z)\"").matcher(launcher);
            if (!island.find()) throw new IllegalStateException(LAUNCHER + " has no island");
            Path2D path = new Path2D.Double();
            Matcher point = Pattern.compile("([ML])([0-9.]+) ([0-9.]+)").matcher(island.group(1));
            while (point.find()) {
                double x = Double.parseDouble(point.group(2)), y = Double.parseDouble(point.group(3));
                if (point.group(1).equals("M")) path.moveTo(x, y); else path.lineTo(x, y);
            }
            path.closePath();

            AffineTransform turned = AffineTransform.getRotateInstance(Math.toRadians(-9), 27, 39);
            AffineTransform islandAt = new AffineTransform();
            islandAt.translate(31.5, 3);
            islandAt.scale(0.97, 0.97);
            Shape card = turned.createTransformedShape(new RoundRectangle2D.Double(3, 24, 46, 30, 11, 11));
            Shape chip = turned.createTransformedShape(new RoundRectangle2D.Double(9.5, 31, 10, 8, 4, 4));
            Shape outline = islandAt.createTransformedShape(new BasicStroke(2.6f, BasicStroke.CAP_BUTT, BasicStroke.JOIN_ROUND).createStrokedShape(path));
            Shape land = islandAt.createTransformedShape(path);
            Rectangle2D bounds = card.getBounds2D().createUnion(land.getBounds2D());
            return new Mark(card, chip, outline, land, you, bg, ink, placed, bounds);
        }

        void draw(Graphics2D g) {
            g.setColor(you);
            g.fill(card);
            g.setColor(bg);
            g.fill(chip);
            g.fill(outline);
            g.setColor(ink);
            g.fill(island);
        }
    }
}
