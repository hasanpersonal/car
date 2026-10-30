#!/usr/bin/env python3
"""Generate the NEON DRIVE PWA launcher icons.

The artwork is drawn at 2048px and down-sampled, so the production PNGs
stay crisp without keeping a binary design source in the repository.
Run with:  python3 tools/generate_pwa_icons.py   (requires Pillow)
"""

from pathlib import Path
import math
import random

from PIL import Image, ImageDraw, ImageFilter


ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / "icons"
SS = 2                      # supersample factor: draw at 2048, ship smaller
W = 1024 * SS

CYAN = (0, 240, 255, 255)
PINK = (255, 0, 85, 255)
GREEN = (0, 255, 102, 255)
YELLOW = (255, 234, 0, 255)
WHITE = (235, 248, 255, 255)
INK = (3, 5, 12, 255)


def lerp(a, b, t):
    return tuple(round(a[i] + (b[i] - a[i]) * t) for i in range(3)) + (255,)


class Scene:
    def __init__(self, safe=1.0):
        self.safe = safe
        self.img = self._background()
        self.d = ImageDraw.Draw(self.img, "RGBA")

    def p(self, x, y):
        """1024px design coordinates -> supersampled canvas coordinates."""
        cx, cy = 512, 532
        x = cx + (x - cx) * self.safe
        y = cy + (y - cy) * self.safe
        return (x * SS, y * SS)

    def pts(self, points):
        return [self.p(*q) for q in points]

    def box(self, xy):
        return self.p(xy[0], xy[1]) + self.p(xy[2], xy[3])

    def wdt(self, n):
        return max(1, round(n * SS * self.safe))

    def _background(self):
        top = (2, 3, 12)
        mid = (8, 12, 34)
        bot = (3, 4, 14)
        img = Image.new("RGBA", (W, W), INK)
        d = ImageDraw.Draw(img)
        for y in range(W):
            t = y / W
            d.line([(0, y), (W, y)], fill=lerp(top, mid, t * 2) if t < 0.5
                   else lerp(mid, bot, (t - 0.5) * 2))

        glow = Image.new("RGBA", (W, W), (0, 0, 0, 0))
        gd = ImageDraw.Draw(glow)
        gd.ellipse([-420, 60, 760, 900], fill=(0, 110, 160, 120))
        gd.ellipse([1240, 0, 2450, 950], fill=(170, 0, 72, 118))
        gd.ellipse([420, 1210, 1640, 2050], fill=(0, 70, 130, 82))
        img.alpha_composite(glow.filter(ImageFilter.GaussianBlur(150)))

        rnd = random.Random(20251029)
        sd = ImageDraw.Draw(img, "RGBA")
        for _ in range(150):
            x, y = rnd.randrange(W), rnd.randrange(int(W * 0.46))
            r = rnd.choice([1.5, 2.2, 3.0])
            sd.ellipse([x - r, y - r, x + r, y + r],
                       fill=(210, 235, 255, rnd.randrange(70, 190)))
        return img

    def line(self, points, fill, width=8):
        self.d.line(self.pts(points), fill=fill, width=self.wdt(width), joint="curve")

    def glow_line(self, points, colour, width=9):
        layer = Image.new("RGBA", (W, W), (0, 0, 0, 0))
        d = ImageDraw.Draw(layer)
        d.line(self.pts(points), fill=colour[:3] + (190,), width=self.wdt(width * 3))
        self.img.alpha_composite(layer.filter(ImageFilter.GaussianBlur(18 * SS)))
        self.d = ImageDraw.Draw(self.img, "RGBA")
        self.line(points, colour, width)

    def city(self):
        rnd = random.Random(44)
        base = 512
        for side, colour in [(-1, CYAN), (1, PINK)]:
            x = 30 if side < 0 else 690
            while x < (330 if side < 0 else 990):
                bw = rnd.randrange(42, 82)
                bh = rnd.randrange(95, 245)
                self.d.rectangle(self.box((x, base - bh, x + bw, base)),
                                 fill=(5, 8, 20, 235))
                self.line([(x, base - bh), (x + bw, base - bh)], colour, 4)
                for _ in range(rnd.randrange(4, 13)):
                    wx = x + rnd.randrange(7, max(9, bw - 13))
                    wy = base - bh + rnd.randrange(14, max(16, bh - 18))
                    c = rnd.choice([CYAN, PINK, YELLOW, WHITE])
                    self.d.rectangle(self.box((wx, wy, wx + 6, wy + 8)),
                                     fill=c[:3] + (rnd.randrange(100, 220),))
                x += bw + rnd.randrange(10, 24)

    def road(self):
        self.d.polygon(self.pts([(105, 1024), (408, 502), (616, 502), (919, 1024)]),
                       fill=(13, 18, 31, 255))
        self.d.polygon(self.pts([(170, 1024), (430, 502), (594, 502), (854, 1024)]),
                       fill=(22, 28, 44, 255))
        self.glow_line([(126, 1024), (414, 504)], CYAN, 10)
        self.glow_line([(898, 1024), (610, 504)], PINK, 10)
        # Broken white lane paint, converging with the road.
        for i, (y0, y1) in enumerate([(980, 895), (850, 790), (752, 708),
                                      (678, 646), (620, 596), (574, 556)]):
            width = 15 - i * 2
            self.d.rounded_rectangle(self.box((512 - width / 2, y1, 512 + width / 2, y0)),
                                     radius=self.wdt(5), fill=(230, 240, 255, 235))

    def wheel(self, x0, colour):
        x1 = x0 + 92
        self.d.rounded_rectangle(self.box((x0, 612, x1, 852)), radius=self.wdt(26),
                                 fill=(2, 3, 8, 255), outline=(44, 54, 78, 255),
                                 width=self.wdt(5))
        for yy in (650, 700, 750, 800):
            self.line([(x0 + 12, yy), (x1 - 12, yy)], (40, 50, 72, 255), 7)
        self.d.ellipse(self.box((x0 + 18, 690, x1 - 18, 774)),
                       fill=(18, 24, 40, 255), outline=colour, width=self.wdt(6))
        self.d.ellipse(self.box((x0 + 35, 715, x1 - 35, 749)), fill=colour)
        self.line([(x0 + 9, 622), (x0 + 9, 842)], colour, 6)

    def car(self):
        # Ground shadow / neon pool.
        shadow = Image.new("RGBA", (W, W), (0, 0, 0, 0))
        sd = ImageDraw.Draw(shadow)
        sd.ellipse(self.box((238, 790, 786, 902)), fill=(0, 0, 0, 190))
        sd.ellipse(self.box((292, 815, 732, 890)), fill=(255, 0, 85, 78))
        self.img.alpha_composite(shadow.filter(ImageFilter.GaussianBlur(20 * SS)))
        self.d = ImageDraw.Draw(self.img, "RGBA")

        self.wheel(278, CYAN)
        self.wheel(654, PINK)

        # Rear wing endplates and main plane.
        self.d.polygon(self.pts([(250, 500), (292, 484), (292, 618), (250, 602)]),
                       fill=(9, 13, 27, 255), outline=CYAN)
        self.d.polygon(self.pts([(774, 500), (732, 484), (732, 618), (774, 602)]),
                       fill=(9, 13, 27, 255), outline=PINK)
        self.d.rounded_rectangle(self.box((270, 486, 754, 554)), radius=self.wdt(18),
                                 fill=(10, 15, 30, 255), outline=(80, 100, 140, 255),
                                 width=self.wdt(4))
        self.line([(284, 500), (740, 500)], PINK, 8)
        self.line([(284, 540), (740, 540)], CYAN, 5)
        self.d.rectangle(self.box((486, 548, 538, 654)), fill=(8, 11, 24, 255))

        # Sidepods and engine cover.
        self.d.polygon(self.pts([(330, 682), (468, 630), (478, 826), (342, 830)]),
                       fill=(92, 0, 55, 255))
        self.d.polygon(self.pts([(694, 682), (556, 630), (546, 826), (682, 830)]),
                       fill=(92, 0, 55, 255))
        self.d.polygon(self.pts([(405, 574), (619, 574), (674, 826), (350, 826)]),
                       fill=(226, 0, 76, 255))
        self.d.polygon(self.pts([(484, 574), (540, 574), (560, 826), (464, 826)]),
                       fill=(255, 45, 105, 255))
        self.line([(364, 812), (424, 600)], CYAN, 7)
        self.line([(660, 812), (600, 600)], PINK, 7)

        # Cockpit, halo and helmet.
        self.d.ellipse(self.box((423, 548, 601, 670)), fill=(2, 4, 10, 255))
        self.d.arc(self.box((414, 522, 610, 668)), start=180, end=360,
                   fill=CYAN, width=self.wdt(13))
        self.d.ellipse(self.box((462, 548, 562, 648)), fill=(0, 190, 220, 255))
        self.d.arc(self.box((475, 576, 549, 630)), start=180, end=360,
                   fill=(230, 250, 255, 255), width=self.wdt(13))
        self.d.rectangle(self.box((479, 604, 545, 622)), fill=(5, 10, 20, 255))

        # Rear light, exhausts and diffuser.
        light = Image.new("RGBA", (W, W), (0, 0, 0, 0))
        ld = ImageDraw.Draw(light)
        ld.rounded_rectangle(self.box((466, 714, 558, 758)), radius=self.wdt(16),
                             fill=(255, 35, 45, 210))
        self.img.alpha_composite(light.filter(ImageFilter.GaussianBlur(15 * SS)))
        self.d = ImageDraw.Draw(self.img, "RGBA")
        self.d.rounded_rectangle(self.box((476, 722, 548, 750)), radius=self.wdt(12),
                                 fill=(255, 80, 65, 255))
        for cx in (464, 560):
            self.d.ellipse(self.box((cx - 17, 774, cx + 17, 808)),
                           fill=(6, 10, 20, 255), outline=CYAN, width=self.wdt(5))
        self.d.rounded_rectangle(self.box((376, 812, 648, 862)), radius=self.wdt(12),
                                 fill=(5, 8, 18, 255))
        for x in (414, 458, 502, 546, 590):
            self.line([(x, 820), (x, 856)], (65, 82, 110, 255), 6)

        # Short speed streaks at the shoulders.
        for x, y, ln, c in [(196, 664, 86, CYAN), (174, 724, 116, CYAN),
                            (828, 664, -86, PINK), (850, 724, -116, PINK)]:
            self.line([(x, y), (x + ln, y)], c[:3] + (165,), 7)

    def finish(self):
        self.city()
        self.road()
        self.car()
        return self.img.convert("RGB")


def save(img, name, size):
    img.resize((size, size), Image.Resampling.LANCZOS).save(OUT / name, optimize=True)
    print(f"{name}: {size}x{size}")


def main():
    OUT.mkdir(parents=True, exist_ok=True)
    regular = Scene(safe=1.0).finish()
    maskable = Scene(safe=0.78).finish()   # keep the car inside the maskable safe zone

    save(regular, "icon-1024.png", 1024)
    save(regular, "icon-512.png", 512)
    save(regular, "icon-384.png", 384)
    save(regular, "icon-256.png", 256)
    save(regular, "icon-192.png", 192)
    save(regular, "icon-144.png", 144)
    save(regular, "apple-touch-icon.png", 180)
    save(regular, "favicon-32.png", 32)
    save(maskable, "maskable-512.png", 512)
    save(maskable, "maskable-192.png", 192)


if __name__ == "__main__":
    main()
