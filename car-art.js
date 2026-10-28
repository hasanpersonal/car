/* =============================================================================
   car-art.js — geometric vehicle renderer for NEON DRIVE
   -----------------------------------------------------------------------------
   This file is 100% PRESENTATION. It never touches gameplay state: sizes,
   speeds, hit-boxes, spawning, scoring, controls and the multiplayer rules
   all stay exactly as they are in script.js. It only replaces the old
   flat rectangles with faceted, low-poly car bodies (roof, glazing, wings,
   lights, wheels, diffuser, exhaust, neon underglow).

   Usage:  CarArt.drawCar(ctx, options)   ->  draws around the CURRENT origin,
                                              centred on (0, 0).
   ============================================================================= */

window.CarArt = (function () {
    'use strict';

    /* ------------------------------------------------------------------ *
     *  1. tiny colour helpers
     * ------------------------------------------------------------------ */
    const _rgbCache = {};

    /* accepts '#rgb', '#rrggbb' and 'rgb(r,g,b)' so helpers can be chained */
    function rgb(hex) {
        if (_rgbCache[hex]) return _rgbCache[hex];
        const s = String(hex).trim();
        let c;
        const m = s.match(/^rgba?\(\s*([\d.]+)[\s,]+([\d.]+)[\s,]+([\d.]+)/i);
        if (m) {
            c = { r: Math.round(+m[1]), g: Math.round(+m[2]), b: Math.round(+m[3]) };
        } else {
            let h = s.replace('#', '');
            if (h.length === 3) h = h[0] + h[0] + h[1] + h[1] + h[2] + h[2];
            const n = parseInt(h, 16) || 0;
            c = { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255 };
        }
        return (_rgbCache[hex] = c);
    }

    function mix(a, b, t) {
        const A = rgb(a), B = rgb(b);
        t = t < 0 ? 0 : t > 1 ? 1 : t;
        return 'rgb(' + Math.round(A.r + (B.r - A.r) * t) + ',' +
                        Math.round(A.g + (B.g - A.g) * t) + ',' +
                        Math.round(A.b + (B.b - A.b) * t) + ')';
    }
    const lighten = (c, t) => mix(c, '#ffffff', t);
    const darken  = (c, t) => mix(c, '#000000', t);
    const fade    = (c, a) => { const p = rgb(c); return 'rgba(' + p.r + ',' + p.g + ',' + p.b + ',' + a + ')'; };

    /* flat-shading factor: >1 catches light, <1 falls into shadow */
    function shade(base, f) {
        return f >= 1 ? lighten(base, Math.min(0.55, (f - 1) * 0.5))
                      : darken(base, Math.min(0.82, (1 - f) * 0.8));
    }

    const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);

    /* ------------------------------------------------------------------ *
     *  2. drawing primitives
     * ------------------------------------------------------------------ */
    function poly(ctx, pts, fill, stroke, lw) {
        ctx.beginPath();
        ctx.moveTo(pts[0][0], pts[0][1]);
        for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i][0], pts[i][1]);
        ctx.closePath();
        if (fill) { ctx.fillStyle = fill; ctx.fill(); }
        if (stroke) { ctx.strokeStyle = stroke; ctx.lineWidth = lw || 1; ctx.stroke(); }
    }

    function roundRectPath(ctx, x, y, w, h, r) {
        r = Math.min(r, Math.abs(w) / 2, Math.abs(h) / 2);
        ctx.beginPath();
        ctx.moveTo(x + r, y);
        ctx.lineTo(x + w - r, y);
        ctx.quadraticCurveTo(x + w, y, x + w, y + r);
        ctx.lineTo(x + w, y + h - r);
        ctx.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
        ctx.lineTo(x + r, y + h);
        ctx.quadraticCurveTo(x, y + h, x, y + h - r);
        ctx.lineTo(x, y + r);
        ctx.quadraticCurveTo(x, y, x + r, y);
        ctx.closePath();
    }

    function ellipsePath(ctx, cx, cy, rx, ry) {
        ctx.beginPath();
        if (ctx.ellipse) ctx.ellipse(cx, cy, rx, ry, 0, 0, Math.PI * 2);
        else { ctx.save(); ctx.translate(cx, cy); ctx.scale(1, ry / rx); ctx.arc(0, 0, rx, 0, Math.PI * 2); ctx.restore(); }
    }

    /* ------------------------------------------------------------------ *
     *  3. body profiles
     *
     *  The car is drawn as a rear three-quarter view (camera behind and
     *  slightly above the car, which is what you get with the canvas
     *  rotateX(15deg) tilt). The TOP of the sprite is the FAR end of the
     *  car (roof / windscreen header) and the BOTTOM is the NEAR end
     *  (rear bumper sitting on the road), so — because of perspective —
     *  the silhouette widens from top to bottom.
     *
     *  rings : [ y, halfWidth ]  · y and halfWidth are fractions of the
     *          hit-box (h and w). y: -0.5 = far/top, +0.5 = near/bottom.
     *  band  : flat-shade factor for every section between two rings.
     * ------------------------------------------------------------------ */
    const STYLES = {
        /* low, wide hyper-car — the player */
        sports: {
            rings: [[-0.50, 0.185], [-0.32, 0.268], [-0.10, 0.372],
                    [ 0.07, 0.438], [ 0.26, 0.466], [ 0.40, 0.446], [ 0.48, 0.392]],
            band:  [1.16, 0.58, 1.02, 0.74, 0.60, 0.42],
            wing: 'gt', lights: 'blade', bar: true,  plate: false, exhaust: 2,
            rearW: { x: 0.432, hw: 0.100, y:  0.275, hh: 0.120 },
            frontW:{ x: 0.400, hw: 0.072, y: -0.030, hh: 0.088 },
            mirrors: true, stripe: true
        },
        /* normal four-door saloon */
        sedan: {
            rings: [[-0.50, 0.210], [-0.30, 0.288], [-0.08, 0.362],
                    [ 0.08, 0.420], [ 0.27, 0.442], [ 0.40, 0.428], [ 0.48, 0.382]],
            band:  [1.10, 0.56, 1.00, 0.72, 0.58, 0.40],
            wing: 'duck', lights: 'block', bar: false, plate: true, exhaust: 1,
            rearW: { x: 0.418, hw: 0.094, y:  0.262, hh: 0.112 },
            frontW:{ x: 0.392, hw: 0.068, y:  0.000, hh: 0.082 },
            mirrors: true, stripe: false
        },
        /* small rounded coupé */
        coupe: {
            rings: [[-0.50, 0.175], [-0.29, 0.258], [-0.09, 0.352],
                    [ 0.07, 0.412], [ 0.26, 0.438], [ 0.40, 0.420], [ 0.48, 0.372]],
            band:  [1.18, 0.60, 1.04, 0.76, 0.62, 0.44],
            wing: 'none', lights: 'round', bar: false, plate: true, exhaust: 1,
            rearW: { x: 0.412, hw: 0.090, y:  0.258, hh: 0.108 },
            frontW:{ x: 0.386, hw: 0.066, y: -0.010, hh: 0.080 },
            mirrors: true, stripe: false
        },
        /* tall boxy van / truck */
        van: {
            rings: [[-0.50, 0.250], [-0.34, 0.300], [-0.12, 0.372],
                    [ 0.06, 0.424], [ 0.26, 0.444], [ 0.40, 0.434], [ 0.48, 0.392]],
            band:  [1.06, 0.52, 0.98, 0.70, 0.56, 0.40],
            wing: 'rack', lights: 'column', bar: false, plate: false, exhaust: 0,
            rearW: { x: 0.420, hw: 0.098, y:  0.272, hh: 0.122 },
            frontW:{ x: 0.398, hw: 0.074, y: -0.010, hh: 0.088 },
            mirrors: true, stripe: false, doors: true
        }
    };

    /* 5 vertical columns -> faceted left / centre / right shading */
    const COLS  = [-1, -0.62, -0.18, 0.18, 0.62, 1];
    const COLSH = [0.90, 1.07, 1.16, 0.96, 0.74];

    /* ------------------------------------------------------------------ *
     *  4. pieces
     * ------------------------------------------------------------------ */
    function wheel(ctx, o, cx, cy, hw, hh, spin, steerAmt, front) {
        ctx.save();
        ctx.translate(cx, cy);
        /* the wheel leans when steering (front) and squashes with the load */
        ctx.transform(1, 0, (steerAmt || 0) * (front ? 0.16 : 0.05), 1, 0, 0);

        roundRectPath(ctx, -hw, -hh, hw * 2, hh * 2, hw * 0.55);
        ctx.fillStyle = '#0d0d13';
        ctx.fill();

        /* tread blocks that scroll with the wheel */
        ctx.save();
        ctx.beginPath();
        roundRectPath(ctx, -hw, -hh, hw * 2, hh * 2, hw * 0.55);
        ctx.clip();
        const span = hh * 2, step = span / 4;
        ctx.strokeStyle = 'rgba(255,255,255,0.10)';
        ctx.lineWidth = Math.max(1, hw * 0.18);
        for (let i = -1; i < 5; i++) {
            const y = -hh + ((spin + i * step / span) % 1) * span;
            ctx.beginPath();
            ctx.moveTo(-hw, y);
            ctx.lineTo(hw, y + hh * 0.12);
            ctx.stroke();
        }
        ctx.restore();

        /* lit outer sidewall */
        ctx.fillStyle = 'rgba(255,255,255,0.13)';
        roundRectPath(ctx, (cx > 0 ? hw * 0.35 : -hw), -hh, hw * 0.65, hh * 2, hw * 0.4);
        ctx.fill();

        /* tiny rim / hubcap sliver seen from behind */
        ctx.fillStyle = fade(o.acc, 0.55);
        roundRectPath(ctx, -hw * 0.55, -hh * 0.22, hw * 1.1, hh * 0.44, hw * 0.2);
        ctx.fill();
        ctx.restore();
    }

    /* ------------------------------------------------------------------ *
     *  5. main entry point
     * ------------------------------------------------------------------ */
    function drawCar(ctx, o) {
        const S    = STYLES[o.style] || STYLES.sports;
        const w    = o.w, h = o.h;
        const acc  = o.color || '#ff0055';
        const steer = clamp(o.steer || 0, -1, 1);
        const brake = clamp(o.brake || 0, 0, 1);
        const boost = clamp(o.boost || 0, 0, 1);
        const phase = o.phase || 0;
        const alpha = o.alpha == null ? 1 : o.alpha;

        const paint = mix('#121627', acc, 0.40);          /* body colour, tinted by the neon */
        const trim  = lighten(acc, 0.35);

        /* suspension bob + body roll + yaw (far end swings into the turn) */
        const bob   = Math.sin(phase * 0.25) * h * 0.006 * (0.45 + boost);
        const yawK  = 0.13 * steer;
        const roll  = steer * 0.028;

        /* vertex builder: (u, v) -> local pixels, with yaw shear applied */
        const V = (u, v) => [(u + yawK * (0.5 - v)) * w, v * h];

        ctx.save();
        ctx.globalAlpha *= alpha;
        ctx.transform(1, 0, -roll, 1, 0, 0);
        ctx.translate(0, bob);

        const R = S.rings;

        /* ---- ground shadow + neon underglow ------------------------- */
        ctx.save();
        ctx.fillStyle = 'rgba(0,0,0,0.55)';
        ellipsePath(ctx, 0, h * 0.455, w * 0.50, h * 0.045);
        ctx.fill();
        ctx.restore();

        ctx.save();
        ctx.translate(0, h * 0.42);
        ctx.scale(1, 0.30);
        const glowR = w * (0.62 + boost * 0.22);
        const g = ctx.createRadialGradient(0, 0, 0, 0, 0, glowR);
        g.addColorStop(0,    fade(acc, 0.42 + boost * 0.35));
        g.addColorStop(0.45, fade(acc, 0.16 + boost * 0.16));
        g.addColorStop(1,    fade(acc, 0));
        ctx.fillStyle = g;
        ctx.beginPath();
        ctx.arc(0, 0, glowR, 0, Math.PI * 2);
        ctx.fill();
        ctx.restore();

        /* ---- front wheels (behind the body) ------------------------- */
        const FW = S.frontW, RW = S.rearW;
        const spin = (phase * 0.045) % 1;
        wheel(ctx, { acc: acc }, -FW.x * w, FW.y * h, FW.hw * w, FW.hh * h, spin, steer, true);
        wheel(ctx, { acc: acc },  FW.x * w, FW.y * h, FW.hw * w, FW.hh * h, spin, steer, true);

        /* ---- faceted body ------------------------------------------- */
        for (let i = 0; i < R.length - 1; i++) {
            const y0 = R[i][0], w0 = R[i][1];
            const y1 = R[i + 1][0], w1 = R[i + 1][1];
            for (let j = 0; j < 5; j++) {
                const a = COLS[j], b = COLS[j + 1];
                poly(ctx, [
                    V(a * w0, y0), V(b * w0, y0), V(b * w1, y1), V(a * w1, y1)
                ], shade(paint, S.band[i] * COLSH[j]));
            }
        }

        /* horizontal panel seams */
        ctx.strokeStyle = 'rgba(0,0,0,0.30)';
        ctx.lineWidth = 1;
        for (let i = 1; i < R.length - 1; i++) {
            ctx.beginPath();
            ctx.moveTo(V(-R[i][1], R[i][0])[0], R[i][0] * h);
            ctx.lineTo(V(R[i][1], R[i][0])[0], R[i][0] * h);
            ctx.stroke();
        }
        /* vertical seam along each flank */
        ctx.strokeStyle = 'rgba(0,0,0,0.16)';
        for (const u of [-0.34, 0.34]) {
            ctx.beginPath();
            ctx.moveTo(V(u * R[2][1], R[2][0])[0], R[2][0] * h);
            ctx.lineTo(V(u * R[4][1], R[4][0])[0], R[4][0] * h);
            ctx.stroke();
        }

        /* ---- glazing (rear screen) ---------------------------------- */
        const gy0 = R[1][0], gy1 = R[2][0], gw0 = R[1][1], gw1 = R[2][1];
        const glass = [
            V(-gw0 * 0.92, gy0), V(gw0 * 0.92, gy0), V(gw1 * 0.94, gy1), V(-gw1 * 0.94, gy1)
        ];
        ctx.save();
        poly(ctx, glass, null);
        ctx.clip();
        const gg = ctx.createLinearGradient(-w * 0.5, gy0 * h, w * 0.5, gy1 * h);
        gg.addColorStop(0, '#152742');
        gg.addColorStop(0.5, '#0f1a30');
        gg.addColorStop(1, '#161f38');
        ctx.fillStyle = gg;
        ctx.fillRect(-w, gy0 * h - 2, w * 2, (gy1 - gy0) * h + 4);
        /* two head-rests / seats seen through the screen */
        ctx.fillStyle = 'rgba(0,0,0,0.55)';
        for (const u of [-0.135, 0.135]) {
            roundRectPath(ctx, u * w - w * 0.075, (gy0 + 0.55 * (gy1 - gy0)) * h,
                          w * 0.15, (gy1 - gy0) * h * 0.42, w * 0.03);
            ctx.fill();
        }
        /* two diagonal reflection bands running across the screen */
        poly(ctx, [
            V(-gw0 * 0.92, gy0), V(-gw0 * 0.50, gy0),
            V(-gw1 * 0.10, gy1), V(-gw1 * 0.52, gy1)
        ], 'rgba(255,255,255,0.13)');
        poly(ctx, [
            V(-gw0 * 0.22, gy0), V(gw0 * 0.06, gy0),
            V(gw1 * 0.52, gy1), V(gw1 * 0.24, gy1)
        ], 'rgba(255,255,255,0.07)');
        ctx.restore();
        /* glass frame */
        poly(ctx, glass, null, 'rgba(0,0,0,0.55)', 1.2);

        /* ---- roof ---------------------------------------------------- */
        poly(ctx, [V(-R[0][1] * 0.96, R[0][0] + 0.012), V(R[0][1] * 0.96, R[0][0] + 0.012),
                   V(R[1][1] * 0.92, R[1][0]), V(-R[1][1] * 0.92, R[1][0])],
             shade(paint, S.band[0] * 1.10));
        /* rim light on the far edge of the roof */
        ctx.strokeStyle = 'rgba(255,255,255,0.45)';
        ctx.lineWidth = 1.4;
        ctx.beginPath();
        ctx.moveTo(V(-R[0][1], R[0][0])[0], R[0][0] * h);
        ctx.lineTo(V(R[0][1], R[0][0])[0], R[0][0] * h);
        ctx.stroke();

        /* ---- door mirrors ------------------------------------------- */
        if (S.mirrors) {
            const my = gy0 + (gy1 - gy0) * 0.62;
            for (const s of [-1, 1]) {
                const mx = s * (gw0 + (gw1 - gw0) * 0.62) * w;
                poly(ctx, [
                    [mx, my * h - h * 0.012],
                    [mx + s * w * 0.085, my * h + h * 0.004],
                    [mx + s * w * 0.075, my * h + h * 0.038],
                    [mx - s * w * 0.005, my * h + h * 0.026]
                ], shade(paint, 0.85), 'rgba(0,0,0,0.4)', 1);
            }
        }

        /* ---- rear wing / spoiler ------------------------------------ */
        const deckY = R[3][0], deckW = R[3][1];
        if (S.wing === 'gt') {
            /* risers */
            for (const s of [-1, 1]) {
                poly(ctx, [V(s * 0.16, deckY + 0.02), V(s * 0.235, deckY + 0.02),
                           V(s * 0.205, deckY - 0.08), V(s * 0.165, deckY - 0.08)],
                     darken(paint, 0.35));
            }
            /* blade */
            poly(ctx, [V(-0.415, deckY - 0.14), V(0.415, deckY - 0.14),
                       V(0.395, deckY - 0.08), V(-0.395, deckY - 0.08)],
                 shade(paint, 0.72));
            /* blade top highlight */
            poly(ctx, [V(-0.415, deckY - 0.14), V(0.415, deckY - 0.14),
                       V(0.410, deckY - 0.124), V(-0.410, deckY - 0.124)],
                 'rgba(255,255,255,0.22)');
            /* end plates */
            for (const s of [-1, 1]) {
                poly(ctx, [V(s * 0.40, deckY - 0.175), V(s * 0.455, deckY - 0.175),
                           V(s * 0.455, deckY - 0.06), V(s * 0.40, deckY - 0.06)],
                     shade(paint, 0.60), fade(acc, 0.55), 1);
            }
            /* shadow the blade throws on the boot lid */
            poly(ctx, [V(-0.40, deckY - 0.075), V(0.40, deckY - 0.075),
                       V(0.38, deckY - 0.02), V(-0.38, deckY - 0.02)], 'rgba(0,0,0,0.28)');
        } else if (S.wing === 'duck') {
            poly(ctx, [V(-deckW * 0.92, deckY + 0.03), V(deckW * 0.92, deckY + 0.03),
                       V(deckW * 0.86, deckY - 0.035), V(-deckW * 0.86, deckY - 0.035)],
                 shade(paint, 0.78));
            ctx.strokeStyle = 'rgba(255,255,255,0.18)';
            ctx.lineWidth = 1;
            ctx.beginPath();
            ctx.moveTo(V(-deckW * 0.86, deckY - 0.035)[0], (deckY - 0.035) * h);
            ctx.lineTo(V(deckW * 0.86, deckY - 0.035)[0], (deckY - 0.035) * h);
            ctx.stroke();
        } else if (S.wing === 'rack') {
            /* roof rack / light bar */
            poly(ctx, [V(-R[0][1] * 0.85, R[0][0] - 0.028), V(R[0][1] * 0.85, R[0][0] - 0.028),
                       V(R[0][1] * 0.85, R[0][0] - 0.006), V(-R[0][1] * 0.85, R[0][0] - 0.006)],
                 darken(paint, 0.25), 'rgba(255,255,255,0.15)', 1);
            for (let i = -1; i <= 1; i++) {
                ctx.fillStyle = fade('#ffea00', 0.9);
                ctx.fillRect(i * w * 0.11 - w * 0.018, (R[0][0] - 0.03) * h, w * 0.036, h * 0.012);
            }
        }

        /* ---- tail lights -------------------------------------------- */
        const litUp = 0.55 + brake * 0.45;
        ctx.save();
        ctx.shadowBlur = 10 + brake * 14 + boost * 6;
        ctx.shadowColor = acc;
        if (S.lights === 'blade') {
            for (const s of [-1, 1]) {
                poly(ctx, [V(s * 0.085, 0.075), V(s * 0.395, 0.068),
                           V(s * 0.415, 0.150), V(s * 0.085, 0.158)],
                     fade(lighten(acc, 0.25), litUp));
            }
        } else if (S.lights === 'block') {
            for (const s of [-1, 1]) {
                roundRectPath(ctx, (s > 0 ? 0.085 : -0.325) * w, 0.075 * h, 0.24 * w, 0.085 * h, h * 0.008);
                ctx.fillStyle = fade(lighten(acc, 0.25), litUp);
                ctx.fill();
            }
        } else if (S.lights === 'round') {
            for (const s of [-1, 1]) {
                ellipsePath(ctx, s * 0.235 * w, 0.115 * h, w * 0.075, h * 0.030);
                ctx.fillStyle = fade(lighten(acc, 0.25), litUp);
                ctx.fill();
            }
        } else { /* column (van) */
            for (const s of [-1, 1]) {
                poly(ctx, [V(s * 0.26, -0.06), V(s * 0.355, -0.06),
                           V(s * 0.355, 0.215), V(s * 0.26, 0.215)],
                     fade(lighten(acc, 0.25), litUp));
            }
        }
        ctx.restore();

        /* bright core inside each lamp */
        const core = 'rgba(255,255,255,' + (0.35 + brake * 0.5) + ')';
        if (S.lights === 'blade') {
            for (const s of [-1, 1]) {
                poly(ctx, [V(s * 0.10, 0.095), V(s * 0.375, 0.090),
                           V(s * 0.385, 0.122), V(s * 0.10, 0.126)], core);
            }
        } else if (S.lights !== 'round') {
            for (const s of [-1, 1]) {
                ctx.fillRect((s > 0 ? 0.10 : -0.30) * w, 0.10 * h, 0.20 * w, 0.022 * h);
            }
        }

        /* full width light bar (sports) */
        if (S.bar) {
            poly(ctx, [V(-0.085, 0.100), V(0.085, 0.100), V(0.085, 0.135), V(-0.085, 0.135)],
                 fade(acc, 0.55 + brake * 0.4));
        }

        /* ---- number plate / rear doors ------------------------------ */
        if (S.plate) {
            poly(ctx, [V(-0.09, 0.185), V(0.09, 0.185), V(0.088, 0.275), V(-0.088, 0.275)],
                 '#c9cfe0', 'rgba(0,0,0,0.6)', 1);
            ctx.fillStyle = 'rgba(0,0,0,0.55)';
            ctx.fillRect(-0.06 * w, 0.212 * h, 0.12 * w, 0.016 * h);
            ctx.fillRect(-0.045 * w, 0.238 * h, 0.09 * w, 0.014 * h);
        }
        if (S.doors) {
            ctx.strokeStyle = 'rgba(0,0,0,0.45)';
            ctx.lineWidth = 1.2;
            ctx.beginPath();
            ctx.moveTo(0, R[2][0] * h);
            ctx.lineTo(0, R[4][0] * h);
            ctx.stroke();
            for (const s of [-1, 1]) {
                ctx.fillStyle = 'rgba(255,255,255,0.12)';
                ctx.fillRect(s > 0 ? 0.11 * w : -0.25 * w, 0.02 * h, 0.14 * w, 0.018 * h);
            }
        }

        /* ---- bumper + diffuser -------------------------------------- */
        poly(ctx, [V(-R[4][1] * 0.98, R[4][0]), V(R[4][1] * 0.98, R[4][0]),
                   V(R[5][1] * 0.98, R[5][0]), V(-R[5][1] * 0.98, R[5][0])],
             darken(paint, 0.36));
        ctx.strokeStyle = 'rgba(255,255,255,0.16)';
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(V(-R[4][1] * 0.98, R[4][0])[0], R[4][0] * h);
        ctx.lineTo(V(R[4][1] * 0.98, R[4][0])[0], R[4][0] * h);
        ctx.stroke();
        /* number-plate recess / crease + corner reflectors */
        ctx.strokeStyle = 'rgba(0,0,0,0.45)';
        ctx.beginPath();
        ctx.moveTo(V(-R[4][1] * 0.9, R[4][0] + 0.055)[0], (R[4][0] + 0.055) * h);
        ctx.lineTo(V(R[4][1] * 0.9, R[4][0] + 0.055)[0], (R[4][0] + 0.055) * h);
        ctx.stroke();
        for (const si of [-1, 1]) {
            poly(ctx, [V(si * 0.30, 0.255), V(si * 0.415, 0.255),
                       V(si * 0.405, 0.315), V(si * 0.295, 0.315)],
                 'rgba(255,40,40,0.45)', 'rgba(0,0,0,0.4)', 0.8);
        }

        poly(ctx, [V(-R[5][1] * 0.96, R[5][0]), V(R[5][1] * 0.96, R[5][0]),
                   V(R[6][1], R[6][0]), V(-R[6][1], R[6][0])], '#06060b');
        ctx.strokeStyle = 'rgba(255,255,255,0.13)';
        for (let i = -2; i <= 2; i++) {
            ctx.beginPath();
            ctx.moveTo(V(i * 0.13, R[5][0])[0], R[5][0] * h);
            ctx.lineTo(V(i * 0.145, R[6][0])[0], R[6][0] * h);
            ctx.stroke();
        }

        /* ---- exhausts ------------------------------------------------ */
        const exY = 0.325 * h;
        const tips = [];
        if (S.exhaust === 2) { tips.push(-0.135, 0.135); }
        else if (S.exhaust === 1) { tips.push(0.155); }
        for (const u of tips) {
            ctx.fillStyle = '#1a1a24';
            ellipsePath(ctx, u * w, exY, w * 0.048, h * 0.026);
            ctx.fill();
            ctx.fillStyle = '#000';
            ellipsePath(ctx, u * w, exY, w * 0.030, h * 0.017);
            ctx.fill();
            ctx.strokeStyle = 'rgba(255,255,255,0.18)';
            ctx.lineWidth = 1;
            ellipsePath(ctx, u * w, exY, w * 0.048, h * 0.026);
            ctx.stroke();
        }

        /* ---- rear wheels (in front of the body: they are nearer) ----- */
        wheel(ctx, { acc: acc }, -RW.x * w, RW.y * h, RW.hw * w, RW.hh * h, spin, steer, false);
        wheel(ctx, { acc: acc },  RW.x * w, RW.y * h, RW.hw * w, RW.hh * h, spin, steer, false);
        /* wheel-arch shadows */
        for (const s of [-1, 1]) {
            ctx.fillStyle = 'rgba(0,0,0,0.45)';
            ellipsePath(ctx, s * RW.x * w, (RW.y - RW.hh * 0.95) * h, RW.hw * w * 1.25, RW.hh * h * 0.42);
            ctx.fill();
        }

        /* ---- nitro flames -------------------------------------------- */
        if (boost > 0.02) {
            for (const u of (tips.length ? tips : [0])) {
                const flick = 0.65 + Math.random() * 0.5;
                const len = h * (0.10 + boost * 0.14) * flick;
                const x0 = u * w + yawK * w * 0.2;
                ctx.save();
                ctx.globalAlpha *= 0.85;
                poly(ctx, [
                    [x0 - w * 0.055, exY], [x0 + w * 0.055, exY],
                    [x0 + w * 0.022, exY + len], [x0 - w * 0.022, exY + len]
                ], fade('#00f0ff', 0.55));
                poly(ctx, [
                    [x0 - w * 0.028, exY], [x0 + w * 0.028, exY],
                    [x0, exY + len * 0.78]
                ], 'rgba(255,255,255,0.85)');
                ctx.restore();
            }
        }

        /* ---- neon outline / rim light -------------------------------- */
        const sil = [];
        sil.push(V(-R[0][1], R[0][0]));
        for (let i = 0; i < R.length; i++) sil.push(V(R[i][1], R[i][0]));
        for (let i = R.length - 1; i >= 0; i--) sil.push(V(-R[i][1], R[i][0]));

        ctx.save();
        ctx.shadowBlur = 12;
        ctx.shadowColor = acc;
        poly(ctx, sil, null, fade(acc, 0.90), 1.6);
        ctx.restore();

        /* thin body-colour inner line keeps the facets readable */
        poly(ctx, sil, null, 'rgba(0,0,0,0.35)', 0.8);

        /* racing stripe: roof + boot lid, broken by the rear screen */
        if (S.stripe) {
            ctx.save();
            ctx.globalAlpha *= 0.24;
            poly(ctx, [V(-0.042, R[0][0] + 0.015), V(0.042, R[0][0] + 0.015),
                       V(0.052, R[1][0] - 0.005), V(-0.052, R[1][0] - 0.005)], '#ffffff');
            poly(ctx, [V(-0.052, R[2][0] + 0.005), V(0.052, R[2][0] + 0.005),
                       V(0.060, R[3][0] + 0.01), V(-0.060, R[3][0] + 0.01)], '#ffffff');
            ctx.restore();
        }

        ctx.restore();

        /* ---- name tag (used for the ghost cars of other players) ----- */
        if (o.name) {
            ctx.save();
            ctx.font = 'bold 11px Segoe UI, Roboto, sans-serif';
            ctx.textAlign = 'center';
            const ty = -h * 0.5 - 9;
            const tw = ctx.measureText(o.name).width + 12;
            ctx.fillStyle = 'rgba(0,0,0,0.65)';
            roundRectPath(ctx, -tw / 2, ty - 11, tw, 15, 4);
            ctx.fill();
            ctx.strokeStyle = fade(acc, 0.8);
            ctx.lineWidth = 1;
            ctx.stroke();
            ctx.fillStyle = '#fff';
            ctx.fillText(o.name, 0, ty);
            ctx.restore();
        }
    }

    return { drawCar: drawCar, styles: Object.keys(STYLES), mix: mix, fade: fade, lighten: lighten, darken: darken };
})();
