/* =============================================================================
   car3d.js — procedural low-poly car meshes for NEON DRIVE (three.js)
   -----------------------------------------------------------------------------
   Builds real 3D cars out of geometry: an extruded, bevelled body shell, a
   glazed cabin, roof panel, wheels with rims, rear wing, lamps, exhausts,
   neon edge lines and an underglow decal.

   Footprint matches the collision box: 44 wide x 85 long, origin at the
   centre of the footprint, y = 0 on the road. Nothing here touches gameplay.

   Every geometry is built once per body style and shared by all cars of that
   style, so spawning traffic never allocates geometry.
   ============================================================================= */

import * as THREE from 'three';

export const CAR = { W: 44, L: 85 };

/* ------------------------------------------------------------------ *
 *  colour helpers
 * ------------------------------------------------------------------ */
const _c = new THREE.Color();
function mixHex(a, b, t) {
    return '#' + _c.set(a).lerp(new THREE.Color(b), t).getHexString();
}
const lighten = (c, t) => mixHex(c, '#ffffff', t);
const darken = (c, t) => mixHex(c, '#000000', t);

/* ------------------------------------------------------------------ *
 *  body profiles — half-width (x) sampled along the length (z)
 *  z: -42.5 = nose, +42.5 = tail
 * ------------------------------------------------------------------ */
const STYLES = {
    sports: {
        bodyH: 11.5, body: [[-42.5, 13.5], [-33, 19.0], [-16, 21.4], [4, 22.0], [24, 21.6], [36, 20.4], [42.5, 17.5]],
        cabinH: 8.5, cabin: [[-16, 11], [-10, 13.8], [10, 15.4], [26, 14.4]], roof: 0.80,
        wheelR: 8.6, wheelW: 6.2, wheelZ: 26, wing: 'gt', lights: 'blade', exhaust: [-7.5, 7.5]
    },
    sedan: {
        bodyH: 13.5, body: [[-42.5, 14.5], [-33, 19.2], [-16, 21.0], [4, 21.6], [24, 21.2], [36, 20.2], [42.5, 18.0]],
        cabinH: 12.0, cabin: [[-14, 11.6], [-8, 14.4], [12, 15.4], [30, 14.2]], roof: 0.86,
        wheelR: 9.0, wheelW: 5.8, wheelZ: 25, wing: 'duck', lights: 'block', exhaust: [8.5]
    },
    coupe: {
        bodyH: 11.0, body: [[-42.5, 13.0], [-33, 18.2], [-16, 20.4], [4, 21.0], [24, 20.4], [36, 19.2], [42.5, 16.5]],
        cabinH: 8.0, cabin: [[-12, 10.8], [-6, 13.2], [10, 14.6], [24, 13.4]], roof: 0.78,
        wheelR: 8.4, wheelW: 5.6, wheelZ: 24, wing: 'none', lights: 'round', exhaust: [8.5]
    },
    van: {
        bodyH: 18.0, body: [[-42.5, 16.0], [-34, 20.4], [-16, 21.6], [4, 22.0], [24, 21.8], [36, 21.2], [42.5, 20.0]],
        cabinH: 13.0, cabin: [[-24, 12.4], [-20, 15.6], [22, 16.6], [34, 16.0]], roof: 0.92,
        wheelR: 9.6, wheelW: 6.6, wheelZ: 27, wing: 'rack', lights: 'column', exhaust: []
    }
};

/* closed shape from a half-outline; shape +Y = car forward (-z in world) */
function shapeFromHalf(half) {
    const s = new THREE.Shape();
    s.moveTo(half[0][1], -half[0][0]);
    for (let i = 1; i < half.length; i++) s.lineTo(half[i][1], -half[i][0]);
    for (let i = half.length - 1; i >= 0; i--) s.lineTo(-half[i][1], -half[i][0]);
    s.closePath();
    return s;
}

function extrude(shape, height, bevel) {
    const g = new THREE.ExtrudeGeometry(shape, {
        depth: Math.max(0.1, height - bevel * 2),
        bevelEnabled: true, bevelThickness: bevel, bevelSize: bevel * 0.85,
        bevelSegments: 2, curveSegments: 1, steps: 1
    });
    g.rotateX(-Math.PI / 2);          // shape plane -> road plane, extrusion -> up
    g.translate(0, bevel, 0);
    g.computeVertexNormals();
    return g;
}

/* Merge small parts that share a material into one mesh. Six cars on screen
   means every mesh is a draw call, so this keeps the count (and battery)
   down. Geometries are merged once, at cache time. */
const _m4 = new THREE.Matrix4(), _q = new THREE.Quaternion(), _e = new THREE.Euler();
function mergeGeos(items) {
    const prepped = items.map(it => {
        const g = it.g.index ? it.g.toNonIndexed() : it.g.clone();
        _q.setFromEuler(_e.set(...(it.r || [0, 0, 0])));
        _m4.compose(new THREE.Vector3(...(it.p || [0, 0, 0])), _q,
                    new THREE.Vector3(...(it.s || [1, 1, 1])));
        g.applyMatrix4(_m4);
        if (!g.attributes.normal) g.computeVertexNormals();
        return g;
    });
    let total = 0;
    for (const g of prepped) total += g.attributes.position.count;
    const pos = new Float32Array(total * 3), nor = new Float32Array(total * 3);
    let o = 0;
    for (const g of prepped) {
        pos.set(g.attributes.position.array, o);
        nor.set(g.attributes.normal.array, o);
        o += g.attributes.position.count * 3;
        g.dispose();
    }
    const out = new THREE.BufferGeometry();
    out.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    out.setAttribute('normal', new THREE.BufferAttribute(nor, 3));
    return out;
}

/* ------------------------------------------------------------------ *
 *  geometry + part table, built once per style
 * ------------------------------------------------------------------ */
const geoCache = {};
function partsFor(style) {
    if (geoCache[style]) return geoCache[style];
    const S = STYLES[style];

    const body = extrude(shapeFromHalf(S.body), S.bodyH, 1.6);
    const cabin = extrude(shapeFromHalf(S.cabin), S.cabinH, 1.1);
    const roof = extrude(shapeFromHalf(S.cabin.map(p => [p[0], p[1] * S.roof])), 1.8, 0.5);

    const wheel = new THREE.CylinderGeometry(S.wheelR, S.wheelR, S.wheelW, 14, 1);
    wheel.rotateZ(Math.PI / 2);
    const rim = new THREE.CylinderGeometry(S.wheelR * 0.55, S.wheelR * 0.55, S.wheelW + 0.6, 10, 1);
    rim.rotateZ(Math.PI / 2);

    /* ---- static body panels ---- */
    const groups = {};                       // material key -> parts
    const add = (m, g, p, r, s) => {
        (groups[m] || (groups[m] = [])).push({ g, p, r, s });
    };
    add('body', body);
    add('lower', body, null, null, [1.015, 0.42, 0.985]);
    add('glass', cabin, [0, S.bodyH, 0]);
    add('roof', roof, [0, S.bodyH + S.cabinH - 1.2, 0]);

    /* ---- rear wing / roof rack ---- */
    if (S.wing === 'gt') {
        add('trim', new THREE.BoxGeometry(41, 1.4, 7), [0, S.bodyH + 8.5, 40]);
        for (const sx of [-1, 1]) {
            add('trim', new THREE.BoxGeometry(1.8, 8.5, 3.2), [sx * 13, S.bodyH + 4.25, 39]);
            add('lower', new THREE.BoxGeometry(1.2, 7, 8), [sx * 20.2, S.bodyH + 7.5, 40]);
        }
    } else if (S.wing === 'duck') {
        add('trim', new THREE.BoxGeometry(38, 1.4, 5), [0, S.bodyH + 4.0, 40]);
    } else if (S.wing === 'rack') {
        add('trim', new THREE.BoxGeometry(30, 1.6, 5), [0, S.bodyH + S.cabinH + 1.0, -14]);
        for (let i = -1; i <= 1; i++)
            add('head', new THREE.BoxGeometry(3.4, 2.2, 2), [i * 11, S.bodyH + S.cabinH + 2.4, -14]);
    }

    /* ---- head lamps ---- */
    for (const sx of [-1, 1])
        add('head', new THREE.BoxGeometry(9, 2.6, 1.4), [sx * 11, S.bodyH * 0.60, -42.2]);

    /* ---- exhaust tips ---- */
    for (const x of S.exhaust)
        add('rim', new THREE.CylinderGeometry(1.8, 1.8, 3, 8), [x, S.bodyH * 0.30, 42.5], [Math.PI / 2, 0, 0]);

    /* one mesh per material */
    const parts = [];
    for (const m in groups) {
        const list = groups[m];
        parts.push(list.length === 1
            ? { g: list[0].g, m, p: list[0].p, r: list[0].r, s: list[0].s }
            : { g: mergeGeos(list), m });
    }

    /* ---- tail lamps: geometry cached, material per car (brakes) ---- */
    const tailItems = [];
    const tailY = S.bodyH * 0.62, tailZ = 42.0;
    if (S.lights === 'blade') {
        for (const sx of [-1, 1]) tailItems.push({ g: new THREE.BoxGeometry(15, 3.2, 1.6), p: [sx * 9.5, tailY, tailZ] });
    } else if (S.lights === 'block') {
        for (const sx of [-1, 1]) tailItems.push({ g: new THREE.BoxGeometry(11, 4.5, 1.6), p: [sx * 11, tailY, tailZ] });
    } else if (S.lights === 'round') {
        for (const sx of [-1, 1]) tailItems.push({ g: new THREE.CylinderGeometry(2.6, 2.6, 1.6, 10),
                                                   p: [sx * 12, tailY, tailZ], r: [Math.PI / 2, 0, 0] });
    } else {
        for (const sx of [-1, 1]) tailItems.push({ g: new THREE.BoxGeometry(4.2, 14, 1.6), p: [sx * 14, tailY, tailZ - 1] });
    }
    const tails = tailItems.length === 1 ? tailItems : [{ g: mergeGeos(tailItems) }];

    const flameGeo = new THREE.ConeGeometry(3.2, 20, 8, 1, true);
    const decalGeo = new THREE.PlaneGeometry(58, 96);
    const flameMat = new THREE.MeshBasicMaterial({
        color: '#8ff4ff', transparent: true, opacity: 0.85,
        blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide
    });

    const pack = {
        S, parts, tails, wheel, rim,
        edges: new THREE.EdgesGeometry(body, 32),
        cabinEdges: new THREE.EdgesGeometry(cabin, 32),
        flameGeo, decalGeo, flameMat,
        exhaust: S.exhaust
    };
    geoCache[style] = pack;
    return pack;
}

/* ------------------------------------------------------------------ *
 *  material cache — one set per neon colour, shared across cars
 * ------------------------------------------------------------------ */
const matCache = {};
function materialsFor(color) {
    if (matCache[color]) return matCache[color];
    const paint = mixHex('#171c2e', color, 0.5);
    const m = {
        body: new THREE.MeshStandardMaterial({ color: paint, metalness: 0.55, roughness: 0.38 }),
        lower: new THREE.MeshStandardMaterial({ color: darken(paint, 0.45), metalness: 0.5, roughness: 0.6 }),
        glass: new THREE.MeshStandardMaterial({
            color: '#0d1b33', metalness: 0.95, roughness: 0.12, transparent: true, opacity: 0.9
        }),
        roof: new THREE.MeshStandardMaterial({ color: darken(paint, 0.15), metalness: 0.6, roughness: 0.35 }),
        tire: new THREE.MeshStandardMaterial({ color: '#111116', metalness: 0.1, roughness: 0.95 }),
        rim: new THREE.MeshStandardMaterial({ color: '#8c94ab', metalness: 0.9, roughness: 0.3 }),
        trim: new THREE.MeshStandardMaterial({ color: darken(paint, 0.55), metalness: 0.7, roughness: 0.45 }),
        head: new THREE.MeshStandardMaterial({
            color: '#dfe8ff', emissive: new THREE.Color('#9fd8ff'), emissiveIntensity: 1.1,
            metalness: 0.3, roughness: 0.2
        }),
        neon: new THREE.LineBasicMaterial({ color, transparent: true, opacity: 0.95 }),
        glowMat: new THREE.MeshBasicMaterial({
            map: glowTexture(), color, transparent: true, opacity: 0.55,
            blending: THREE.AdditiveBlending, depthWrite: false
        }),
        shadowMat: new THREE.MeshBasicMaterial({
            map: glowTexture(), color: '#000000', transparent: true, opacity: 0.5, depthWrite: false
        }),
        color
    };
    matCache[color] = m;
    return m;
}

/* soft round sprite used for glows, flames and particles */
let glowTex = null;
export function glowTexture() {
    if (glowTex) return glowTex;
    const c = document.createElement('canvas');
    c.width = c.height = 64;
    const g = c.getContext('2d');
    const rg = g.createRadialGradient(32, 32, 0, 32, 32, 32);
    rg.addColorStop(0, 'rgba(255,255,255,1)');
    rg.addColorStop(0.35, 'rgba(255,255,255,0.55)');
    rg.addColorStop(1, 'rgba(255,255,255,0)');
    g.fillStyle = rg; g.fillRect(0, 0, 64, 64);
    glowTex = new THREE.CanvasTexture(c);
    glowTex.colorSpace = THREE.SRGBColorSpace;
    return glowTex;
}

/* ------------------------------------------------------------------ *
 *  buildCar
 * ------------------------------------------------------------------ */
export function buildCar(style = 'sports', color = '#ff0055') {
    const P = partsFor(style);
    const S = P.S;
    const M = materialsFor(color);
    const group = new THREE.Group();

    for (const part of P.parts) {
        const mesh = new THREE.Mesh(part.g, M[part.m]);
        if (part.p) mesh.position.set(part.p[0], part.p[1], part.p[2]);
        if (part.s) mesh.scale.set(part.s[0], part.s[1], part.s[2]);
        if (part.r) mesh.rotation.set(part.r[0], part.r[1], part.r[2]);
        group.add(mesh);
    }

    /* neon edge lines — the "geometrical" read */
    const edges = new THREE.LineSegments(P.edges, M.neon);
    edges.position.y = 0.02;
    group.add(edges);
    const cEdges = new THREE.LineSegments(P.cabinEdges, M.neon);
    cEdges.position.y = S.bodyH + 0.02;
    group.add(cEdges);

    /* wheels */
    const wheels = [];
    for (const sx of [-1, 1]) for (const sz of [-1, 1]) {
        const w = new THREE.Group();
        w.add(new THREE.Mesh(P.wheel, M.tire));
        w.add(new THREE.Mesh(P.rim, M.rim));
        w.position.set(sx * (CAR.W / 2 - S.wheelW / 2 - 0.5), S.wheelR, sz * S.wheelZ);
        w.userData.front = sz < 0;
        group.add(w);
        wheels.push(w);
    }

    /* tail lamps — one material per car so the brakes can glow */
    const brakeMat = new THREE.MeshStandardMaterial({
        color: darken(color, 0.30), emissive: new THREE.Color(color),
        emissiveIntensity: 1.0, metalness: 0.3, roughness: 0.25
    });
    for (const t of P.tails) {
        const l = new THREE.Mesh(t.g, brakeMat);
        if (t.p) l.position.set(t.p[0], t.p[1], t.p[2]);
        if (t.r) l.rotation.set(t.r[0], t.r[1], t.r[2]);
        group.add(l);
    }

    /* underglow decal */
    const glow = new THREE.Mesh(P.decalGeo, M.glowMat);
    glow.rotation.x = -Math.PI / 2;
    glow.position.y = 0.6;
    glow.userData.decal = true;
    group.add(glow);

    /* nitro flames (apex points backwards down the track) */
    const flames = [];
    for (const x of (P.exhaust.length ? P.exhaust : [0])) {
        const f = new THREE.Mesh(P.flameGeo, P.flameMat);
        f.rotation.x = Math.PI / 2;
        f.position.set(x, S.bodyH * 0.30, 52);
        f.visible = false;
        f.userData.decal = true;
        group.add(f);
        flames.push(f);
    }

    /* soft contact shadow — no shadow maps on mobile */
    const shadow = new THREE.Mesh(P.decalGeo, M.shadowMat);
    shadow.rotation.x = -Math.PI / 2;
    shadow.position.y = 0.25;
    shadow.userData.decal = true;
    group.add(shadow);

    group.userData.handle = {
        style, color, wheels, flames, glow, brakeMat,
        setBrake(v) { brakeMat.emissiveIntensity = 1.0 + v * 3.2; },
        setBoost(v) {
            glow.material.opacity = 0.55 + v * 0.75;
            for (const f of flames) {
                f.visible = v > 0.02;
                f.scale.set(0.8, 0.6 + v * 0.9, 0.8);
            }
        },
        spinWheels(phase, steer) {
            for (const w of wheels) {
                w.children[0].rotation.x = phase;
                w.children[1].rotation.x = phase;
                w.rotation.y = w.userData.front ? steer * 0.42 : 0;
            }
        }
    };
    return group;
}

/* free-list so spawning traffic never allocates */
const pool = {};
export function acquireCar(style, color) {
    const key = style + '|' + color;
    const list = pool[key] || (pool[key] = []);
    return list.pop() || buildCar(style, color);
}
export function releaseCar(car) {
    /* Reset the transform: a car recycled out of a wreck animation would
       otherwise reappear mid-tumble, tilted and shrunken, as traffic. */
    car.visible = false;
    car.position.set(0, 0, 0);
    car.rotation.set(0, 0, 0);
    car.scale.setScalar(1);
    const key = car.userData.handle.style + '|' + car.userData.handle.color;
    (pool[key] || (pool[key] = [])).push(car);
}
export const STYLE_NAMES = Object.keys(STYLES);
