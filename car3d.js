/* =============================================================================
   car3d.js — procedural F1 single-seaters for NEON DRIVE (three.js)
   -----------------------------------------------------------------------------
   Every car is an open-wheel Formula 1 machine: pointed nose cone, front wing
   with endplates, narrow monocoque, flanking sidepods with intake mouths,
   open cockpit with a helmet and a halo, engine airbox, and a high rear wing
   on a central pylon. Four variants (f1..f4) give the field some variety.

   Footprint still matches the collision box: 44 wide x 85 long, origin at the
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
 *  F1 body profiles — half-width (x) sampled along the length (z)
 *  z: -42.5 = nose tip, +42.5 = tail.  y = 0 is the road.
 * ------------------------------------------------------------------ */
const BASE = {
    /* monocoque floor: needle nose -> widest at the sidepods -> tapered tail */
    body: [[-42.5, 2.8], [-39, 4.4], [-33, 6.0], [-24, 7.8], [-14, 10.4],
           [-4, 13.2], [6, 13.6], [16, 12.0], [26, 9.4], [34, 7.2], [42.5, 5.2]],
    bodyH: 6.5,
    /* engine cover sitting behind the cockpit */
    cabin: [[0, 5.0], [8, 6.2], [18, 5.4], [28, 4.0], [34, 2.6]],
    cabinH: 6.4,
    /* sidepods */
    podW: 9.5, podH: 7.6, podL: 26, podZ: 6,
    /* airbox behind the driver's head */
    airbox: [8, 3.6, 10],
    /* wings */
    frontWing: 44, rearWing: 42, wingY: 18.5, endplate: 10,
    /* wheels: exposed, smaller at the front, wider and taller at the rear.
       Sized so the helmet sits above the fronts and just under the rears. */
    wheelR: 7.0, wheelW: 5.6, wheelZ: -25,
    rearR: 8.0, rearW: 7.6, rearZ: 26
};

const STYLES = {
    /* the player's car: high nose, full-width wings */
    f1: Object.assign({}, BASE),
    /* chunkier: fatter sidepods, lower rear wing, smaller endplates */
    f2: Object.assign({}, BASE, {
        podW: 10.2, podH: 8.2, podL: 27, frontWing: 46, rearWing: 44, wingY: 17.5, endplate: 9
    }),
    /* the low-drag one: slim body, narrow wings, smallest wheels */
    f3: Object.assign({}, BASE, {
        podW: 8.4, podH: 7.0, podL: 24, frontWing: 40, rearWing: 37, wingY: 17,
        endplate: 8, wheelR: 6.6, wheelW: 5.2, rearR: 7.6, rearW: 7.0
    }),
    /* high-downforce / safety-car look: tall airbox, huge rear wing */
    f4: Object.assign({}, BASE, {
        airbox: [8.5, 4.6, 11], frontWing: 46, rearWing: 44, wingY: 20, endplate: 12
    })
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

/* several EdgesGeometry into one LineSegments buffer (one draw call) */
function mergeEdges(geos) {
    let total = 0;
    for (const g of geos) total += g.attributes.position.count;
    const pos = new Float32Array(total * 3);
    let o = 0;
    for (const g of geos) {
        pos.set(g.attributes.position.array, o);
        o += g.attributes.position.count * 3;
        g.dispose();
    }
    const out = new THREE.BufferGeometry();
    out.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    return out;
}

/* ------------------------------------------------------------------ *
 *  geometry + part table, built once per style
 * ------------------------------------------------------------------ */
const geoCache = {};
function partsFor(style) {
    if (geoCache[style]) return geoCache[style];
    const S = STYLES[style] || STYLES.f1;

    const body = extrude(shapeFromHalf(S.body), S.bodyH, 1.5);
    const cabin = extrude(shapeFromHalf(S.cabin), S.cabinH, 1.0);

    /* open wheels — front pair and wider rear pair */
    const mk = (r, w) => {
        const tyre = new THREE.CylinderGeometry(r, r, w, 16, 1);
        tyre.rotateZ(Math.PI / 2);
        const rim = new THREE.CylinderGeometry(r * 0.58, r * 0.58, w + 0.7, 12, 1);
        rim.rotateZ(Math.PI / 2);
        return { tyre, rim };
    };
    const front = mk(S.wheelR, S.wheelW);
    const rear = mk(S.rearR, S.rearW);
    /* a bright stripe across the tyre so the spin reads at speed */
    const spokeGeo = new THREE.BoxGeometry(0.9, S.wheelR * 1.5, 1.4);
    const spokeGeoR = new THREE.BoxGeometry(0.9, S.rearR * 1.5, 1.4);

    const groups = {};                       // material key -> parts
    const add = (m, g, p, r, s) => { (groups[m] || (groups[m] = [])).push({ g, p, r, s }); };
    const box = (w, h, d) => new THREE.BoxGeometry(w, h, d);

    /* ---- chassis ---- */
    add('body', body);
    add('lower', body, null, null, [1.02, 0.45, 0.99]);       // skirt / floor edge
    add('carbon', cabin, [0, S.bodyH, 0]);                     // engine cover

    /* ---- sidepods with intake mouths ---- */
    for (const sx of [-1, 1]) {
        add('body', box(S.podW, S.podH, S.podL), [sx * (S.podW * 0.5 + 6.2), S.podH * 0.5 + 1.2, S.podZ]);
        add('glass', box(S.podW * 0.62, S.podH * 0.6, 1.6),
            [sx * (S.podW * 0.5 + 6.2), S.podH * 0.55 + 1.2, S.podZ - S.podL * 0.5 - 0.6]);
        /* bargeboard fin down the side of the floor */
        add('carbon', box(0.9, 5.2, 9), [sx * 17.4, 4.6, -7]);
        /* suspension arms out to the hubs */
        add('rim', box(6.5, 0.9, 0.9), [sx * 15.0, S.wheelR * 0.72, S.wheelZ]);
        add('rim', box(6.0, 0.9, 0.9), [sx * 14.6, S.rearR * 0.72, S.rearZ]);
    }

    /* ---- cockpit: dark opening, helmet, visor, halo ---- */
    add('glass', box(11, 2.6, 15), [0, S.bodyH + 0.6, -8]);            // opening
    add('helmet', new THREE.SphereGeometry(3.3, 12, 9), [0, S.bodyH + 5.0, -9]);
    add('visor', box(5.0, 2.0, 1.4), [0, S.bodyH + 5.6, -11.6]);
    for (const sx of [-1, 1])                                          // halo rails
        add('carbon', box(0.9, 0.9, 16), [sx * 6.4, S.bodyH + 8.7, -9]);
    add('carbon', box(13.7, 0.9, 0.9), [0, S.bodyH + 8.7, -1.2]);       // halo rear bar
    add('carbon', box(0.9, 5.4, 0.9), [0, S.bodyH + 6.1, -16.6]);       // halo front pillar

    /* ---- airbox + shark fin ---- */
    add('body', box(S.airbox[0], S.airbox[1], S.airbox[2]),
        [0, S.bodyH + S.cabinH + S.airbox[1] * 0.5 - 0.4, 2]);
    add('carbon', box(0.8, 3.2, 12), [0, S.bodyH + S.cabinH + 1.6, 12]);

    /* ---- front wing: main plane, flap, endplates ---- */
    add('carbon', box(S.frontWing, 1.3, 9), [0, 2.2, -39]);
    add('body', box(S.frontWing * 0.9, 1.1, 5), [0, 4.0, -40.6]);
    for (const sx of [-1, 1])
        add('body', box(1.4, 6, 11), [sx * (S.frontWing * 0.5 - 0.7), 4, -39]);

    /* ---- rear wing: main plane, flap, endplates, pylon, beam wing ---- */
    add('carbon', box(S.rearWing, 1.5, 8), [0, S.wingY, 40.5]);
    add('body', box(S.rearWing * 0.9, 1.2, 5), [0, S.wingY - 2.1, 41.2]);
    for (const sx of [-1, 1])
        add('body', box(1.4, S.endplate, 9), [sx * (S.rearWing * 0.5 - 0.7), S.wingY - S.endplate * 0.5 + 1, 40.5]);
    add('carbon', box(2.8, S.wingY - S.bodyH - 1, 3.4), [0, (S.wingY + S.bodyH) * 0.5, 39.5]);
    add('carbon', box(30, 1.0, 4), [0, 9.5, 41.5]);

    /* ---- diffuser + rain light seat ---- */
    add('carbon', box(26, 3.6, 5), [0, 1.9, 41]);

    /* ---- exhausts ---- */
    for (const sx of [-1, 1])
        add('rim', new THREE.CylinderGeometry(1.5, 1.5, 4, 8),
            [sx * 6.5, S.bodyH + S.cabinH + 1.2, 28], [Math.PI / 2, 0, 0]);

    /* ---- head lamps (position markers on the nose) ---- */
    for (const sx of [-1, 1])
        add('head', box(5, 1.8, 1.2), [sx * 4.5, 3.4, -41.6]);

    /* one mesh per material */
    const parts = [];
    for (const m in groups) {
        const list = groups[m];
        parts.push(list.length === 1
            ? { g: list[0].g, m, p: list[0].p, r: list[0].r, s: list[0].s }
            : { g: mergeGeos(list), m });
    }

    /* ---- rain / brake light: geometry cached, material per car ---- */
    const tails = [{ g: mergeGeos([
        { g: box(6, 3.2, 1.6), p: [0, S.bodyH + S.cabinH - 1.4, 41.8] }
    ]) }];

    /* neon edge lines — the "geometrical" read. Body, engine cover, wings. */
    const edgeSrc = [
        new THREE.EdgesGeometry(body, 32),
        new THREE.EdgesGeometry(cabin, 32),
        new THREE.EdgesGeometry(box(S.rearWing, 1.5, 8), 1),
        new THREE.EdgesGeometry(box(S.frontWing, 1.3, 9), 1)
    ];
    const edges = mergeEdges(edgeSrc);

    const flameGeo = new THREE.ConeGeometry(3.0, 22, 8, 1, true);
    const decalGeo = new THREE.PlaneGeometry(58, 100);
    const flameMat = new THREE.MeshBasicMaterial({
        color: '#8ff4ff', transparent: true, opacity: 0.85,
        blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide
    });

    const pack = {
        S, parts, tails, front, rear, spokeGeo, spokeGeoR,
        edges, flameGeo, decalGeo, flameMat,
        exhaust: [-6.5, 6.5],
        flameY: S.bodyH + S.cabinH + 1.2
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
    const paint = mixHex('#171c2e', color, 0.55);
    const m = {
        body: new THREE.MeshStandardMaterial({ color: paint, metalness: 0.55, roughness: 0.34 }),
        lower: new THREE.MeshStandardMaterial({ color: darken(paint, 0.45), metalness: 0.5, roughness: 0.6 }),
        /* bare carbon: wings, engine cover, halo */
        carbon: new THREE.MeshStandardMaterial({ color: '#14161d', metalness: 0.82, roughness: 0.42 }),
        glass: new THREE.MeshStandardMaterial({
            color: '#0a1120', metalness: 0.95, roughness: 0.12, transparent: true, opacity: 0.92
        }),
        helmet: new THREE.MeshStandardMaterial({ color: lighten(paint, 0.55), metalness: 0.25, roughness: 0.45 }),
        visor: new THREE.MeshStandardMaterial({ color: '#05070d', metalness: 1.0, roughness: 0.05 }),
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
export function buildCar(style = 'f1', color = '#ff0055') {
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

    /* neon edge lines */
    const edges = new THREE.LineSegments(P.edges, M.neon);
    edges.position.y = 0.02;
    group.add(edges);

    /* exposed wheels: front pair steer, rear pair are wider */
    const wheels = [];
    const mount = (set, r, w, z, spokeG) => {
        for (const sx of [-1, 1]) {
            const hub = new THREE.Group();
            const tyre = new THREE.Mesh(set.tyre, M.tire);
            const rim = new THREE.Mesh(set.rim, M.rim);
            hub.add(tyre, rim);
            /* two bright spokes so the rotation is visible at speed */
            for (const a of [0, Math.PI / 2]) {
                const sp = new THREE.Mesh(spokeG, M.rim);
                sp.rotation.x = a;
                tyre.add(sp);
            }
            hub.position.set(sx * (CAR.W / 2 - w / 2), r, z);
            hub.userData.front = z < 0;
            group.add(hub);
            wheels.push(hub);
        }
    };
    mount(P.front, S.wheelR, S.wheelW, S.wheelZ, P.spokeGeo);
    mount(P.rear, S.rearR, S.rearW, S.rearZ, P.spokeGeoR);

    /* rain light — one material per car so the brakes can glow */
    const brakeMat = new THREE.MeshStandardMaterial({
        color: darken(color, 0.30), emissive: new THREE.Color(color),
        emissiveIntensity: 1.0, metalness: 0.3, roughness: 0.25
    });
    for (const t of P.tails) {
        const l = new THREE.Mesh(t.g, brakeMat);
        l.userData.brakeLight = true;
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

    /* nitro flames out of the exhausts */
    const flames = [];
    for (const x of P.exhaust) {
        const f = new THREE.Mesh(P.flameGeo, P.flameMat);
        f.rotation.x = Math.PI / 2;
        f.position.set(x, P.flameY, 52);
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
        /* dist = distance the car itself has travelled; each hub's height
           is its wheel radius, so angle = dist / r is a wheel rolling
           without slip — and the smaller fronts spin faster than the
           rears, as they should */
        spinWheels(dist, steer) {
            for (const w of wheels) {
                const a = -dist / w.position.y;   // forward is -z: tops roll forward
                w.children[0].rotation.x = a;
                w.children[1].rotation.x = a;
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
