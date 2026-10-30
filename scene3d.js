/* =============================================================================
   scene3d.js — the NEON DRIVE 3D world (three.js)
   -----------------------------------------------------------------------------
   Owns the renderer, the chase camera, the road and the pooled objects
   (traffic cars, bullets, pickups, particles). It renders game state; it
   never decides anything. All rules stay in script.js.

   Camera framing is the fix for "controllers hide the car": the car is
   pinned to 40% of the screen height, so the bottom half of the phone is
   always clear for the thumb controls.
   ============================================================================= */

import * as THREE from 'three';
import { buildCar, acquireCar, releaseCar, glowTexture, CAR } from './car3d.js';

const ROAD_W = 440;                 // same as the 2D road (screen x 20..460)
const ROAD_HALF = ROAD_W / 2;
const NEAR_Z = 560;                 // road extends this far behind the car
/* How far you can see. The road used to dissolve 2900u out, which on a
   rotated phone is a tenth of the way down the screen — it looked like the
   track stopped short of the horizon. The fog, the geometry and the road
   furniture all run to ~5800u now, so the tarmac tapers almost to the
   horizon before it goes, and traffic has somewhere to appear from. */
const FAR_Z = -7200;                // ... and this far ahead
const VIEW_FAR = 5800;              // fog reaches full opacity here
const SPAN = NEAR_Z - FAR_Z;
const ROAD_SEGS = 150;              // the tarmac is a ribbon this many quads long

/* ------------------------------------------------------------------ *
 *  ROAD SHAPE
 *  A straight road is dull, so the centreline is a sum of three sines
 *  over distance travelled: long sweepers, real bends, and a ripple so
 *  it never reads as a plain arc. Re-seeded every race, so no two runs
 *  are alike and it never loops.
 *  The road is its own object: it is drawn where its centreline runs,
 *  relative to where that centreline is under the car, and nothing in it
 *  is measured against the car. So a car that is going straight does not
 *  stay on the road — the road curves out from under it and the driver
 *  has to answer with the wheel. Measuring it against the car (which is
 *  what it used to do) glued the car to the centreline, and that was the
 *  car following the bends with nobody steering.
 * ------------------------------------------------------------------ */
const CURVE_BANDS = [
    { wave: 2600, amp: 420 },       // long sweepers
    { wave: 1250, amp: 110 },       // the bends you actually steer for
    { wave: 620, amp: 20 }          // ripple, so it is never a plain arc
];
const CURVE = CURVE_BANDS.map(() => ({ wave: 1, amp: 0, phase: 0 }));
/* The road also rises and falls: two sine bands over distance, seeded
   with the bends, normalised so the grade never exceeds 5%. script.js
   reads the grade under the car and turns it into gravity, so a crest
   is something you feel in the speed, not just something you see. */
const ELEV_BANDS = [
    { wave: 950, amp: 30 },         // long crests and dips
    { wave: 420, amp: 9 }           // shorter undulations
];
const ELEV = ELEV_BANDS.map(() => ({ wave: 1, amp: 0, phase: 0 }));
const MAX_GRADE = 0.05;
/* Corners are banked: the tarmac tilts into the bend, outside edge up,
   by an amount proportional to how hard the road is curving there. */
const BANK_GAIN = 1050, BANK_MAX = 0.13;
/* How hard the road is allowed to turn away from the car. The car no longer
   follows the centreline by itself, so a bend steeper than the steering can
   answer is a bend that simply carries you into the barrier whatever you do.
   Whole road is scaled by this, not band by band, so a steep seed stays
   drivable while a gentle one keeps its full sweep. */
const MAX_ROAD_SLOPE = 0.08;
/* bumped every time the bends are re-seeded, so anything caching a position
   on the old road knows to measure itself again */
let CURVE_GEN = 0;
function mulberry32(a) {
    return function () {
        a = a + 0x6D2B79F5 | 0;
        let t = Math.imul(a ^ a >>> 15, 1 | a);
        t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
        return ((t ^ t >>> 14) >>> 0) / 4294967296;
    };
}
/* no seed (the normal case) means a fresh random set of bends; a seed makes
   a shape reproducible, which is what the test harness needs */
export function reseedCurves(seed) {
    const rnd = seed === undefined ? Math.random : mulberry32(seed | 0);
    CURVE_BANDS.forEach((b, i) => {
        CURVE[i].wave = b.wave * (0.80 + rnd() * 0.45);
        CURVE[i].amp = b.amp * (0.55 + rnd() * 0.90);
        CURVE[i].phase = rnd() * Math.PI * 2;
    });
    const slope = CURVE.reduce((t, c) => t + c.amp / c.wave, 0);
    if (slope > MAX_ROAD_SLOPE) for (const c of CURVE) c.amp *= MAX_ROAD_SLOPE / slope;
    ELEV_BANDS.forEach((b, i) => {
        ELEV[i].wave = b.wave * (0.80 + rnd() * 0.45);
        ELEV[i].amp = b.amp * (0.55 + rnd() * 0.90);
        ELEV[i].phase = rnd() * Math.PI * 2;
    });
    const grade = ELEV.reduce((t, c) => t + c.amp / c.wave, 0);
    if (grade > MAX_GRADE) for (const c of ELEV) c.amp *= MAX_GRADE / grade;
    CURVE_GEN++;            // a new race is a new road: drop any stale cache
}
reseedCurves();
/* lateral offset of the road centre at absolute distance S along it */
const centreAt = (S) =>
    CURVE[0].amp * Math.sin(S / CURVE[0].wave + CURVE[0].phase) +
    CURVE[1].amp * Math.sin(S / CURVE[1].wave + CURVE[1].phase) +
    CURVE[2].amp * Math.sin(S / CURVE[2].wave + CURVE[2].phase);
/* and its slope, which is what sets the heading of everything sitting on it */
const slopeAt = (S) =>
    CURVE[0].amp / CURVE[0].wave * Math.cos(S / CURVE[0].wave + CURVE[0].phase) +
    CURVE[1].amp / CURVE[1].wave * Math.cos(S / CURVE[1].wave + CURVE[1].phase) +
    CURVE[2].amp / CURVE[2].wave * Math.cos(S / CURVE[2].wave + CURVE[2].phase);
/* how hard the heading itself is changing — the curvature that banks the road */
const bendRateAt = (S) =>
    -(CURVE[0].amp / (CURVE[0].wave * CURVE[0].wave) * Math.sin(S / CURVE[0].wave + CURVE[0].phase) +
      CURVE[1].amp / (CURVE[1].wave * CURVE[1].wave) * Math.sin(S / CURVE[1].wave + CURVE[1].phase) +
      CURVE[2].amp / (CURVE[2].wave * CURVE[2].wave) * Math.sin(S / CURVE[2].wave + CURVE[2].phase));
/* road height and grade (rise per unit travelled) at absolute distance S */
const elevAt = (S) =>
    ELEV[0].amp * Math.sin(S / ELEV[0].wave + ELEV[0].phase) +
    ELEV[1].amp * Math.sin(S / ELEV[1].wave + ELEV[1].phase);
const gradeAt = (S) =>
    ELEV[0].amp / ELEV[0].wave * Math.cos(S / ELEV[0].wave + ELEV[0].phase) +
    ELEV[1].amp / ELEV[1].wave * Math.cos(S / ELEV[1].wave + ELEV[1].phase);
/* stable per-index pseudo-random, so roadside furniture keeps its size
   and offset every frame while its position wraps down the road */
const hash1 = (n) => { const s = Math.sin(n * 127.1 + 311.7) * 43758.5453; return s - Math.floor(s); };

/* A ribbon: a strip of quads running the length of the road, rebuilt every
   frame so it can follow the bend. Used for the tarmac, the neon barriers
   and their glow, all of which used to be one straight slab each. */
function makeRibbon(segments, material, normal) {
    const count = segments + 1;
    const geo = new THREE.BufferGeometry();
    const uv = new Float32Array(count * 2 * 2);
    for (let i = 0; i < count; i++) {                 // v runs 0..1 along the road
        const v = i / segments;
        uv[i * 4 + 0] = 0; uv[i * 4 + 1] = v;
        uv[i * 4 + 2] = 1; uv[i * 4 + 3] = v;
    }
    const idx = new Uint16Array(segments * 6);
    for (let i = 0; i < segments; i++) {
        const a = i * 2, b = a + 1, c = a + 2, d = a + 3;
        idx.set([a, b, d, a, d, c], i * 6);
    }
    geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(count * 2 * 3), 3));
    geo.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
    if (normal) {
        const nrm = new Float32Array(count * 2 * 3);
        for (let i = 0; i < count * 2; i++) nrm.set(normal, i * 3);
        geo.setAttribute('normal', new THREE.BufferAttribute(nrm, 3));
    }
    geo.setIndex(new THREE.BufferAttribute(idx, 1));
    const mesh = new THREE.Mesh(geo, material);
    mesh.frustumCulled = false;               // it always spans the whole road
    return mesh;
}

/* ------------------------------------------------------------------ *
 *  Roadside textures, drawn once and shared by every World: tower
 *  facades with lit windows, neon signs, and the far skyline that sits
 *  on the horizon. All in the game's cyan / pink neon palette.
 * ------------------------------------------------------------------ */
let _facades = null;
function facadeTextures() {
    if (_facades) return _facades;
    const palettes = [
        ['#9ffcff', '#00f0ff', '#00f0ff', '#dfeaff', '#ff7ad9', '#ffea00'],
        ['#ffb3d9', '#ff0055', '#ff7ad9', '#dfeaff', '#00f0ff', '#ffea00']
    ];
    _facades = palettes.map((pal, v) => {
        const c = document.createElement('canvas');
        c.width = 128; c.height = 256;
        const g = c.getContext('2d');
        g.fillStyle = v ? '#0a0614' : '#060a15'; g.fillRect(0, 0, 128, 256);
        for (let y = 12; y < 248; y += 11) for (let x = 8; x < 116; x += 16) {
            if (Math.random() < 0.42) {
                g.globalAlpha = 0.55 + Math.random() * 0.45;
                g.fillStyle = pal[Math.floor(Math.random() * pal.length)];
            } else { g.globalAlpha = 1; g.fillStyle = 'rgba(160,190,255,0.05)'; }
            g.fillRect(x, y, 9, 6);
        }
        g.globalAlpha = 1;
        g.fillStyle = v ? '#ff0055' : '#00f0ff'; g.fillRect(0, 0, 128, 3);   // rooftop strip
        const t = new THREE.CanvasTexture(c);
        t.colorSpace = THREE.SRGBColorSpace; t.anisotropy = 4;
        return t;
    });
    return _facades;
}

let _signs = null;
function signTextures() {
    if (_signs) return _signs;
    const specs = [
        { t: 'NEON DRIVE', s: 'MULTIPLAYER GP', c: '#00f0ff' },
        { t: 'NITRO »»', s: 'FILL UP AHEAD', c: '#ff0055' },
        { t: 'TURBO CITY', s: 'LIMIT 420 KMH', c: '#ffea00' },
        { t: 'SECTOR-7', s: 'APEX RACING CLUB', c: '#00ff66' },
        { t: 'MIDNIGHT GP', s: 'NIGHT STAGE', c: '#c07aff' }
    ];
    _signs = specs.map(spec => {
        const c = document.createElement('canvas');
        c.width = 512; c.height = 176;
        const g = c.getContext('2d');
        g.fillStyle = '#04060d'; g.fillRect(0, 0, 512, 176);
        g.strokeStyle = spec.c; g.lineWidth = 7; g.strokeRect(9, 9, 494, 158);
        g.strokeStyle = 'rgba(255,255,255,0.35)'; g.lineWidth = 2; g.strokeRect(20, 20, 472, 136);
        g.textAlign = 'center'; g.textBaseline = 'middle';
        g.shadowColor = spec.c; g.shadowBlur = 26;
        g.fillStyle = spec.c;
        g.font = 'italic 900 72px "Segoe UI", Roboto, sans-serif';
        g.fillText(spec.t, 256, 80);
        g.shadowBlur = 10; g.fillStyle = '#eaf4ff';
        g.font = 'bold 29px "Segoe UI", Roboto, sans-serif';
        g.fillText(spec.s, 256, 134);
        const t = new THREE.CanvasTexture(c);
        t.colorSpace = THREE.SRGBColorSpace; t.anisotropy = 4;
        return t;
    });
    return _signs;
}

let _skyline = null;
function skylineTexture() {
    if (_skyline) return _skyline;
    const c = document.createElement('canvas');
    c.width = 2048; c.height = 512;
    const g = c.getContext('2d');
    /* horizon glow: synthwave dusk fading up into the night */
    const grad = g.createLinearGradient(0, 140, 0, 512);
    grad.addColorStop(0, 'rgba(90,30,150,0)');
    grad.addColorStop(0.55, 'rgba(150,40,160,0.30)');
    grad.addColorStop(0.8, 'rgba(255,45,120,0.17)');
    grad.addColorStop(1, 'rgba(4,5,12,0.96)');
    g.fillStyle = grad; g.fillRect(0, 140, 2048, 372);
    /* mountain ridge behind the city */
    g.fillStyle = '#0a1026'; g.beginPath(); g.moveTo(0, 512);
    let my = 330;
    for (let x = 0; x <= 2048; x += 64) { my = 300 + hash1(x * 0.37 + 5) * 80; g.lineTo(x, my); }
    g.lineTo(2048, 512); g.closePath(); g.fill();
    /* city blocks with lit windows */
    for (let x = -20; x < 2048; x += 26 + hash1(x) * 55) {
        const w = 30 + hash1(x * 1.7) * 70, h = 70 + hash1(x * 2.3) * 190;
        g.fillStyle = '#05070f'; g.fillRect(x, 512 - h, w, h);
        if (hash1(x * 3.1) > 0.72) g.fillRect(x + w / 2 - 1, 512 - h - 16, 2, 16);   // antenna
    }
    const dotCols = ['#00f0ff', '#ff7ad9', '#ffea00', '#dfeaff'];
    for (let i = 0; i < 1100; i++) {
        g.globalAlpha = 0.35 + Math.random() * 0.65;
        g.fillStyle = dotCols[i % 4];
        g.fillRect(Math.random() * 2048, 372 + Math.random() * 132, 2.5, 2.5);
    }
    g.globalAlpha = 1;
    _skyline = new THREE.CanvasTexture(c);
    _skyline.wrapS = THREE.RepeatWrapping; _skyline.repeat.set(2, 1);
    _skyline.colorSpace = THREE.SRGBColorSpace;
    return _skyline;
}

/* Chase camera constants (tunable from the console via the exported object).
   These were solved numerically: the car's bounding
   box was projected on six device shapes with the car in the centre lane and
   pushed to the outermost lane, minimising off-screen area, top clipping,
   intrusion into the bottom thumb zone and a horizon outside 4-40%.
   Result: the car's centre sits at 62% of screen height (top 55%, bottom 70%)
   on every phone shape, 117-154 px tall, horizon at 10%. The SHOOT buttons
   do not start until ~87%, so the car still clears them by a wide margin. */
export const CAM = {
    fov: 60,
    follow: 1,          // how much the camera slides sideways with the car.
                        // 1 = it sits on the car, so the car never drifts off
                        // the centre of the screen and it is the road that
                        // moves under you
    camY: 220,          // camera height above the road
    camZ: 330,          // camera distance behind the car
    lookY: -90,         // aim point: below road level, well up the track
    lookZ: -340         // shallow aim: drops the car to ~62% of screen height
};

/* The same rig, solved for a phone on its side. Portrait keeps the road
   wider than the screen, so a landscape view has to zoom IN or the road
   shrinks to a 45%-wide strip with a 40px car on it. Aiming further down
   the track flattens the pitch, which puts the horizon back in frame and
   drops the car to ~75-92% of the height — low, where a rotated phone has
   the most room, with the whole road ahead visible. */
const CAM_WIDE = { fov: 38, camY: 185, camZ: 310, lookY: -90, lookZ: -700 };
const CAM_KEYS = ['fov', 'camY', 'camZ', 'lookY', 'lookZ'];
const CAM_TALL = { fov: 60, camY: 220, camZ: 330, lookY: -90, lookZ: -340 };
/* 0 at aspect 0.72 (every portrait phone), 1 at 1.75 and wider */
export function camBlend(aspect) {
    return Math.max(0, Math.min(1, (aspect - 0.72) / (1.75 - 0.72)));
}

export class World {
    constructor(canvas) {
        this.canvas = canvas;
        /* MSAA is expensive on high-DPI phones and buys little there */
        this.renderer = new THREE.WebGLRenderer({
            canvas, antialias: (window.devicePixelRatio || 1) < 1.5,
            powerPreference: 'high-performance'
        });
        this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
        this.renderer.outputColorSpace = THREE.SRGBColorSpace;
        /* no filmic tone curve: neon wants saturated highlights that clip to
           pure colour, not the desaturated roll-off ACES would give it */
        this.renderer.toneMapping = THREE.NoToneMapping;

        this.scene = new THREE.Scene();
        this.scene.background = new THREE.Color('#04050c');
        this.scene.fog = new THREE.Fog('#04050c', 900, VIEW_FAR);

        this.camera = new THREE.PerspectiveCamera(CAM.fov, 1, 5, 12000);
        this.camShake = new THREE.Vector3();

        this._buildLights();
        this._buildRoad();
        this._buildPools();

        this.dummy = new THREE.Object3D();
        this.color = new THREE.Color();
        this.roadOffset = 0;            // distance travelled, set by scrollRoad
        this._playerZ = 0;              // where the car sits, set by setPlayer
        /* the road's position and heading under the car, cached once a frame:
           everything else is measured from it, and it is asked for hundreds
           of times */
        this._syncCurve();
        this.resize();
        this._shapeRoad();            // a sane road before the first scroll
    }

    /* ---------------------------------------------------------------- */
    _buildLights() {
        this.scene.add(new THREE.AmbientLight('#3d4a70', 1.9));
        const key = new THREE.DirectionalLight('#cfe0ff', 1.6);
        key.position.set(-160, 420, -220);
        this.scene.add(key);
        const rim = new THREE.DirectionalLight('#7a86ff', 0.5);
        rim.position.set(220, 180, 420);
        this.scene.add(rim);
        /* neon wash from the barriers */
        /* candela: at ~200 units this lands a soft neon wash on the cars */
        const left = new THREE.PointLight('#00f0ff', 22000, 900, 2);
        left.position.set(-ROAD_HALF, 40, -120);
        this.scene.add(left);
        const right = new THREE.PointLight('#ff0055', 22000, 900, 2);
        right.position.set(ROAD_HALF, 40, -120);
        this.scene.add(right);
    }

    /* ---------------------------------------------------------------- *
     *  The night around the road: a star dome, a moon with its halo, a
     *  low synthwave glow on the horizon and a far skyline ring. The
     *  world is car-relative (the road scrolls, the car stays), so all
     *  of this can simply stand still at the edge of sight. Everything
     *  here ignores fog — it *is* what's on the far side of the fog.
     * ---------------------------------------------------------------- */
    _buildSky() {
        /* stars */
        const N = 650, pos = new Float32Array(N * 3);
        for (let i = 0; i < N; i++) {
            const a = Math.random() * Math.PI * 2;
            const e = 0.10 + Math.random() * 1.25;          // elevation above horizon
            const R = 8800;
            pos[i * 3] = R * Math.cos(e) * Math.cos(a);
            pos[i * 3 + 1] = R * Math.sin(e);
            pos[i * 3 + 2] = R * Math.cos(e) * Math.sin(a);
        }
        const sg = new THREE.BufferGeometry();
        sg.setAttribute('position', new THREE.BufferAttribute(pos, 3));
        const stars = new THREE.Points(sg, new THREE.PointsMaterial({
            color: '#cfe2ff', size: 2, sizeAttenuation: false, transparent: true,
            opacity: 0.85, fog: false, depthWrite: false
        }));
        stars.frustumCulled = false;
        this.scene.add(stars);

        /* moon + halo */
        const moon = new THREE.Mesh(new THREE.CircleGeometry(205, 36),
            new THREE.MeshBasicMaterial({ color: '#dff6ff', fog: false, depthWrite: false }));
        moon.position.set(2600, 1850, -8000);
        moon.lookAt(0, 200, 0);
        this.scene.add(moon);
        const moonGlow = new THREE.Sprite(new THREE.SpriteMaterial({
            map: glowTexture(), color: '#7fd8ff', transparent: true, opacity: 0.34,
            blending: THREE.AdditiveBlending, fog: false, depthWrite: false
        }));
        moonGlow.position.copy(moon.position);
        moonGlow.scale.set(980, 980, 1);
        this.scene.add(moonGlow);

        /* low pink dusk-glow ahead-left, where the city burns */
        const dusk = new THREE.Sprite(new THREE.SpriteMaterial({
            map: glowTexture(), color: '#ff2d78', transparent: true, opacity: 0.17,
            blending: THREE.AdditiveBlending, fog: false, depthWrite: false
        }));
        dusk.position.set(-2100, 300, -8150);
        dusk.scale.set(3200, 1050, 1);
        this.scene.add(dusk);

        /* skyline ring on the horizon */
        const ring = new THREE.Mesh(new THREE.CylinderGeometry(8600, 8600, 1500, 48, 1, true),
            new THREE.MeshBasicMaterial({
                map: skylineTexture(), transparent: true, side: THREE.BackSide,
                fog: false, depthWrite: false
            }));
        ring.position.y = 300;
        ring.frustumCulled = false;
        this.scene.add(ring);
    }

    /* ---------------------------------------------------------------- */
    _buildRoad() {
        /* asphalt: generated grain, scrolled by the road offset */
        const c = document.createElement('canvas');
        c.width = c.height = 256;
        const g = c.getContext('2d');
        g.fillStyle = '#2f3340'; g.fillRect(0, 0, 256, 256);   // dark blue-grey asphalt
        for (let i = 0; i < 2600; i++) {
            g.fillStyle = `rgba(255,255,255,${Math.random() * 0.05 + 0.01})`;
            g.fillRect(Math.random() * 256, Math.random() * 256, Math.random() * 2 + 1, Math.random() * 2 + 1);
        }
        for (let i = 0; i < 22; i++) {                     // polished wheel lines
            g.fillStyle = `rgba(0,0,0,${Math.random() * 0.3 + 0.1})`;
            g.fillRect(Math.random() * 256, Math.random() * 256, Math.random() * 6 + 2, Math.random() * 90 + 40);
        }
        /* lived-in tarmac: repair patches, hairline cracks and a
           transverse expansion joint where the tile repeats */
        for (let i = 0; i < 7; i++) {
            g.fillStyle = `rgba(8,10,16,${Math.random() * 0.22 + 0.10})`;
            g.fillRect(Math.random() * 200, Math.random() * 200, 26 + Math.random() * 60, 20 + Math.random() * 50);
        }
        g.strokeStyle = 'rgba(10,12,18,0.55)'; g.lineWidth = 1.4;
        for (let i = 0; i < 6; i++) {
            g.beginPath();
            let cxp = Math.random() * 256, cyp = Math.random() * 256;
            g.moveTo(cxp, cyp);
            for (let s = 0; s < 5; s++) { cxp += (Math.random() - 0.5) * 34; cyp += Math.random() * 26; g.lineTo(cxp, cyp); }
            g.stroke();
        }
        g.fillStyle = 'rgba(5,6,10,0.5)'; g.fillRect(0, 0, 256, 3);
        this.asphalt = new THREE.CanvasTexture(c);
        this.asphalt.wrapS = this.asphalt.wrapT = THREE.RepeatWrapping;
        this.asphalt.colorSpace = THREE.SRGBColorSpace;
        this.asphalt.anisotropy = 4;
        /* the tiling is baked into the ribbon's UVs below, so the repeat is 1;
           one asphalt tile lands every ~228 units, which is what the scroll
           in scrollRoad() assumes */
        this.asphalt.repeat.set(2, 1);

        /* the tarmac is a ribbon now, so it can bend with the curve */
        this.roadRibbon = makeRibbon(ROAD_SEGS,
            new THREE.MeshStandardMaterial({ map: this.asphalt, roughness: 0.86, metalness: 0.07,
                                             side: THREE.DoubleSide }), [0, 1, 0]);
        this.scene.add(this.roadRibbon);
        /* asphalt tiles every ~228 units down the road */
        const ruv = this.roadRibbon.geometry.attributes.uv;
        for (let i = 0; i <= ROAD_SEGS; i++) {
            const v = (i / ROAD_SEGS) * (SPAN / 228);
            ruv.array[i * 4 + 1] = v; ruv.array[i * 4 + 3] = v;
        }
        ruv.needsUpdate = true;

        /* Terrain either side of the road. It used to be one flat plane,
           but the road climbs and dives now and would sink through it —
           so each side is a ribbon apron that follows the road's edge
           height and falls away into the dark, over a deep backstop
           plane far below the lowest dip. */
        const ground = new THREE.Mesh(
            new THREE.PlaneGeometry(26000, 26000),
            new THREE.MeshStandardMaterial({ color: '#030409', roughness: 1 }));
        ground.rotation.x = -Math.PI / 2;
        ground.position.set(0, -280, -3500);
        this.scene.add(ground);
        this.aprons = {};
        this.edgeLines = {};
        for (const side of [-1, 1]) {
            const apron = makeRibbon(ROAD_SEGS,
                new THREE.MeshStandardMaterial({ color: '#05060e', roughness: 1, side: THREE.DoubleSide }),
                [0, 1, 0]);
            this.scene.add(apron);
            this.aprons[side] = apron;
            /* solid edge lines, the way real tarmac is marked */
            const edge = makeRibbon(ROAD_SEGS,
                new THREE.MeshStandardMaterial({ color: '#dfe9ff', emissive: '#93a7d8', emissiveIntensity: 0.35,
                                                 roughness: 0.6, side: THREE.DoubleSide }),
                [0, 1, 0]);
            this.scene.add(edge);
            this.edgeLines[side] = edge;
        }

        /* ---- instanced, recycled road furniture ---- */
        const dashGeo = new THREE.BoxGeometry(3.5, 0.8, 42);
        this.dashes = new THREE.InstancedMesh(dashGeo,
            new THREE.MeshStandardMaterial({ color: '#ffffff', emissive: '#8899bb', emissiveIntensity: 0.25, roughness: 0.7 }), 144);
        this.dashes.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
        this.scene.add(this.dashes);

        const kerbGeo = new THREE.BoxGeometry(13, 2.4, 28);
        this.kerbs = new THREE.InstancedMesh(kerbGeo,
            new THREE.MeshStandardMaterial({ color: '#ffffff', roughness: 0.6 }), 192);
        this.kerbs.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
        this.kerbs.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(192 * 3), 3);
        this.scene.add(this.kerbs);

        const postGeo = new THREE.BoxGeometry(7, 30, 7);
        this.posts = new THREE.InstancedMesh(postGeo,
            new THREE.MeshStandardMaterial({ color: '#101423', emissive: '#ffffff', emissiveIntensity: 0.35, roughness: 0.5 }), 64);
        this.posts.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
        this.posts.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(64 * 3), 3);
        this.scene.add(this.posts);

        /* ---- neon barriers: walls that bend with the road, and their glow ---- */
        this.barriers = {};
        this.halos = {};
        for (const side of [-1, 1]) {
            const col = side < 0 ? '#00f0ff' : '#ff0055';
            const bar = makeRibbon(ROAD_SEGS,
                new THREE.MeshStandardMaterial({ color: col, emissive: col, emissiveIntensity: 2.4,
                                                 roughness: 0.3, side: THREE.DoubleSide }),
                [side, 0, 0]);
            this.scene.add(bar);
            this.barriers[side] = bar;

            const halo = makeRibbon(ROAD_SEGS,
                new THREE.MeshBasicMaterial({
                    map: glowTexture(), color: col, transparent: true, opacity: 0.30,
                    blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide
                }));
            this.scene.add(halo);
            this.halos[side] = halo;
        }

        this._buildScenery();
    }

    /* ---------------------------------------------------------------- *
     *  ROADSIDE — the neon city the road runs through.
     *  Lit towers in two depth rows, street lamps whose colour matches
     *  the barrier on their side (cyan left, pink right), advertising
     *  billboards, and overhead gantries that whip past overhead and
     *  sell the speed. Everything is instanced or pooled and recycled
     *  down the road by _placeScenery() — nothing allocates per frame.
     * ---------------------------------------------------------------- */
    _buildScenery() {
        /* city towers: one instanced mesh per facade style */
        this.buildings = facadeTextures().map(tex => {
            const geo = new THREE.BoxGeometry(1, 1, 1);
            geo.translate(0, 0.5, 0);                       // origin at street level
            const m = new THREE.InstancedMesh(geo, new THREE.MeshStandardMaterial({
                map: tex, emissive: '#ffffff', emissiveMap: tex, emissiveIntensity: 0.9,
                roughness: 0.92, metalness: 0.05
            }), 30);
            m.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
            m.frustumCulled = false;
            this.scene.add(m);
            return m;
        });

        /* street lamps: poles, glowing heads, and one Points cloud of halos */
        const poleGeo = new THREE.BoxGeometry(3.4, 80, 3.4);
        poleGeo.translate(0, 40, 0);
        this.lampPoles = new THREE.InstancedMesh(poleGeo,
            new THREE.MeshStandardMaterial({ color: '#101623', roughness: 0.5, metalness: 0.7 }), 36);
        this.lampPoles.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
        this.lampPoles.frustumCulled = false;
        this.scene.add(this.lampPoles);

        this.lampHeads = new THREE.InstancedMesh(new THREE.BoxGeometry(18, 3.2, 5.5),
            new THREE.MeshBasicMaterial({ color: '#ffffff' }), 36);
        this.lampHeads.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
        this.lampHeads.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(36 * 3), 3);
        this.lampHeads.frustumCulled = false;
        this.scene.add(this.lampHeads);

        const lg = new THREE.BufferGeometry();
        this.lampGlowPos = new Float32Array(36 * 3);
        const lgCol = new Float32Array(36 * 4);
        lg.setAttribute('position', new THREE.BufferAttribute(this.lampGlowPos, 3));
        lg.setAttribute('color', new THREE.BufferAttribute(lgCol, 4));
        this.lampGlowGeo = lg;
        const colTmp = new THREE.Color();
        for (let i = 0; i < 36; i++) {
            colTmp.set(i < 18 ? '#00f0ff' : '#ff0055');      // first 18 left, rest right
            this.lampHeads.setColorAt(i, colTmp);
            lgCol[i * 4] = colTmp.r; lgCol[i * 4 + 1] = colTmp.g;
            lgCol[i * 4 + 2] = colTmp.b; lgCol[i * 4 + 3] = 0.85;
        }
        if (this.lampHeads.instanceColor) this.lampHeads.instanceColor.needsUpdate = true;
        this.lampGlow = new THREE.Points(lg, new THREE.PointsMaterial({
            size: 30, map: glowTexture(), vertexColors: true, transparent: true, opacity: 0.5,
            blending: THREE.AdditiveBlending, depthWrite: false, sizeAttenuation: true
        }));
        this.lampGlow.frustumCulled = false;
        this.scene.add(this.lampGlow);

        /* billboards: panel + glowing face on twin legs, alternating sides */
        const signs = signTextures();
        const darkMat = new THREE.MeshStandardMaterial({ color: '#0b101e', roughness: 0.6, metalness: 0.6 });
        this.billboards = [];
        for (let i = 0; i < 8; i++) {
            const grp = new THREE.Group();
            const panel = new THREE.Mesh(new THREE.BoxGeometry(150, 56, 4), darkMat);
            panel.position.y = 86;
            const face = new THREE.Mesh(new THREE.PlaneGeometry(142, 49),
                new THREE.MeshBasicMaterial({ map: signs[i % signs.length] }));
            face.position.set(0, 86, 2.3);
            grp.add(panel, face);
            for (const lx of [-48, 48]) {
                const leg = new THREE.Mesh(new THREE.BoxGeometry(6, 62, 6), darkMat);
                leg.position.set(lx, 30, 0);
                grp.add(leg);
            }
            grp.userData.side = i % 2 === 0 ? -1 : 1;
            this.scene.add(grp);
            this.billboards.push(grp);
        }

        /* overhead gantries: pillars, a beam, its neon strip, and a sign
           hanging over the middle of the road */
        const pillarGeo = new THREE.BoxGeometry(10, 1, 10);
        pillarGeo.translate(0, 0.5, 0);                     // scaled to meet the beam
        this.gPillars = new THREE.InstancedMesh(pillarGeo, darkMat, 10);
        this.gPillars.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
        this.gPillars.frustumCulled = false;
        this.scene.add(this.gPillars);
        this.gBeams = new THREE.InstancedMesh(new THREE.BoxGeometry(580, 10, 9), darkMat, 5);
        this.gBeams.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
        this.gBeams.frustumCulled = false;
        this.scene.add(this.gBeams);
        this.gStrips = new THREE.InstancedMesh(new THREE.BoxGeometry(580, 3, 10),
            new THREE.MeshBasicMaterial({ color: '#ffffff' }), 5);
        this.gStrips.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
        this.gStrips.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(5 * 3), 3);
        this.gStrips.frustumCulled = false;
        for (let i = 0; i < 5; i++) { colTmp.set(i % 2 ? '#ff0055' : '#00f0ff'); this.gStrips.setColorAt(i, colTmp); }
        if (this.gStrips.instanceColor) this.gStrips.instanceColor.needsUpdate = true;
        this.scene.add(this.gStrips);
        this.gSigns = [];
        for (let i = 0; i < 5; i++) {
            const s = new THREE.Mesh(new THREE.PlaneGeometry(126, 42),
                new THREE.MeshBasicMaterial({ map: signs[(i + 2) % signs.length] }));
            this.scene.add(s);
            this.gSigns.push(s);
        }
    }

    /* recycle the roadside down the road, following bend, hill and bank */
    _placeScenery(wrapFn) {
        const d = this.dummy;
        /* towers, in a near row and a taller far row */
        for (let mIdx = 0; mIdx < this.buildings.length; mIdx++) {
            const mesh = this.buildings[mIdx];
            for (let k = 0; k < 30; k++) {
                const gi = mIdx * 30 + k;
                const side = gi % 2 === 0 ? -1 : 1;
                const z = wrapFn(k, 300, 30) + (hash1(gi * 3 + 1) - 0.5) * 170;
                const far = hash1(gi * 3 + 2) > 0.5;
                const xoff = side * (far ? 700 + hash1(gi * 5 + 3) * 340 : 430 + hash1(gi * 5 + 3) * 190);
                d.position.set(this.bendAt(z) + xoff, this.terrainYAt(z, xoff) - 8, z);
                d.rotation.set(0, this.curveYawAt(z) + (hash1(gi * 13 + 7) - 0.5) * 0.35, 0);
                d.scale.set(90 + hash1(gi * 7 + 4) * 80,
                            far ? 210 + hash1(gi * 11 + 6) * 300 : 120 + hash1(gi * 11 + 6) * 190,
                            90 + hash1(gi * 7 + 5) * 80);
                d.updateMatrix();
                mesh.setMatrixAt(k, d.matrix);
            }
            mesh.instanceMatrix.needsUpdate = true;
        }

        /* street lamps in pairs down both shoulders */
        let n = 0;
        for (const side of [-1, 1]) {
            for (let k = 0; k < 18; k++) {
                const z = wrapFn(k, 430, 18);
                const bx = this.bendAt(z), yaw = this.curveYawAt(z);
                const baseY = this.terrainYAt(z, side * 278);
                d.position.set(bx + side * 278, baseY, z);
                d.rotation.set(0, yaw, 0); d.scale.set(1, 1, 1);
                d.updateMatrix();
                this.lampPoles.setMatrixAt(n, d.matrix);
                d.position.set(bx + side * 265, baseY + 79, z);
                d.updateMatrix();
                this.lampHeads.setMatrixAt(n, d.matrix);
                this.lampGlowPos[n * 3] = bx + side * 265;
                this.lampGlowPos[n * 3 + 1] = baseY + 79;
                this.lampGlowPos[n * 3 + 2] = z;
                n++;
            }
        }
        this.lampPoles.instanceMatrix.needsUpdate = true;
        this.lampHeads.instanceMatrix.needsUpdate = true;
        this.lampGlowGeo.attributes.position.needsUpdate = true;

        /* billboards, angled a little toward the traffic */
        for (let k = 0; k < this.billboards.length; k++) {
            const grp = this.billboards[k];
            const side = grp.userData.side;
            const z = wrapFn(k, 980, 8) + (hash1(k * 17 + 2) - 0.5) * 120;
            grp.position.set(this.bendAt(z) + side * 335, this.terrainYAt(z, side * 335) - 3, z);
            grp.rotation.set(0, this.curveYawAt(z) - side * 0.24, 0);
        }

        /* gantries spanning the whole road */
        for (let k = 0; k < 5; k++) {
            const z = wrapFn(k, 1550, 5);
            const bx = this.bendAt(z), yaw = this.curveYawAt(z);
            const bank = this.bankSlopeAt(z);
            const beamY = this.heightAt(z) + 104;
            d.position.set(bx, beamY, z);
            d.rotation.set(this.pitchAt(z), yaw, Math.atan(bank)); d.scale.set(1, 1, 1);
            d.updateMatrix();
            this.gBeams.setMatrixAt(k, d.matrix);
            d.position.set(bx, beamY - 7, z);
            d.updateMatrix();
            this.gStrips.setMatrixAt(k, d.matrix);
            for (const side of [-1, 1]) {
                const baseY = this.terrainYAt(z, side * 272);
                const h = Math.max(20, beamY + bank * (side * 272) - baseY + 4);
                d.position.set(bx + side * 272, baseY - 2, z);
                d.rotation.set(0, yaw, 0); d.scale.set(1, h, 1);
                d.updateMatrix();
                this.gPillars.setMatrixAt(k * 2 + (side > 0 ? 1 : 0), d.matrix);
            }
            const sign = this.gSigns[k];
            sign.position.set(bx + Math.sin(yaw) * 7, beamY - 30, z + Math.cos(yaw) * 7);
            sign.rotation.set(0, yaw, 0);
        }
        this.gBeams.instanceMatrix.needsUpdate = true;
        this.gStrips.instanceMatrix.needsUpdate = true;
        this.gPillars.instanceMatrix.needsUpdate = true;
    }

    /* ---------------------------------------------------------------- */
    _buildPools() {
        /* the player owns two identical cars, one in each livery, so nitro
           can swap the paint without ever building geometry at runtime */
        this._playerCars = [buildCar('f1', '#ff0055'), buildCar('f1', '#00f0ff')];
        this._livery = 0;
        this._playerCars[1].visible = false;
        this.scene.add(this._playerCars[0], this._playerCars[1]);

        this.enemyPool = [];      // { car, key }
        this.bulletPool = [];
        this.starPool = [];
        this.ghostPool = [];

        this.bulletGeo = new THREE.BoxGeometry(6, 6, 26);
        this.bulletMat = new THREE.MeshStandardMaterial({
            color: '#ffea00', emissive: '#ffe066', emissiveIntensity: 3.4, roughness: 0.2
        });

        /* particles: one Points object, rewritten every frame */
        const MAXP = 420;
        this.maxParticles = MAXP;
        const pg = new THREE.BufferGeometry();
        pg.setAttribute('position', new THREE.BufferAttribute(new Float32Array(MAXP * 3), 3));
        pg.setAttribute('color', new THREE.BufferAttribute(new Float32Array(MAXP * 4), 4));
        this.particleGeo = pg;
        this.points = new THREE.Points(pg, new THREE.PointsMaterial({
            size: 7, map: glowTexture(), vertexColors: true, transparent: true,
            blending: THREE.AdditiveBlending, depthWrite: false, sizeAttenuation: true
        }));
        this.points.frustumCulled = false;
        this.scene.add(this.points);

        this._buildEffects();
        this._buildAirStreaks();
    }

    /* ---------------------------------------------------------------- *
     *  nitro: air tearing past the car, down the two outside lanes
     *  Deliberately light: a handful of short streaks out by the edges,
     *  so boosting reads as speed without washing out the middle of the
     *  road where the traffic is.
     * ---------------------------------------------------------------- */
    _buildAirStreaks() {
        const N = 36;
        this.airN = N;
        this.airPos = new Float32Array(N * 6);
        this.airData = [];
        for (let i = 0; i < N; i++) {
            const a = { x: 0, y: 0, z: 0, len: 60, spd: 30 };
            this.airData.push(a);
            this._respawnAir(a, true);
        }
        const g = new THREE.BufferGeometry();
        g.setAttribute('position', new THREE.BufferAttribute(this.airPos, 3));
        this.airGeo = g;
        this.air = new THREE.LineSegments(g, new THREE.LineBasicMaterial({
            color: '#cbf7ff', transparent: true, opacity: 0,
            blending: THREE.AdditiveBlending, depthWrite: false
        }));
        this.air.frustumCulled = false;
        this.air.visible = false;
        this.scene.add(this.air);
        this.airLevel = 0;
        this._airOn = false;
        this._boost = 0;
        this._playerZ = 0;
    }

    _respawnAir(a, spread) {
        const side = Math.random() < 0.5 ? -1 : 1;
        /* side lanes only: the road spans -220..220 and the outer lanes sit
           near +-180, so the streaks run well clear of the racing line */
        a.x = side * (150 + Math.random() * 55);
        a.y = 1 + Math.random() * 22;
        a.z = spread
            ? this._playerZ - 1300 + Math.random() * 1700
            : this._playerZ - 950 - Math.random() * 650;
        a.len = 40 + Math.random() * 60;
        a.spd = 20 + Math.random() * 14;
    }

    _updateAir() {
        const st = this._step || 1;
        const target = this._boost > 0.02 ? 1 : 0;
        this.airLevel += (target - this.airLevel) * (1 - Math.pow(0.84, st));
        if (this.airLevel <= 0.02) {
            if (this._airOn) { this.air.visible = false; this._airOn = false; }
            return;
        }
        if (!this._airOn) {                       // scatter them so nothing pops in
            this._airOn = true;
            for (const a of this.airData) this._respawnAir(a, true);
            this.air.visible = true;
        }
        const L = this.airLevel, pz = this._playerZ, arr = this.airPos;
        for (let i = 0; i < this.airN; i++) {
            const a = this.airData[i];
            a.z += a.spd * (0.45 + L * 1.55) * st;
            if (a.z - pz > 430) { this._respawnAir(a, false); }
            const len = a.len * (0.5 + L * 0.9);
            const o = i * 6;
            /* ride over the hills with the road instead of through them */
            const yA = a.y + this.roadYAt(a.z, a.x);
            const yB = a.y + this.roadYAt(a.z + len, a.x);
            arr[o] = a.x + this.bendAt(a.z);           arr[o + 1] = yA; arr[o + 2] = a.z;
            arr[o + 3] = a.x + this.bendAt(a.z + len); arr[o + 4] = yB; arr[o + 5] = a.z + len;
        }
        this.airGeo.attributes.position.needsUpdate = true;
        this.air.material.opacity = 0.08 + 0.26 * L;
    }

    /* ---------------------------------------------------------------- *
     *  crash effects: liquid spray, ground splats, shock rings, wrecks
     * ---------------------------------------------------------------- */
    _buildEffects() {
        /* airborne droplets — real 3D physics, drawn as one Points cloud */
        const MAXD = 700;
        this.maxDrops = MAXD;
        this.dropV = { x: new Float32Array(MAXD), y: new Float32Array(MAXD), z: new Float32Array(MAXD) };
        this.dropGround = new Float32Array(MAXD);   // road height where each droplet was born
        this.dropLife = new Float32Array(MAXD);
        this.dropMax = new Float32Array(MAXD);
        this.dropRGB = new Float32Array(MAXD * 3);
        this.dropNext = 0;

        const dg = new THREE.BufferGeometry();
        dg.setAttribute('position', new THREE.BufferAttribute(new Float32Array(MAXD * 3), 3));
        dg.setAttribute('color', new THREE.BufferAttribute(new Float32Array(MAXD * 4), 4));
        this.dropGeo = dg;
        this.drops = new THREE.Points(dg, new THREE.PointsMaterial({
            size: 13, map: glowTexture(), vertexColors: true, transparent: true,
            blending: THREE.AdditiveBlending, depthWrite: false, sizeAttenuation: true
        }));
        this.drops.frustumCulled = false;
        this.scene.add(this.drops);

        /* flat splats that bloom across the asphalt where the liquid lands.
           A nuke bursts five cars at once, so this has to be deep enough that
           a live splat is never recycled out from under itself. */
        this.splatPool = [];
        for (let i = 0; i < 30; i++) {
            const m = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), new THREE.MeshBasicMaterial({
                map: glowTexture(), transparent: true, opacity: 0,
                blending: THREE.AdditiveBlending, depthWrite: false
            }));
            m.rotation.x = -Math.PI / 2;
            m.visible = false;
            m.userData.t = 0;
            this.scene.add(m);
            this.splatPool.push(m);
        }

        /* expanding shock rings */
        this.ringPool = [];
        const ringGeo = new THREE.RingGeometry(0.72, 1, 40);
        for (let i = 0; i < 16; i++) {
            const m = new THREE.Mesh(ringGeo, new THREE.MeshBasicMaterial({
                color: '#ffffff', transparent: true, opacity: 0,
                blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide
            }));
            m.rotation.x = -Math.PI / 2;
            m.visible = false;
            m.userData.t = 0;
            this.scene.add(m);
            this.ringPool.push(m);
        }

        /* wrecked cars that tumble, sink and melt into the road */
        this.wreckPool = [];
        this.hitT = 0;
    }

    /* the pool entry closest to the end of its life, so a saturated pool
       restarts the least noticeable effect instead of number 0 */
    _oldest(pool) {
        let best = pool[0];
        for (const p of pool) if ((p.userData.t || 0) > (best.userData.t || 0)) best = p;
        return best;
    }

    /* liquid burst: droplets + splats + a shock ring */
    spawnSplatter(x, z, color, power = 1) {
        const c = new THREE.Color(color);
        const gy = this.roadYAt(z, x - this.bendAt(z));   // the surface it lands on
        const count = Math.round(46 * power);
        for (let i = 0; i < count; i++) {
            const i0 = this.dropNext;
            this.dropNext = (this.dropNext + 1) % this.maxDrops;
            const a = Math.random() * Math.PI * 2;
            const sp = (2.5 + Math.random() * 11) * power;
            this.dropV.x[i0] = Math.cos(a) * sp;
            this.dropV.z[i0] = Math.sin(a) * sp * 0.75 - 3;      // drifts back with the road
            this.dropV.y[i0] = 3.5 + Math.random() * 11 * power;
            const life = 34 + Math.random() * 46;
            this.dropLife[i0] = life;
            this.dropMax[i0] = life;
            const hot = Math.random() < 0.28;                     // white-hot sparks
            this.dropRGB[i0 * 3] = hot ? 1 : Math.min(1, c.r * 1.5 + 0.15);
            this.dropRGB[i0 * 3 + 1] = hot ? 0.95 : Math.min(1, c.g * 1.5 + 0.1);
            this.dropRGB[i0 * 3 + 2] = hot ? 0.8 : Math.min(1, c.b * 1.5 + 0.1);
            this.dropGround[i0] = gy;
            const pos = this.dropGeo.attributes.position.array;
            pos[i0 * 3] = x + (Math.random() - 0.5) * 16;
            pos[i0 * 3 + 1] = gy + 5 + Math.random() * 14;
            pos[i0 * 3 + 2] = z + (Math.random() - 0.5) * 20;
        }
        /* liquid hitting the tarmac */
        for (let i = 0; i < 3 + Math.round(power * 2); i++) {
            const m = this.splatPool.find(s => !s.visible) || this._oldest(this.splatPool);
            m.visible = true;
            m.userData.t = 0;
            m.userData.life = 40 + Math.random() * 30;
            m.userData.size = 26 + Math.random() * 44 * power;
            m.material.color.set(color);
            m.material.opacity = 0.55;
            m.position.set(x + (Math.random() - 0.5) * 90, gy + 0.9, z + (Math.random() - 0.5) * 70);
        }
        /* shock ring */
        const r = this.ringPool.find(s => !s.visible) || this._oldest(this.ringPool);
        r.visible = true;
        r.userData.t = 0;
        r.material.color.set(color);
        r.position.set(x, gy + 1.6, z);
        r.scale.setScalar(12);
    }

    /* a destroyed car: tumbles away, sinks, shrinks, sprays liquid */
    wreck(style, color, x, z, power = 1) {
        const key = style + '|' + color;
        let slot = this.wreckPool.find(w => !w.active && w.key === key)
                || this.wreckPool.find(w => !w.active);
        if (!slot) {
            if (this.wreckPool.length >= 8) {          // recycle the oldest wreck
                slot = this.wreckPool.reduce((a, b) => (a.t > b.t ? a : b));
            } else {
                slot = { key: null, car: null, active: false, t: 0 };
                this.wreckPool.push(slot);
            }
        }
        if (!slot.car || slot.key !== key) {
            if (slot.car) { releaseCar(slot.car); this.scene.remove(slot.car); }
            slot.car = acquireCar(style, color);
            slot.key = key;
            this.scene.add(slot.car);
        }
        slot.active = true;
        slot.t = 0;
        slot.power = power;
        slot.vx = (Math.random() - 0.5) * 3.4;
        slot.vz = -1.5 - Math.random() * 3;
        slot.vy = 5 + Math.random() * 4;
        slot.spinX = (Math.random() - 0.5) * 0.26;
        slot.spinZ = (Math.random() - 0.5) * 0.26;
        slot.spinY = (Math.random() - 0.5) * 0.15;
        const car = slot.car;
        car.visible = true;
        car.scale.setScalar(1);
        const bx = x + this.bendAt(z);
        slot.groundY = this.roadYAt(z, x);
        car.position.set(bx, slot.groundY, z);
        car.rotation.set(0, this.curveYawAt(z), 0);
        this.spawnSplatter(bx, z, color, power);
    }

    /* the player's own impact animation */
    playerHit() { this.hitT = 34; }

    _updateEffects() {
        const st = this._step || 1;
        /* ---- droplets ---- */
        const pos = this.dropGeo.attributes.position.array;
        const col = this.dropGeo.attributes.color.array;
        for (let i = 0; i < this.maxDrops; i++) {
            const life = this.dropLife[i];
            if (life <= 0) { col[i * 4 + 3] = 0; continue; }
            this.dropLife[i] = life - st;
            this.dropV.y[i] -= 0.62 * st;                  // gravity
            this.dropV.x[i] *= Math.pow(0.982, st);
            this.dropV.z[i] *= Math.pow(0.982, st);
            pos[i * 3] += this.dropV.x[i] * st;
            pos[i * 3 + 1] += this.dropV.y[i] * st;
            pos[i * 3 + 2] += this.dropV.z[i] * st;
            const floor = this.dropGround[i] + 0.7;
            if (pos[i * 3 + 1] < floor) {                  // lands: flattens and crawls
                pos[i * 3 + 1] = floor;
                this.dropV.y[i] = -this.dropV.y[i] * 0.22;
                this.dropV.x[i] *= 0.55;
                this.dropV.z[i] *= 0.55;
            }
            const k = this.dropLife[i] / this.dropMax[i];
            col[i * 4] = this.dropRGB[i * 3];
            col[i * 4 + 1] = this.dropRGB[i * 3 + 1];
            col[i * 4 + 2] = this.dropRGB[i * 3 + 2];
            col[i * 4 + 3] = Math.min(1, k * 1.35) * 0.95;
        }
        this.dropGeo.attributes.position.needsUpdate = true;
        this.dropGeo.attributes.color.needsUpdate = true;

        /* ---- ground splats: bloom then fade ---- */
        for (const m of this.splatPool) {
            if (!m.visible) continue;
            m.userData.t += st;
            const k = m.userData.t / m.userData.life;
            if (k >= 1) { m.visible = false; m.material.opacity = 0; continue; }
            const s = m.userData.size * (0.35 + k * 1.25);
            m.scale.set(s, s, 1);
            m.material.opacity = 0.6 * (1 - k) * (1 - k);
        }

        /* ---- shock rings ---- */
        for (const r of this.ringPool) {
            if (!r.visible) continue;
            r.userData.t += st;
            const k = r.userData.t / 26;
            if (k >= 1) { r.visible = false; r.material.opacity = 0; continue; }
            r.scale.setScalar(14 + k * 190);
            r.material.opacity = 0.75 * (1 - k);
        }

        /* ---- wrecked cars ---- */
        for (const w of this.wreckPool) {
            if (!w.active) continue;
            const wasT = w.t;
            w.t += st;
            const car = w.car;
            car.rotation.x += w.spinX * st;
            car.rotation.z += w.spinZ * st;
            car.rotation.y += w.spinY * st;
            w.vy -= 0.85 * st;
            car.position.x += w.vx * st;
            car.position.z += w.vz * st;
            car.position.y += w.vy * st;
            if (car.position.y < (w.groundY || 0)) {       // hits the road, loses energy
                car.position.y = w.groundY || 0;
                w.vy = -w.vy * 0.3;
                w.spinX *= 0.7; w.spinZ *= 0.7; w.spinY *= 0.7;
                w.vx *= 0.7; w.vz *= 0.7;
            }
            if (w.t < 20 && Math.floor(wasT / 4) !== Math.floor(w.t / 4)) {   // liquid streaming off the wreck
                const c = car.userData.handle.color;
                this.spawnSplatter(car.position.x, car.position.z, c, 0.35);
            }
            const k = w.t / 46;
            car.scale.setScalar(Math.max(0.06, 1 - k * 0.9));
            if (k >= 1) {
                w.active = false;
                car.visible = false;
                car.scale.setScalar(1);
            }
        }
    }

    /* ---------------------------------------------------------------- */
    resize() {
        const w = this.canvas.clientWidth || window.innerWidth;
        const h = this.canvas.clientHeight || window.innerHeight;
        this.renderer.setSize(w, h, false);
        this.aspect = w / h;
        /* re-aim the rig for the shape of the screen: portrait keeps the
           tuning above, landscape swaps in the wide rig */
        const t = camBlend(this.aspect);
        for (const k of CAM_KEYS) CAM[k] = CAM_TALL[k] + (CAM_WIDE[k] - CAM_TALL[k]) * t;
        this.camera.aspect = this.aspect;
        this.camera.fov = CAM.fov;
        this.camera.updateProjectionMatrix();
    }

    /* ---------------------------------------------------------------- *
     *  per-frame sync
     * ---------------------------------------------------------------- */
    /* ---- where the road is, relative to the car ---- */
    roadSAt(z) { return this.roadOffset + NEAR_Z - z; }      // absolute distance at world z
    /* where the road is under the car's own wheels, and which way it points
       there. Everything is measured against this rather than the world axes,
       because the camera rides with the car. */
    _syncCurve() {
        if (this._c0off === this.roadOffset && this._c0z === this._playerZ &&
            this._cgen === CURVE_GEN) return;
        this._c0off = this.roadOffset; this._c0z = this._playerZ; this._cgen = CURVE_GEN;
        this._s0 = this.roadOffset + NEAR_Z - this._playerZ;
        this._centre0 = centreAt(this._s0);
        this._slope0 = slopeAt(this._s0);
        this._elev0 = elevAt(this._s0);
        this._grade0 = gradeAt(this._s0);
    }
    /* Where the road runs, as a thing of its own: the centreline out there
       minus the centreline under the car, and nothing else. It is NOT measured
       against the car, so a car that is going straight does not stay on the
       road -- the road curves away beneath it and the driver has to answer
       with the wheel. Measuring it against the car (which is what it used to
       do) glued the car to the centreline: that was the car following the
       lines with nobody steering. */
    bendAt(z) {
        this._syncCurve();
        return centreAt(this.roadSAt(z)) - this._centre0;
    }
    /* which way the road points at z. The camera holds its line rather than
       swinging along the bend, so this is simply the road's own heading. */
    curveYawAt(z) {
        this._syncCurve();
        return Math.atan(slopeAt(this.roadSAt(z)));
    }
    /* where the centreline is under the car, in world units. script.js watches
       this: a car going straight keeps its own line while this slides away
       from it, and that slide is what walks you into the barrier. */
    centreUnderCar() { this._syncCurve(); return this._centre0; }

    /* Road height at z, measured the same car-relative way as the bend:
       the elevation there minus the car's own height *and* its tangent
       plane, so the tarmac is always dead flat and level under the car
       (the camera pitches with the car, in effect) while crests rise
       and dips fall away ahead and behind. */
    heightAt(z) {
        this._syncCurve();
        const S = this.roadSAt(z);
        return elevAt(S) - this._elev0 - this._grade0 * (S - this._s0);
    }
    /* the road's pitch at z relative to the car's own plane */
    pitchAt(z) {
        this._syncCurve();
        return Math.atan(gradeAt(this.roadSAt(z)) - this._grade0);
    }
    /* cross-slope of the tarmac at z: banked into the bend, outside up.
       A right turn (heading rotating toward +x) drops the right edge. */
    bankSlopeAt(z) {
        const b = -bendRateAt(this.roadSAt(z)) * BANK_GAIN;
        return Math.max(-BANK_MAX, Math.min(BANK_MAX, b));
    }
    /* height of the drivable surface xoff from the centreline at z */
    roadYAt(z, xoff = 0) { return this.heightAt(z) + this.bankSlopeAt(z) * xoff; }
    /* ground level off the road: the bank's influence fades with
       distance and the terrain falls gently away from the shoulder,
       which is where lamps, boards and buildings stand */
    terrainYAt(z, xoff) {
        const clamped = Math.max(-260, Math.min(260, xoff));
        return this.heightAt(z) + this.bankSlopeAt(z) * clamped -
               Math.max(0, Math.abs(xoff) - 250) * 0.055;
    }
    /* the actual grade under the car (rise per unit forward) — the one
       absolute number script.js needs, to turn hills into gravity */
    roadGrade() { this._syncCurve(); return this._grade0; }

    /* rebuild the tarmac, the barriers and their glow along the current
       bend — over its crests now, and banked into its corners, with the
       terrain aprons falling away either side */
    _shapeRoad() {
        const N = ROAD_SEGS;
        const rp = this.roadRibbon.geometry.attributes.position.array;
        const bl = this.barriers[-1].geometry.attributes.position.array;
        const br = this.barriers[1].geometry.attributes.position.array;
        const hl = this.halos[-1].geometry.attributes.position.array;
        const hr = this.halos[1].geometry.attributes.position.array;
        const al = this.aprons[-1].geometry.attributes.position.array;
        const ar = this.aprons[1].geometry.attributes.position.array;
        const el = this.edgeLines[-1].geometry.attributes.position.array;
        const er = this.edgeLines[1].geometry.attributes.position.array;
        for (let i = 0; i <= N; i++) {
            const z = NEAR_Z - (i / N) * SPAN;
            const c = this.bendAt(z);
            const hC = this.heightAt(z), bS = this.bankSlopeAt(z);
            const yAt = (off) => hC + bS * off;         // surface height off centre
            const o = i * 6;
            rp[o] = c - ROAD_HALF;      rp[o + 1] = yAt(-ROAD_HALF); rp[o + 2] = z;
            rp[o + 3] = c + ROAD_HALF;  rp[o + 4] = yAt(ROAD_HALF); rp[o + 5] = z;
            /* solid edge lines just inside the kerbs */
            el[o] = c - 207; el[o + 1] = yAt(-207) + 0.28; el[o + 2] = z;
            el[o + 3] = c - 201; el[o + 4] = yAt(-201) + 0.28; el[o + 5] = z;
            er[o] = c + 201; er[o + 1] = yAt(201) + 0.28; er[o + 2] = z;
            er[o + 3] = c + 207; er[o + 4] = yAt(207) + 0.28; er[o + 5] = z;
            /* barrier walls stand on the road edge: bottom vertex, then top */
            bl[o] = c - ROAD_HALF - 2;  bl[o + 1] = yAt(-222); bl[o + 2] = z;
            bl[o + 3] = c - ROAD_HALF - 2; bl[o + 4] = yAt(-222) + 7; bl[o + 5] = z;
            br[o] = c + ROAD_HALF + 2;  br[o + 1] = yAt(222); br[o + 2] = z;
            br[o + 3] = c + ROAD_HALF + 2; br[o + 4] = yAt(222) + 7; br[o + 5] = z;
            /* and the glow pooling just outside them */
            hl[o] = c - ROAD_HALF - 15; hl[o + 1] = yAt(-235) + 2; hl[o + 2] = z;
            hl[o + 3] = c - ROAD_HALF - 55; hl[o + 4] = yAt(-275) + 2; hl[o + 5] = z;
            hr[o] = c + ROAD_HALF + 15; hr[o + 1] = yAt(235) + 2; hr[o + 2] = z;
            hr[o + 3] = c + ROAD_HALF + 55; hr[o + 4] = yAt(275) + 2; hr[o + 5] = z;
            /* terrain aprons: road edge out to the dark */
            al[o] = c - 1500; al[o + 1] = this.terrainYAt(z, -1500) - 0.8; al[o + 2] = z;
            al[o + 3] = c - ROAD_HALF; al[o + 4] = yAt(-ROAD_HALF) - 0.6; al[o + 5] = z;
            ar[o] = c + ROAD_HALF; ar[o + 1] = yAt(ROAD_HALF) - 0.6; ar[o + 2] = z;
            ar[o + 3] = c + 1500; ar[o + 4] = this.terrainYAt(z, 1500) - 0.8; ar[o + 5] = z;
        }
        for (const m of [this.roadRibbon, this.barriers[-1], this.barriers[1],
                         this.halos[-1], this.halos[1], this.aprons[-1], this.aprons[1],
                         this.edgeLines[-1], this.edgeLines[1]])
            m.geometry.attributes.position.needsUpdate = true;
    }

    scrollRoad(roadOffset, step = 1) {
        this.roadOffset = roadOffset;
        this._step = step;
        this._syncCurve();
        this.asphalt.offset.y = roadOffset / 230;
        this._shapeRoad();
        const d = this.dummy;
        const wrap = (i, spacing, count) => {
            const total = spacing * count;
            return (((i * spacing + roadOffset) % total) + total) % total - total + NEAR_Z;
        };

        /* lane dashes on the actual lane boundaries — midway between the
           five lanes traffic drives in — laid over hill and bank */
        let n = 0;
        for (const x of [-128, -28, 72, 157])
            for (let i = 0; i < 36; i++) {
                const dz = wrap(i, 165, 36);
                d.position.set(x + this.bendAt(dz), this.roadYAt(dz, x) + 0.4, dz);
                d.rotation.set(this.pitchAt(dz), this.curveYawAt(dz), Math.atan(this.bankSlopeAt(dz)));
                d.scale.set(1, 1, 1);
                d.updateMatrix();
                this.dashes.setMatrixAt(n++, d.matrix);
            }
        this.dashes.instanceMatrix.needsUpdate = true;

        /* rumble kerbs, alternating colour */
        n = 0;
        for (const side of [-1, 1]) {
            for (let i = 0; i < 96; i++) {
                const kz = wrap(i, 60, 96);
                d.position.set(side * (ROAD_HALF - 6) + this.bendAt(kz),
                               this.roadYAt(kz, side * (ROAD_HALF - 6)) + 1.2, kz);
                d.rotation.set(this.pitchAt(kz), this.curveYawAt(kz), Math.atan(this.bankSlopeAt(kz)));
                d.scale.set(1, 1, 1);
                d.updateMatrix();
                this.kerbs.setMatrixAt(n, d.matrix);
                const on = (i % 2 === 0);
                this.color.set(side < 0 ? (on ? '#00f0ff' : '#0b1622') : (on ? '#ff0055' : '#1a0a12'));
                this.kerbs.setColorAt(n, this.color);
                n++;
            }
        }
        this.kerbs.instanceMatrix.needsUpdate = true;
        if (this.kerbs.instanceColor) this.kerbs.instanceColor.needsUpdate = true;

        /* marker posts down both shoulders */
        n = 0;
        for (const side of [-1, 1]) {
            for (let i = 0; i < 32; i++) {
                const pz = wrap(i, 240, 32);
                d.position.set(side * (ROAD_HALF + 26) + this.bendAt(pz),
                               this.terrainYAt(pz, side * (ROAD_HALF + 26)) + 15, pz);
                d.rotation.set(0, this.curveYawAt(pz), 0); d.scale.set(1, 1, 1);
                d.updateMatrix();
                this.posts.setMatrixAt(n, d.matrix);
                this.color.set(side < 0 ? '#00f0ff' : '#ff0055');
                this.posts.setColorAt(n, this.color);
                n++;
            }
        }
        this.posts.instanceMatrix.needsUpdate = true;
        if (this.posts.instanceColor) this.posts.instanceColor.needsUpdate = true;

        /* the city along the road */
        this._placeScenery(wrap);
    }

    /* which painted car is on screen right now */
    get playerCar() { return this._playerCars[this._livery]; }
    setPlayerLivery(nitro) {
        const n = nitro ? 1 : 0;
        if (n === this._livery) return;
        this._playerCars[this._livery].visible = false;
        this._livery = n;
        this._playerCars[n].visible = true;
    }

    /* ---------------------------------------------------------------- */
    setPlayer(x, z, opts) {
        this.setPlayerLivery((opts.boost || 0) > 0.02);
        const car = this.playerCar;
        car.visible = true;
        /* the car sits on the surface: banked plane included, so out at
           the edge of a banked bend it rides up the banking with the road */
        car.position.set(x, this.roadYAt(z, x), z);
        const h = car.userData.handle;
        /* Full base pose every frame. rotation.x used to be touched only by the
           crash animation below, so every crash added its tumble to the last one
           and the car drove around permanently nose-up. */
        /* Only the player's steering turns this car. It used to be yawed to
           match the road as well, which looked like the car steering itself
           into every bend; the driver is meant to do that. On top of the
           steering sit the physics body motions script.js works out:
           pitch as the nose rises under power and dives under braking,
           roll as the body leans out of a corner, and slip yaw when the
           tyres are sliding. The whole lot also rolls with the banking. */
        car.rotation.set(opts.pitch || 0,
                         -(opts.steer || 0) * 0.10 + (opts.slip || 0),
                         Math.atan(this.bankSlopeAt(z)) + (opts.roll || 0));
        h.setBrake(opts.brake || 0);
        h.setBoost(opts.boost || 0);
        this._boost = opts.boost || 0;
        this._playerZ = z;
        h.spinWheels(opts.phase, -(opts.steer || 0));
        if (opts.boost > 0.02) {
            const f = 0.75 + Math.random() * 0.5;
            h.flames.forEach(fl => fl.scale.set(0.8, f, 0.8));
        }
        /* ghost mode: the game decides the blink, we just hide the car */
        car.visible = !opts.hidden;
        /* impact animation: the player's car is thrown into a spin */
        if (this.hitT > 0) {
            const n = 34 - this.hitT;
            const w = (this.hitT / 34) * (this.hitT / 34);
            car.rotation.y += Math.sin(n * 0.55) * 0.9 * w;
            car.rotation.z += Math.sin(n * 0.8) * 0.32 * w;
            car.rotation.x += Math.sin(n * 0.45) * 0.16 * w;
            car.position.y += Math.abs(Math.sin(n * 0.5)) * 6 * w;
            this.hitT -= (this._step || 1);
        }
        /* ---- chase camera: fixed rig that follows the car sideways ----
           Still NOT tied to nitro: the livery swaps to cyan under boost
           and a switched camera move at that same moment read as the
           camera "changing with the colour". What it does follow now is
           speed itself, continuously — the view widens a touch and sits
           a little further back the faster you go, easing in and out
           with the speedo rather than snapping with the boost button.
           At a standstill it is exactly the old rig. */
        const skT = Math.max(0, Math.min(1, opts.speed01 || 0));
        this._speedK = this._speedK === undefined ? skT
            : this._speedK + (skT - this._speedK) * (1 - Math.pow(0.94, this._step || 1));
        const fovEff = CAM.fov + this._speedK * 4.5;
        if (Math.abs(this.camera.fov - fovEff) > 0.01) {
            this.camera.fov = fovEff;
            this.camera.updateProjectionMatrix();
        }
        const camYE = CAM.camY + this._speedK * 7;
        const camZE = CAM.camZ + this._speedK * 20;
        /* Follow by CAM.follow, but never let the car slide off the edge of a
           very narrow screen: clamp how far the car may sit from the camera
           axis to what the current aspect can actually show. */
        const halfExtent = Math.tan(fovEff * Math.PI / 360) * this.aspect * camZE;
        const limit = Math.max(0, halfExtent * 0.92 - CAR.W * 0.5 - 4);
        const off = Math.max(-limit, Math.min(limit, x * (1 - CAM.follow)));
        const cx = x - off;
        /* a breath of lag in the follow, so a quick lane change moves the
           car in the frame for a moment instead of the whole world sliding
           rigidly with it; it settles back to dead centre straight away */
        this._camX = this._camX === undefined ? cx
            : this._camX + (cx - this._camX) * (1 - Math.pow(0.78, this._step || 1));
        const ccx = this._camX;
        this.camera.position.set(ccx + this.camShake.x, camYE + this.camShake.y, z + camZE);
        /* The camera sits on the car and holds its line: it is never aimed
           down the bend, so the car runs dead centre and it is the road
           that snakes across the screen, the way an arcade racer does.
           Swinging the camera to follow the bend made the car slide about
           and read as the car steering itself. */
        this.camera.lookAt(ccx, CAM.lookY, z + CAM.lookZ);
    }

    /* ---------------------------------------------------------------- */
    syncEnemies(list, speed, playerZ) {
        for (let i = 0; i < list.length; i++) {
            const e = list[i];
            const key = e.style + '|' + e.color;
            let slot = this.enemyPool[i];
            if (!slot || slot.key !== key) {
                if (slot) { releaseCar(slot.car); this.scene.remove(slot.car); }
                const car = acquireCar(e.style, e.color);
                car.visible = true;
                this.scene.add(car);
                slot = this.enemyPool[i] = { car, key };
            }
            const car = slot.car;
            /* past the fog a car is 100% fogged, so there is nothing to draw:
               skipping it keeps 18 cars on the road cheap on a phone GPU */
            car.visible = (playerZ - e.wz) + 320 < VIEW_FAR;
            car.position.set(e.wx + this.bendAt(e.wz), this.roadYAt(e.wz, e.wx), e.wz);
            const h = car.userData.handle;
            /* brake lights for real now: the driver ahead is braking for
               the car in front of them — or, as before, for you closing in */
            const braking = e.brake ? 1 : (speed > 120 && e.wz < playerZ && playerZ - e.wz < 300) ? 1 : 0;
            h.setBrake(braking);
            h.setBoost(0);
            h.spinWheels(e.travel !== undefined ? e.travel : e.phase, e.steer || 0);
            car.rotation.set(this.pitchAt(e.wz), -(e.steer || 0) * 0.16 + this.curveYawAt(e.wz),
                             Math.atan(this.bankSlopeAt(e.wz)) - (e.steer || 0) * 0.03);
            car.scale.setScalar(1);
        }
        for (let i = list.length; i < this.enemyPool.length; i++) {
            const slot = this.enemyPool[i];
            if (slot) { slot.car.visible = false; }
        }
    }

    /* ---------------------------------------------------------------- */
    syncBullets(list) {
        for (let i = 0; i < list.length; i++) {
            let m = this.bulletPool[i];
            if (!m) {
                m = new THREE.Mesh(this.bulletGeo, this.bulletMat);
                /* additive halo so the tracer reads against the dark road */
                const halo = new THREE.Mesh(new THREE.PlaneGeometry(46, 46),
                    new THREE.MeshBasicMaterial({
                        map: glowTexture(), color: '#ffea00', transparent: true, opacity: 0.8,
                        blending: THREE.AdditiveBlending, depthWrite: false
                    }));
                m.add(halo);
                m.userData.halo = halo;
                this.bulletPool[i] = m;
                this.scene.add(m);
            }
            m.visible = true;
            m.position.set(list[i].wx + this.bendAt(list[i].wz), 12 + this.roadYAt(list[i].wz, list[i].wx), list[i].wz);
            m.userData.halo.quaternion.copy(this.camera.quaternion);   // billboard
        }
        for (let i = list.length; i < this.bulletPool.length; i++) this.bulletPool[i].visible = false;
    }

    /* ---------------------------------------------------------------- */
    _starMesh(i) {
        if (this.starPool[i]) return this.starPool[i];
        const shape = new THREE.Shape();
        for (let k = 0; k < 10; k++) {
            const r = k % 2 ? 7 : 17;
            const a = (18 + k * 36) * Math.PI / 180;
            const x = Math.cos(a) * r, y = Math.sin(a) * r;
            k === 0 ? shape.moveTo(x, y) : shape.lineTo(x, y);
        }
        shape.closePath();
        const geo = new THREE.ExtrudeGeometry(shape, {
            depth: 4, bevelEnabled: true, bevelThickness: 1.2, bevelSize: 1.2, bevelSegments: 1, steps: 1
        });
        geo.center();
        const mesh = new THREE.Mesh(geo, new THREE.MeshStandardMaterial({
            color: '#ffea00', emissive: '#ffea00', emissiveIntensity: 1.7, metalness: 0.7, roughness: 0.25
        }));
        const halo = new THREE.Mesh(new THREE.PlaneGeometry(70, 70), new THREE.MeshBasicMaterial({
            map: glowTexture(), color: '#ffea00', transparent: true, opacity: 0.5,
            blending: THREE.AdditiveBlending, depthWrite: false
        }));
        mesh.add(halo);
        this.scene.add(mesh);
        this.starPool[i] = mesh;
        return mesh;
    }

    syncStars(list, phase) {
        for (let i = 0; i < list.length; i++) {
            const s = list[i];
            const m = this._starMesh(i);
            m.visible = true;
            m.position.set(s.wx + this.bendAt(s.wz), 26 + this.roadYAt(s.wz, s.wx), s.wz);
            m.rotation.y = phase * 0.05 + i;
            m.rotation.z = Math.sin(phase * 0.05) * 0.2;
            m.children[0].quaternion.copy(this.camera.quaternion);   // billboard halo
        }
        for (let i = list.length; i < this.starPool.length; i++) this.starPool[i].visible = false;
    }

    /* ---------------------------------------------------------------- */
    syncParticles(list) {
        const pos = this.particleGeo.attributes.position.array;
        const col = this.particleGeo.attributes.color.array;
        const n = Math.min(list.length, this.maxParticles);
        for (let i = 0; i < n; i++) {
            const p = list[i];
            pos[i * 3] = p.wx + this.bendAt(p.wz); pos[i * 3 + 1] = p.wy + this.roadYAt(p.wz, p.wx); pos[i * 3 + 2] = p.wz;
            col[i * 4] = p.r; col[i * 4 + 1] = p.g; col[i * 4 + 2] = p.b; col[i * 4 + 3] = p.a;
        }
        this.particleGeo.setDrawRange(0, n);
        this.particleGeo.attributes.position.needsUpdate = true;
        this.particleGeo.attributes.color.needsUpdate = true;
    }

    /* ---------------------------------------------------------------- */
    /* Built per slot, NOT cached by name: two rivals called the same thing
       used to share one sprite, and a slot kept a previous player's tag when
       the opponent list reordered. */
    _labelSprite(name, color) {
        const c = document.createElement('canvas');
        c.width = 256; c.height = 64;
        const g = c.getContext('2d');
        g.fillStyle = 'rgba(0,0,0,0.66)';
        g.strokeStyle = color; g.lineWidth = 3;
        g.beginPath();
        if (g.roundRect) g.roundRect(4, 8, 248, 48, 12); else g.rect(4, 8, 248, 48);
        g.fill(); g.stroke();
        g.font = 'bold 30px Segoe UI, Roboto, sans-serif';
        g.fillStyle = '#ffffff'; g.textAlign = 'center'; g.textBaseline = 'middle';
        g.fillText(name.slice(0, 12), 128, 33);
        const tex = new THREE.CanvasTexture(c);
        tex.colorSpace = THREE.SRGBColorSpace;
        return new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, transparent: true, depthTest: false }));
    }

    syncGhosts(list, phase) {
        for (let i = 0; i < list.length; i++) {
            const g = list[i];
            const key = g.style + '|' + g.color;
            let slot = this.ghostPool[i];
            if (!slot || slot.key !== key) {
                if (slot) { this._restoreMats(slot); releaseCar(slot.car); this.scene.remove(slot.car); }
                const car = acquireCar(g.style, g.color);
                this.scene.add(car);
                /* Rival cars are projections of another player, so they are
                   drawn semi-transparent. Their materials are shared with
                   traffic, so they are cloned per slot and put back on the
                   way out. The brake-light material stays original: the car's
                   handle drives it. */
                slot = this.ghostPool[i] = { car, key, swaps: this._makeGhostly(car) };
            }
            const car = slot.car;
            car.visible = true;
            const gy = this.roadYAt(g.wz, g.wx - this.bendAt(g.wz));
            car.position.set(g.wx, gy, g.wz);
            car.rotation.set(this.pitchAt(g.wz), -(g.steer || 0) * 0.12, Math.atan(this.bankSlopeAt(g.wz)));
            car.scale.setScalar(1);
            const h = car.userData.handle;
            h.setBrake(0); h.setBoost(0);
            h.spinWheels(phase, g.steer || 0);

            /* the name tag belongs to whoever is in this slot right now */
            if (!slot.label || slot.name !== g.name) {
                if (slot.label) { this.scene.remove(slot.label); slot.label.material.map.dispose(); slot.label.material.dispose(); }
                slot.label = this._labelSprite(g.name, g.color);
                slot.label.scale.set(70, 17.5, 1);
                this.scene.add(slot.label);
                slot.name = g.name;
            }
            slot.label.visible = true;
            slot.label.position.set(g.wx, 62 + gy, g.wz);
            slot.label.material.opacity = 0.9;
        }
        for (let i = list.length; i < this.ghostPool.length; i++) {
            const slot = this.ghostPool[i];
            if (slot) { slot.car.visible = false; if (slot.label) slot.label.visible = false; }
        }
    }

    /* swap a car's shared materials for semi-transparent clones */
    _makeGhostly(car) {
        const swaps = [];
        car.traverse(o => {
            if (!o.material || o.userData.brakeLight) return;
            const c = o.material.clone();
            c.transparent = true;
            c.opacity = (o.material.opacity === undefined ? 1 : o.material.opacity) * 0.5;
            c.depthWrite = false;
            swaps.push([o, o.material]);
            o.material = c;
        });
        return swaps;
    }
    _restoreMats(slot) {
        for (const [o, orig] of (slot.swaps || [])) { o.material.dispose(); o.material = orig; }
        slot.swaps = null;
    }

    /* ---------------------------------------------------------------- */
    addShake(amount) {
        if (amount > 0) {
            this.camShake.set((Math.random() - 0.5) * amount, (Math.random() - 0.5) * amount, 0);
        } else {
            this.camShake.multiplyScalar(0.86);
            if (this.camShake.length() < 0.05) this.camShake.set(0, 0, 0);
        }
    }

    render() {
        this._updateEffects();
        this._updateAir();
        this.renderer.render(this.scene, this.camera);
    }
}

/* world coordinates helpers used by script.js (old screen px -> 3D) */
export const SCREEN_CENTRE_X = 240;
export const PLAYER_SCREEN_Y = 690;
export const wx = (screenX) => screenX - SCREEN_CENTRE_X;
export const wz = (screenY) => screenY - PLAYER_SCREEN_Y;
