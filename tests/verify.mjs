/* NEON DRIVE full suite. Runs the REAL modules against a stubbed DOM/WebGL,
   an in-memory Firebase and a virtual clock, so every frame is deterministic.
   Usage: cd tests && ./run.sh     (npm install three @napi-rs/canvas first) */
import { makeEnv, makeAudio } from './glstub.mjs';
import { FakeDB, makeFirebase } from './fakedb.mjs';
import { readFileSync } from 'node:fs';

let fail = 0;
const ok = (c, m) => { console.log((c ? '  PASS ' : '  FAIL ') + m); if (!c) fail++; };
const pct = (v) => (v * 100).toFixed(0) + '%';

const env = makeEnv(844, 390);                 // the game is played rotated
globalThis.document = env.doc; globalThis.window = env.win; globalThis.self = env.win;
Object.defineProperty(globalThis, 'navigator', { value: { userAgent: 'node', maxTouchPoints: 5 }, configurable: true });
globalThis.alert = (m) => { console.log('   [alert] ' + m); };
const T = env.timers;
globalThis.setTimeout = (fn, ms) => T.setTimeout(fn, ms);
globalThis.setInterval = (fn, ms) => T.setInterval(fn, ms);
globalThis.clearTimeout = (id) => T.clear(id);
globalThis.clearInterval = (id) => T.clear(id);

let rafCb = null;
const raf = (cb) => { rafCb = cb; return 1; };
env.win.requestAnimationFrame = raf; globalThis.requestAnimationFrame = raf;
globalThis.cancelAnimationFrame = () => { rafCb = null; };

const audio = makeAudio();
globalThis.AudioContext = env.win.AudioContext = audio.Ctx;

const db = new FakeDB();
globalThis.firebase = makeFirebase(db);

const THREE = await import('three');
const { World, reseedCurves } = await import('../scene3d.js');
const car3d = await import('../car3d.js');
/* the bends are random per race; pin them so framing is measurable */
const CURVE_SEED = 20251029;
reseedCurves(CURVE_SEED);

/* watch the live game by wrapping the renderer entry points first */
let liveEnemies = null, livePlayerX = 0;
const origSync = World.prototype.syncEnemies, origSet = World.prototype.setPlayer;
World.prototype.syncEnemies = function (l, s, p) { liveEnemies = l; return origSync.call(this, l, s, p); };
World.prototype.setPlayer = function (x, z, o) { livePlayerX = x; return origSet.call(this, x, z, o); };

const EXPORTS = ['findRandomGame','cancelSearch','playSolo','useGhost','useNuke','shootBullet',
                 'createRoom','joinRoom','sendChatMessage','startMultiplayerGame','backToLobby',
                 'checkOrientation','wheelSetAngle','carRoadOffset','carPhysicsState'];
const grab = () => Object.fromEntries(EXPORTS.map(k => [k, globalThis.window[k]]));
await import('../script.js');
const A = grab();

const fire = () => { const cb = rafCb; rafCb = null; if (cb) cb(0); };
/* A frame with a driver in it. The car has a heading of its own now and
   does not follow the road, so the driver has to drive like a human:
   aim the course at the road's heading, corrected toward the middle,
   and damp the yaw. Anything less ends in the barrier — which is the
   point of the physics, but makes every speed measurement a lie. */
const aimWheel = () => {
    const s = window.carPhysicsState();
    if (!s) return;
    const want = s.roadHeading + Math.max(-0.30, Math.min(0.30, -s.offset * 0.0035));
    const err = Math.atan2(Math.sin(want - s.course), Math.cos(want - s.course));
    window.wheelSetAngle(Math.max(-120, Math.min(120, err * 260 - s.yawRate * 38)));
};
const drive = (n = 1) => { for (let i = 0; i < n; i++) { aimWheel(); fire(); } };
const el = (id) => document.getElementById(id);
const flush = async (n = 6) => { for (let i = 0; i < n; i++) await new Promise(r => setImmediate(r)); };
const ammo = () => parseInt(document.querySelectorAll('.ammo-count')[0].innerText) || 0;
const score = () => parseInt(el('score-txt').innerText) || 0;
const speed = () => parseInt(el('speed-txt').innerText) || 0;
const nitroPct = () => parseInt(el('nitro-percent-txt').innerText) || 0;
const src = readFileSync(new URL('../script.js', import.meta.url), 'utf8');
const cssSrc = readFileSync(new URL('../style.css', import.meta.url), 'utf8');
const airSrc = readFileSync(new URL('../scene3d.js', import.meta.url), 'utf8');
const htmlSrc = readFileSync(new URL('../index.html', import.meta.url), 'utf8');
const RACE_SECONDS = +(src.match(/RACE_SECONDS = (\d+)/) || [])[1];
const FAR_Z = +(airSrc.match(/const FAR_Z = (-?\d+)/) || [])[1];
const RACE_MS = (RACE_SECONDS + 1) * 1000;
const clamp = (min, vh, max, H) => Math.min(Math.max(min, vh / 100 * H), max);

/* =================================================================== */
console.log('=== ROTATED (landscape): the road keeps its width, the car sits low ===');
const CARB = [[-22, 0, -42.5], [22, 0, -42.5], [-22, 21, 41], [22, 21, 41], [0, 21, -42.5]];
function framing(W, H) {
    env.setSize(W, H);
    const w = new World(env.gameCanvas); w.renderer.render = () => {};
    w.resize();
    w.setPlayer(0, 0, { steer: 0, brake: 0, boost: 0, phase: 0 });
    w.camera.updateMatrixWorld(true);
    const p = (x, y, z) => {
        const v = new THREE.Vector3(x, y, z).project(w.camera);
        return { x: (v.x + 1) / 2 * W, y: (1 - v.y) / 2 * H };
    };
    let top = 1e9, bot = -1e9, left = 1e9, right = -1e9;
    for (const c of CARB) { const q = p(...c); top = Math.min(top, q.y); bot = Math.max(bot, q.y); left = Math.min(left, q.x); right = Math.max(right, q.x); }
    const spawnZ = +(src.match(/const SPAWN_Y = (-?\d+)/) || [])[1] - 690;
    const camDist = Math.abs(spawnZ - w.camera.position.z);
    const fogNear = +(airSrc.match(/new THREE\.Fog\('[^']+', (\d+),/) || [])[1];
    const fogFar = +(airSrc.match(/const VIEW_FAR = (\d+)/) || [])[1];
    const roadEnd = p(0, 0, w.camera.position.z - fogFar).y / H;   // where the tarmac goes out
    return {
        roadEnd, fogFar, fogNear,
        roadW: Math.abs(p(220, 0, 0).x - p(-220, 0, 0).x) / W,
        roadAhead: Math.abs(p(220, 0, -1500).x - p(-220, 0, -1500).x) / W,
        carTop: top / H, carBot: bot / H, carH: bot - top, carW: right - left,
        carL: left, carR: right,
        horizon: p(0, 0, -100000).y / H,
        spawnY: p(0, 0, spawnZ).y / H,
        fog: Math.min(1, Math.max(0, (camDist - fogNear) / (fogFar - fogNear)))
    };
}
for (const [W, H, label] of [[844, 390, 'iPhone landscape'], [740, 360, 'Android landscape'], [926, 428, 'big landscape']]) {
    const m = framing(W, H);
    console.log(`  ${label} ${W}x${H}: road ${pct(m.roadW)} wide, car ${m.carW.toFixed(0)}x${m.carH.toFixed(0)}px ` +
                `at ${pct(m.carTop)}-${pct(m.carBot)}, horizon ${pct(m.horizon)}`);
    ok(m.roadW > 0.75, `${W}x${H}: road still fills the width (${pct(m.roadW)}, was 45% before)`);
    ok(m.roadAhead > 0.14, `${W}x${H}: and stays wide up the track (${pct(m.roadAhead)} at 1500u)`);
    ok(m.carBot > 0.70, `${W}x${H}: car sits low where a rotated phone has room (bottom ${pct(m.carBot)}, was 65%)`);
    ok(m.carTop > 0.55, `${W}x${H}: with the whole road ahead visible above it (top ${pct(m.carTop)})`);
    ok(m.horizon > 0.02 && m.horizon < 0.25, `${W}x${H}: horizon stays in frame (${pct(m.horizon)})`);
    ok(m.carH > 40 && m.carH < 130, `${W}x${H}: car is ${m.carH.toFixed(0)}px tall — readable, not a toy`);
}
const land = framing(844, 390);
ok(land.fog > 0.95, `traffic still appears out of the fog (${pct(land.fog)} fogged at spawn)`);
ok(land.spawnY < land.horizon + 0.10, `and it enters near the horizon (${pct(land.spawnY)} vs horizon ${pct(land.horizon)})`);

console.log('\n=== the road bends ===');
{
    const w = new World(env.gameCanvas); w.renderer.render = () => {};
    env.setSize(844, 390); w.resize(); w._playerZ = 0;
    const bends = (seed, at = 1500) => {
        reseedCurves(seed);
        const out = [];
        for (let step = 0; step < 24; step++) {
            w.scrollRoad(step * 2600);
            out.push(w.bendAt(-at));
        }
        return out;
    };
    const swing = (a) => Math.max(...a) - Math.min(...a);
    const run1 = bends(CURVE_SEED), run2 = bends(CURVE_SEED + 1);
    console.log(`  over a race the road centre 1500u ahead swings ${swing(run1).toFixed(0)} units`);
    ok(swing(run1) > 150, `it really does curve: the road ahead shifts ${swing(run1).toFixed(0)} units as you drive`);
    ok(run1.some(v => Math.abs(v) > 60), `and often leans well off centre (up to ${Math.max(...run1.map(Math.abs)).toFixed(0)} units)`);
    ok(run1.every((v, i) => Math.abs(v - run2[i]) > 1e-9), 'a different seed gives a different road');
    ok(Math.abs(w.bendAt(0)) < 1e-9, 'and the centreline still passes through the car\'s station (offset is measured from it)');

    /* every bend, on every seed, has to stay on screen */
    reseedCurves(CURVE_SEED);
    let offScreen = 0, worstYaw = 0, worstShift = 0;
    for (let seed = 0; seed < 40; seed++) {
        reseedCurves(seed);
        for (let step = 0; step < 10; step++) {
            w.scrollRoad(seed * 613 + step * 3700);
            w.setPlayer(0, 0, { steer: 0, brake: 0, boost: 0, phase: 0 });
            w.camera.updateMatrixWorld(true);
            /* how far the road has turned away from you by the time it is up
               there: the heading under the car is zero by construction, it is
               the bend ahead that decides whether this is a sweeper or a
               hairpin */
            worstYaw = Math.max(worstYaw, Math.abs(w.curveYawAt(-2000)) * 180 / Math.PI);
            for (const d of [400, 900, 1800, 3200, 5600]) {
                const c = w.bendAt(-d);
                worstShift = Math.max(worstShift, Math.abs(c));
                for (const e of [-220, 220]) {
                    const v = new THREE.Vector3(c + e, 0, -d).project(w.camera);
                    const sx = (v.x + 1) / 2 * 844;
                    if (sx < -2 || sx > 846) offScreen++;
                }
            }
        }
    }
    console.log(`  worst heading ${worstYaw.toFixed(1)}deg, worst swing ${worstShift.toFixed(0)} units, ${offScreen} edges off screen`);
    ok(offScreen === 0, 'no bend, on any seed, throws the road off the side of the screen');
    ok(worstYaw < 30, `the bends stay driveable, not hairpins (worst turn ${worstYaw.toFixed(1)}deg by 2000u up the road)`);
    ok(worstYaw > 4, `and they are real bends, not a straight road (${worstYaw.toFixed(1)}deg of turn 2000u up)`);

    /* the car, the traffic and the furniture all sit on the bend */
    reseedCurves(CURVE_SEED);
    w.scrollRoad(12345);
    w.setPlayer(0, 0, { steer: 0, heading: 0, brake: 0, boost: 0, phase: 0 });
    ok(Math.abs(w.playerCar.rotation.y) < 1e-9,
       'the car is not turned by the bend: it points where its own heading points');
    w.setPlayer(0, 0, { steer: 0, heading: 0.3, brake: 0, boost: 0, phase: 0 });
    ok(Math.abs(w.playerCar.rotation.y + 0.3) < 1e-9,
       'and when the driver has turned it, the nose follows the driver, not the road');
    /* The chase camera rides behind the car's heading, simulator-style:
       hold the heading dead constant while the road snakes underneath on
       seed after seed, and the camera must not swing with the road at
       all — it stays true to the car's straight line. */
    w.setPlayer(0, 0, { steer: 0, heading: 0.22, snapCamera: true, brake: 0, boost: 0, phase: 0 });
    let carOff = 0, camSwing = 0;
    for (let seed = 0; seed < 12; seed++) {
        reseedCurves(seed);
        for (let step = 0; step < 8; step++) {
            w.scrollRoad(seed * 811 + step * 3300);
            w.setPlayer(0, 0, { steer: 0, heading: 0.22, brake: 0, boost: 0, phase: 0 });
            w.camera.updateMatrixWorld(true);
            const v = new THREE.Vector3(0, 21, 0).project(w.camera);
            carOff = Math.max(carOff, Math.abs((v.x + 1) / 2 * 844 - 422));
            camSwing = Math.max(camSwing, Math.abs(w.camera.rotation.y + 0.22) * 180 / Math.PI);
        }
    }
    ok(carOff < 1 && camSwing < 0.5,
       `and the camera follows the car, not the road: worst drift ${carOff.toFixed(1)}px, camera error ${camSwing.toFixed(2)}deg`);
    /* The road has to belong to the car: it passes under the wheels, and it
       points the way the car does -- take the road's own heading out of it and
       what is left is the bend ahead. Get that wrong and the tarmac runs away
       sideways underneath you, which is what read as the car being swept the
       other way round the corner. Get it too right and you have a straight
       road again, so the bend up ahead is measured too. */
    const bend2000 = [];
    for (let seed = 0; seed < 40; seed++) {
        reseedCurves(seed);
        for (let step = 0; step < 10; step++) {
            const base = seed * 613 + step * 3700;
            w.scrollRoad(base);
            w.setPlayer(0, 0, { steer: 0, brake: 0, boost: 0, phase: 0 });
            w.camera.updateMatrixWorld(true);
            bend2000.push(Math.abs(w.bendAt(-2000)));
        }
    }
    const midBend = bend2000.sort((a, b) => a - b)[Math.floor(bend2000.length / 2)];
    ok(Math.abs(w.bendAt(0)) < 1e-9, 'a car sitting in the middle still has the road under it');
    ok(midBend > 60, `and it is a real curving road: the centre is ${midBend.toFixed(0)} units off, 2000u up the road`);
    /* Whether the bends can push the CAR around is a gameplay question,
       tested on the live game further down ("hands off the wheel"). The
       geometry only has to be a proper bending road, measured above. */
    w.syncEnemies([{ style: 'f1', color: '#fff', wx: 0, wz: -1500, steer: 0, phase: 0 }], 160, 0);
    ok(Math.abs(w.enemyPool[0].car.position.x - w.bendAt(-1500)) < 1e-6 && w.enemyPool[0].car.position.x !== 0,
       `traffic follows the bend too (a car 1500u up the road sits ${w.enemyPool[0].car.position.x.toFixed(0)} units over)`);
    ok(Math.abs(w.enemyPool[0].car.rotation.y + w.trackHeadingAtS(w.roadSAt(-1500))) < 1e-9,
       'and traffic points along the road there, nose exactly on the tangent');
    w.scrollRoad(12345);
    const kerb = new THREE.Matrix4();
    w.kerbs.getMatrixAt(0, kerb);
    const kp = new THREE.Vector3().setFromMatrixPosition(kerb);
    /* instance matrices are float32, so allow a fraction of a unit */
    ok(Math.abs(kp.x - (-214 + w.bendAt(kp.z))) < 0.02,
       `and so does the road furniture (a kerb ${(-kp.z).toFixed(0)}u out sits ${w.bendAt(kp.z).toFixed(0)} units over, matching the bend)`);
    /* The lane paint is fixed to the road surface: pick any dash, drive
       37 units, and that same dash must still be at the same absolute
       station in the same lane — it only moves because the car passes it,
       never because the renderer slides it sideways. */
    w.scrollRoad(21000);
    const dm = new THREE.Matrix4();
    let dashIdx = -1, dashS = 0, dashLane = 0;
    for (let i = 0; i < w.dashes.count; i++) {
        w.dashes.getMatrixAt(i, dm);
        const p = new THREE.Vector3().setFromMatrixPosition(dm);
        if (p.z < -1000 && p.z > -3000) { dashIdx = i; dashS = w.roadSAt(p.z); dashLane = p.x - w.bendAt(p.z); break; }
    }
    w.scrollRoad(21037);
    w.dashes.getMatrixAt(dashIdx, dm);
    const dp2 = new THREE.Vector3().setFromMatrixPosition(dm);
    ok(dashIdx >= 0 && Math.abs(w.roadSAt(dp2.z) - dashS) < 0.05 &&
       Math.abs((dp2.x - w.bendAt(dp2.z)) - dashLane) < 0.05,
       'and the lane lines stay still on the road: a dash keeps its station and lane as you drive');
    reseedCurves(CURVE_SEED);
}

console.log('\n=== how far down the road you can see ===');
console.log(`  the road runs out at ${pct(land.roadEnd)} of the screen height; the horizon is ${pct(land.horizon)}`);
ok(land.roadEnd < land.horizon + 0.06,
   `the tarmac reaches almost to the horizon (${pct(land.roadEnd)} vs ${pct(land.horizon)}), not a third of the way up`);
ok(land.fogFar >= 5000, `fog holds off to ${land.fogFar} units (was 2900)`);
ok(land.fogFar + 1000 < -FAR_Z, `and there is road underneath it all the way (geometry to ${-FAR_Z}, fog done by ${land.fogFar})`);
/* road furniture that stops short of the fog looks like the road ends there */
const spans = [...airSrc.matchAll(/wrap\(i, (\d+), (\d+)\)/g)].map(m => +m[1] * +m[2]);
const furniture = ['lane dashes', 'kerbs', 'marker posts'];
furniture.forEach((name, i) => {
    const reach = spans[i] || 0;
    ok(reach >= land.fogFar - 700, `${name} run ${reach} units, past where the fog hides their end`);
});
const geoFar = +(airSrc.match(/PerspectiveCamera\(CAM\.fov, 1, 5, (\d+)\)/) || [])[1];
ok(geoFar >= -FAR_Z + 4000, `the camera sees to ${geoFar} units, beyond the far corners of the ground`);
/* the asphalt tiles are baked into the ribbon UVs, so repeat has to be 1 or
   the grain ends up microscopic */
{
    const w2 = new World(env.gameCanvas); w2.renderer.render = () => {};
    const uv = w2.roadRibbon.geometry.attributes.uv.array;
    let vmax = 0;
    for (let i = 1; i < uv.length; i += 2) vmax = Math.max(vmax, uv[i]);
    const tiles = vmax * w2.asphalt.repeat.y;
    const perTile = (-FAR_Z + 560) / tiles;
    ok(tiles > 15 && tiles < 60, `asphalt tiles ${tiles.toFixed(0)} times down the road, one every ${perTile.toFixed(0)} units`);
}

console.log('\n=== portrait is untouched ===');
for (const [W, H] of [[480, 850], [360, 640], [412, 915]]) {
    const m = framing(W, H);
    ok(m.roadW > 1.2 && m.carTop > 0.50 && m.carTop < 0.62 && Math.abs(m.horizon - 0.10) < 0.03,
       `${W}x${H}: same framing as before (road ${pct(m.roadW)}, car ${pct(m.carTop)}-${pct(m.carBot)}, horizon ${pct(m.horizon)})`);
}
ok(/@media \(orientation: landscape\)[\s\S]*max-width: none/.test(cssSrc),
   'landscape drops the portrait letterboxing so the road runs screen-wide');

/* =================================================================== */
console.log('\n=== sizes: everything big enough to hit, nothing in the way ===');
/* resolve the clamps() the stylesheet actually uses, per screen shape.
   Portrait and landscape each carry their own set of sizes. */
const vmin = (W, H) => Math.min(W, H) / 100;
const landBlock = (cssSrc.match(/@media \(orientation: landscape\) \{([\s\S]*?)\n\}/) || ['', ''])[1];
const baseSrc = cssSrc.replace(landBlock, '');
const triple = (src, re) => { const m = src.match(re); return m ? [+m[1], +m[2], +m[3]] : [NaN, NaN, NaN]; };
const cl = ([min, v, max], W, H) => Math.min(Math.max(min, v * vmin(W, H)), max);
const RE = {
    wheel: /#wheel\s*\{[\s\S]*?width: clamp\((\d+)px, (\d+)vmin, (\d+)px\)/,
    btn: /\.ctrl-btn\s*\{\s*width: clamp\((\d+)px, (\d+)vmin, (\d+)px\)/,
    pedalH: /\.pedal\s*\{[\s\S]*?height: clamp\((\d+)px, (\d+)vmin, (\d+)px\)/,
    brake: /\.pedal-brake\s*\{[^}]*width: clamp\((\d+)px, (\d+)vmin, (\d+)px\)/,
    boost: /\.pedal-boost\s*\{[^}]*width: clamp\((\d+)px, (\d+)vmin, (\d+)px\)/
};
function layout(W, H) {
    const port = H > W, src = port ? baseSrc : landBlock;
    const off = (port ? 2.6 : 2.2) * vmin(W, H);
    const wheel = cl(triple(src, RE.wheel), W, H);
    const btn = cl(triple(src, RE.btn), W, H);
    const gap = Math.min(Math.max(6, 1.8 * vmin(W, H)), 16);
    const brakeW = cl(triple(src, RE.brake), W, H), boostW = cl(triple(src, RE.boost), W, H);
    const pedalH = cl(triple(src, RE.pedalH), W, H);
    const colW = Math.max(3 * btn + 2 * gap, brakeW + boostW + gap);
    return {
        wheel: { l: off, r: off + wheel, t: H - off - wheel, b: H - off, size: wheel },
        col: { l: W - off - colW, r: W - off, t: H - off - (btn + gap + pedalH), b: H - off },
        btn, brakeW, boostW, pedalH, gap, port
    };
}
const hits = (a, b) => a.l < b.r && b.l < a.r && a.t < b.b && b.t < a.b;
for (const [W, H, label] of [[844, 390, 'iPhone landscape'], [740, 360, 'Android landscape'],
                             [926, 428, 'big landscape'], [360, 640, 'small portrait'],
                             [320, 568, 'narrow portrait'], [480, 850, 'tall portrait']]) {
    const L = layout(W, H), f = framing(W, H);
    const car = { l: f.carL, r: f.carR, t: f.carTop * H, b: f.carBot * H };
    console.log(`  ${label} ${W}x${H}: wheel ${L.wheel.size.toFixed(0)}px, buttons ${L.btn.toFixed(0)}px, ` +
                `pedals ${L.brakeW.toFixed(0)}+${L.boostW.toFixed(0)}px tall ${L.pedalH.toFixed(0)}`);
    ok(L.wheel.size >= (L.port ? 0.34 : 0.42) * Math.min(W, H),
       `${W}x${H}: the wheel is a proper handful (${L.wheel.size.toFixed(0)}px, ${pct(L.wheel.size / Math.min(W, H))} of the short edge)`);
    ok(L.btn >= 46 && L.pedalH >= 52 && L.brakeW >= 70 && L.boostW >= 58,
       `${W}x${H}: buttons ${L.btn.toFixed(0)}px, pedals ${L.brakeW.toFixed(0)}x${L.pedalH.toFixed(0)} — thumb-sized`);
    ok(!hits(L.wheel, car) && !hits(L.col, car),
       `${W}x${H}: controls stay off the car (car x ${car.l.toFixed(0)}-${car.r.toFixed(0)}, wheel ends ${L.wheel.r.toFixed(0)}, pedals start ${L.col.l.toFixed(0)})`);
    ok(!hits(L.wheel, L.col), `${W}x${H}: and off each other (${(L.col.l - L.wheel.r).toFixed(0)}px apart)`);
    ok(L.wheel.t > 0 && L.col.t > 0 && L.wheel.r < W && L.col.l > 0, `${W}x${H}: everything fits on screen`);
}
const landL = layout(844, 390);
ok(landL.brakeW > landL.boostW, 'BRAKE is the wider pedal, the way it is in a real car');
/* left pedal first, whichever way round they are */
ok(/id="pedal-row"[\s\S]*?id="btn-boost"[\s\S]*?id="btn-brake"/.test(htmlSrc),
   'BOOST sits on the left of the pair, BRAKE on the right');

/* =================================================================== */
console.log('\n=== steering wheel, pedals, abilities ===');
ok(/id="wheel-zone"[\s\S]*id="wheel-rim"[\s\S]*wheel-hub/.test(htmlSrc), 'a real wheel: rim, spokes and hub');
ok(!/joystick/.test(htmlSrc) && !/joystick/.test(src), 'the floating stick is gone');
const abilities = (htmlSrc.match(/id="ability-row"[\s\S]*?<\/div>\s*<div id="pedal-row"/) || [''])[0];
ok(/shoot-btn[\s\S]*skill-btn-ghost[\s\S]*skill-btn-nuke/.test(abilities), 'SHOOT, GHOST and NUKE sit above the pedals');
ok(/id="pedal-row"[\s\S]*btn-boost[\s\S]*btn-brake/.test(htmlSrc), 'BOOST and BRAKE are side by side below them');
ok(/\.pedal-boost\s*\{[^}]*order:\s*1/.test(cssSrc) && /\.pedal-brake\s*\{[^}]*order:\s*2/.test(cssSrc),
   'and BOOST is pinned to the left of BRAKE, in CSS as well as in the markup');
ok(/id="hud-left"[\s\S]*score-txt[\s\S]*speed-txt/.test(htmlSrc), 'SCORE and SPEED are top-left');
ok(/id="hud-right"[\s\S]*timer-txt[\s\S]*nitro/.test(htmlSrc), 'TIME and NITRO are top-right');
ok(!/hud-top/.test(htmlSrc) && !/hud-top/.test(cssSrc), 'nothing is left spanning the middle of the top edge');

window.playSolo();
for (let i = 0; i < 60; i++) fire();
/* the stub puts every element at the screen rect, so the wheel centre is the
   middle of the screen: aim the grabs at that */
const zone = el('wheel-zone');
const touchAt = (type, x, y) => zone.fire(type, { touches: [{ identifier: 5, clientX: x, clientY: y }] });
const CX = 422, CY = 195, R = 422;
/* Grabbing the bottom of the rim and pushing LEFT is how you turn a real
   wheel right — the wheel follows your hand, it does not mirror it. */
touchAt('touchstart', CX, CY + 300);
fire();
ok(/rotate\(/.test(el('wheel-rim').style.transform || ''), `the wheel is live (${el('wheel-rim').style.transform})`);
touchAt('touchmove', CX - 220, CY + 220);
let xFromR = livePlayerX, xRight = livePlayerX;
for (let i = 0; i < 40; i++) { fire(); xRight = Math.max(xRight, livePlayerX); }
const angleRight = +(el('wheel-rim').style.transform.match(/rotate\((-?[\d.]+)deg\)/) || [])[1];
ok(angleRight > 10, `turning the rim right rotates the wheel clockwise (+${angleRight}deg)`);
ok(xRight > xFromR + 20, `and the car follows (x ${xFromR.toFixed(0)} -> ${xRight.toFixed(0)})`);
/* and the other way — allowing real time for the turn to unwind: the car
   is yawed hard right at this point, so it has to rotate back through
   straight before it can travel left, the way a real car does */
touchAt('touchmove', CX + 220, CY + 220);
let xFromL = livePlayerX, xLeft = livePlayerX;
const headFromL = window.carPhysicsState().heading;
for (let i = 0; i < 180 && xLeft >= xFromL - 20; i++) { fire(); xLeft = Math.min(xLeft, livePlayerX); }
const angleLeft = +(el('wheel-rim').style.transform.match(/rotate\((-?[\d.]+)deg\)/) || [])[1];
ok(angleLeft < -10 && xLeft < xFromL - 20 && window.carPhysicsState().heading < headFromL - 0.15,
   `and left steers left (${angleLeft}deg, x ${xFromL.toFixed(0)} -> ${xLeft.toFixed(0)}, heading swung ${((window.carPhysicsState().heading - headFromL) * 180 / Math.PI).toFixed(0)}deg)`);
/* let go: it springs back to centre */
zone.fire('touchend', { touches: [] });
for (let i = 0; i < 90; i++) fire();
const restAngle = +(el('wheel-rim').style.transform.match(/rotate\((-?[\d.]+)deg\)/) || [])[1];
ok(Math.abs(restAngle) < 1, `it springs back to centre when released (${restAngle}deg)`);
/* near the hub it steers by drag instead of angle */
touchAt('touchstart', CX, CY);
touchAt('touchmove', CX + 60, CY);
for (let i = 0; i < 30; i++) fire();
ok(+(el('wheel-rim').style.transform.match(/rotate\((-?[\d.]+)deg\)/) || [])[1] > 30,
   'and dragging near the hub works too');
zone.fire('touchend', { touches: [] });
for (let i = 0; i < 90; i++) fire();

/* Hold a pedal with the right thumb, then steer with the left. touches[0] is
   still the pedal finger, so this used to latch onto the wrong touch.
   Fresh race first: the tests above leave the car against the right-hand wall,
   where turning right cannot move it. */
window.playSolo();
for (let i = 0; i < 20; i++) fire();
el('btn-boost').fire('touchstart', { touches: [{ identifier: 1, clientX: 700, clientY: 330 }],
                                     changedTouches: [{ identifier: 1, clientX: 700, clientY: 330 }] });
fire();
ok(el('btn-boost').classList.contains('held'), 'BOOST is held down while the wheel is being used');
const xBefore = livePlayerX;
touchAt('touchstart', CX, CY + 300);          // wheel finger, second touch
touchAt('touchmove', CX - 220, CY + 220);
for (let i = 0; i < 40; i++) fire();
const angleHeld = +(el('wheel-rim').style.transform.match(/rotate\((-?[\d.]+)deg\)/) || [])[1];
ok(angleHeld > 10, `steering still works with a pedal held (wheel at ${angleHeld}deg)`);
ok(livePlayerX > xBefore + 20, `and the car actually turns (x ${xBefore.toFixed(0)} -> ${livePlayerX.toFixed(0)})`);
ok(el('btn-boost').classList.contains('held'), 'the pedal stayed down through all of it');
zone.fire('touchend', { touches: [{ identifier: 1, clientX: 700, clientY: 330 }] });
el('btn-boost').fire('touchend', { touches: [] });
for (let i = 0; i < 120; i++) fire();
ok(Math.abs(+(el('wheel-rim').style.transform.match(/rotate\((-?[\d.]+)deg\)/) || [])[1]) < 1,
   'and the wheel centres again once both fingers are up');

const medSpeed = (frames, before = () => {}, settle = 90) => {
    before();
    const out = []; let prev = 0, skip = 0;
    for (let i = 0; i < frames; i++) {
        drive();
        const sp = speed();
        if (sp < prev - 40) skip = 140;                     // ignore the frames after a crash
        prev = sp;
        if (skip > 0) { skip--; continue; }
        if (i > settle) out.push(sp);
    }
    out.sort((a, b) => a - b);
    return out.length ? out[out.length >> 1] : 0;
};
const farmNitro = (target = 60) => { let n = 0; while (nitroPct() < target && n++ < 20000) drive(); };
const ghosted = (frames, before = () => {}, settle = 60) => {
    let k = 0; while (ammo() < 10 && k++ < 20000) drive();
    window.useGhost();
    return medSpeed(frames, before, settle);
};
const cruise = medSpeed(300);
let bk = 0; while (ammo() < 10 && bk++ < 20000) drive();
farmNitro(60);
window.useGhost();
const boosted = medSpeed(170, () => el('btn-boost').fire('touchstart', {}), 60);
el('btn-boost').fire('touchend', {});
ok(el('btn-boost').classList.contains('held') === false, 'BOOST releases cleanly');
const released = ghosted(150);
const braked = medSpeed(300, () => el('btn-brake').fire('touchstart', {}));
ok(el('btn-brake').classList.contains('held'), 'BRAKE shows pressed while held');
el('btn-brake').fire('touchend', {});
for (let i = 0; i < 60; i++) fire();
ok(!el('btn-brake').classList.contains('held'), 'and pops back up');
console.log(`  cruise ${cruise} | BOOST pedal ${boosted} | BRAKE pedal ${braked}`);
ok(cruise >= 150 && cruise <= 170, `cruise is still 160 (${cruise})`);
ok(boosted > 300, `the BOOST pedal hits nitro (${boosted} KMH)`);
ok(released < boosted - 100, `and it drops back on release (${released} KMH)`);
ok(braked >= 55 && braked <= 66, `the BRAKE pedal settles at brake speed (${braked} KMH)`);
/* pedals grey out when there is nothing to give */
el('btn-boost').fire('touchstart', {});
let litWithFuel = false, greyOnEmpty = false, d = 0;
while (d++ < 6000 && !(litWithFuel && greyOnEmpty)) {
    fire();
    const p = nitroPct(), empty = el('btn-boost').classList.contains('empty');
    if (p > 0 && !empty) litWithFuel = true;
    if (p <= 0 && empty) greyOnEmpty = true;
}
el('btn-boost').fire('touchend', {});
ok(litWithFuel && greyOnEmpty, 'the BOOST pedal greys out the moment the tank is dry');

/* =================================================================== */
console.log('\n=== traffic comes from the very start of the road ===');
const SPAWN_Y = +(src.match(/const SPAWN_Y = (-?\d+)/) || [])[1];
ok(SPAWN_Y - 690 <= FAR_Z * 0.80,
   `cars spawn at wz ${SPAWN_Y - 690}, i.e. ${pct((SPAWN_Y - 690) / FAR_Z)} of the way to the end of the road (${FAR_Z})`);
window.playSolo();
for (let i = 0; i < 60; i++) drive();
let counts = [], maxSeen = 0, overlapped = 0, near = 0, blocked = 0, spawnYs = 0;
for (let i = 0; i < 1500; i++) {
    drive();
    const list = liveEnemies || [];
    counts.push(list.length);
    maxSeen = Math.max(maxSeen, list.length);
    for (const e of list) {
        if (Math.abs(e.y - SPAWN_Y) < 2) spawnYs++;
        for (const o of list) if (o !== e && Math.abs(o.y - e.y) < 60 && Math.abs(o.x - e.x) < 40) overlapped++;
    }
    if (i < 1200) {
        const n = list.filter(e => e.y - 690 > -2200 && e.y - 690 < 200);
        near += n.length;
        if (n.length >= 3 && [-110, -37, 37, 110].every(lx => n.some(e => Math.abs(e.x - lx) < 40 &&
            n.some(o => Math.abs(o.x - lx) < 40 && Math.abs(o.y - e.y) < 200)))) blocked++;
    }
}
const avg = counts.reduce((a, b) => a + b, 0) / counts.length;
console.log(`  ${avg.toFixed(1)} cars on the road, ${(near / 1200).toFixed(1)} in view, ${maxSeen} peak`);
ok(spawnYs > 0, `every car starts at the far line (${spawnYs} spawns seen at y ${SPAWN_Y})`);
ok(overlapped === 0, `and none appear on top of another (${overlapped} overlaps in 1500 frames)`);
ok(near / 1200 > 4.5, `the road ahead is still busy (${(near / 1200).toFixed(1)} cars in view)`);
ok(blocked === 0, `with always a gap to aim for (${blocked}/1200 frames walled off)`);

/* =================================================================== */
console.log('\n=== buttons only light when they can be used ===');
const rules = [];
const cssFlat = cssSrc.replace(/\/\*[\s\S]*?\*\//g, '').replace(/@media[^{]*\{[\s\S]*?\n\}/g, '').replace(/@keyframes[\s\S]*?\n\}/g, '');
for (const m of cssFlat.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    for (const sel of m[1].split(',')) {
        const t = sel.trim();
        if (!t || /[\s>:*\[]/.test(t)) continue;
        rules.push({ ids: (t.match(/#[\w-]+/g) || []).map(x => x.slice(1)),
                     cls: (t.match(/\.[\w-]+/g) || []).map(x => x.slice(1)), decls: m[2] });
    }
}
const resolve = (id, classes, prop) => {
    let best = null, bs = null;
    rules.forEach((r, i) => {
        if (r.ids.length && r.ids[0] !== id) return;
        if (!r.cls.every(c => classes.includes(c))) return;
        const d = r.decls.split(';').map(x => x.trim()).find(x => x.startsWith(prop + ':'));
        if (!d) return;
        const s = [r.ids.length, r.cls.length, i];
        if (!bs || s[0] > bs[0] || (s[0] === bs[0] && (s[1] > bs[1] || (s[1] === bs[1] && s[2] > bs[2])))) {
            best = d.slice(prop.length + 1).trim(); bs = s;
        }
    });
    return best;
};
for (const [id, cls, label] of [['skill-btn-nuke', ['ctrl-btn','skill-btn','nuke'], 'NUKE'],
                                ['skill-btn-ghost', ['ctrl-btn','skill-btn'], 'GHOST'],
                                ['shoot-btn', ['ctrl-btn','shoot-btn'], 'SHOOT']]) {
    ok(resolve(id, cls, 'background') !== 'none' && /gradient|radial/.test(resolve(id, cls, 'background') || ''), `${label} lit when ready`);
    ok(/30, 30, 40/.test(resolve(id, cls.concat('empty'), 'background') || ''), `and ${label} greys out`);
}
ok(/30, 30, 40/.test(resolve('btn-boost', ['pedal','pedal-boost','empty'], 'background') || '') === false ||
   /30, 30, 40/.test(resolve('btn-boost', ['pedal','empty'], 'background') || ''), 'the BOOST pedal greys out too');
window.playSolo();
let nk = 0; while (ammo() < 10 && nk++ < 20000) drive();
let litNoCars = 0, litNoAmmo = 0;
for (let i = 0; i < 600; i++) {
    fire();
    const lit = !el('skill-btn-nuke').classList.contains('empty');
    if (lit && (liveEnemies || []).length === 0) litNoCars++;
    if (lit && ammo() < 5) litNoAmmo++;
}
ok(litNoCars === 0 && litNoAmmo === 0, `NUKE never lit when it cannot fire (${litNoCars}/${litNoAmmo})`);
const carsBefore = (liveEnemies || []).length;
const litBefore = !el('skill-btn-nuke').classList.contains('empty');
window.useNuke();
ok(litBefore && carsBefore > 0 && el('skill-btn-nuke').classList.contains('empty'),
   'and it goes dark the instant the road is clear');

/* =================================================================== */
console.log('\n=== the rest of the game still works ===');
const airN = +(airSrc.match(/_buildAirStreaks\(\) \{[\s\S]*?const N = (\d+)/) || [])[1];
const airX = airSrc.match(/a\.x = side \* \((\d+) \+ Math\.random\(\) \* (\d+)\)/);
ok(airN <= 40 && +airX[1] >= 150, `nitro air: ${airN} streaks out on the side lanes (|x| >= ${airX[1]})`);
ok(+(src.match(/NPC_SPEED = (\d+)/) || [])[1] === 60 && +(src.match(/SPEED_CRUISE = (\d+)/) || [])[1] === 160,
   'speeds unchanged: cruise 160, traffic 60');
ok(RACE_SECONDS === 150, 'races are still 2:30');
window.playSolo();
for (let i = 0; i < 5; i++) fire();
ok(el('timer-txt').innerText === '2:30' && el('wheel-zone').style.display === 'block' &&
   el('controls-right').style.display === 'flex', 'wheel, pedals and HUD all appear with the race');
ok(/DynamicsCompressor/.test(src), 'audio still runs through one compressor');
{
    const EV = +(src.match(/ENGINE_VOLUME = ([\d.]+)/) || [])[1];
    ok(EV >= 0.1, `the engine is turned up: ${EV} (a phone speaker needs it)`);
    /* a phone cannot reproduce the fundamental, so the note needs a harmonic
       and a filter that opens, not one bare oscillator */
    ok(/engineOsc2\s*=\s*audioCtx\.createOscillator/.test(src) && /engineOsc2\.type\s*=\s*'square'/.test(src),
       'there is a second oscillator for the rasp, not one bare saw');
    ok(/engineFilter\.frequency\.setValueAtTime\(\s*\d+ \+ speed \*/.test(src),
       'the filter opens with speed, so accelerating sounds like it');
    /* and it has to actually track the revs while driving */
    const [body, rasp] = audio.log.osc;                       // the first two oscillators are the engine
    const [cut] = audio.log.filter;
    const engineGainNode = audio.log.gain.slice().sort((a, b) => b.gain.sets.length - a.gain.sets.length)[0];
    window.playSolo();
    for (let i = 0; i < 90; i++) drive();
    const idle = body.frequency.set;
    el('btn-boost').fire('touchstart', {});
    for (let i = 0; i < 120; i++) drive();
    const flat = body.frequency.set;
    el('btn-boost').fire('touchend', {});
    ok(flat > idle * 1.5, `and the note follows the speed (${idle.toFixed(0)}Hz cruising -> ${flat.toFixed(0)}Hz under boost)`);
    ok(Math.abs(rasp.frequency.set / body.frequency.set - 2) < 0.1, 'the rasp sits an octave above the body');
    ok(cut.frequency.set > 400 && cut.frequency.sets.length > 100,
       `with the filter opening as it revs (${cut.frequency.sets[0].toFixed(0)}Hz -> ${cut.frequency.set.toFixed(0)}Hz)`);
    ok(engineGainNode.gain.sets.some(v => v > EV * 0.5), 'and the engine is audible while a race is running');
    ok(audio.log.resumed > 0 && audio.log.ctx.state === 'running',
       'and the audio context is woken up, so a phone is never left silent');
}
window.playSolo();
for (let i = 0; i < 3; i++) fire();
ok(nitroPct() === 80, `every race starts with a mostly full tank (${nitroPct()}%)`);

for (const style of car3d.STYLE_NAMES) {
    const car = car3d.buildCar(style, '#00f0ff');
    const pts = [];
    car.updateMatrixWorld(true);
    car.traverse(o => {
        if (!o.isMesh || o.userData.decal || !o.geometry) return;
        const p = o.geometry.attributes.position;
        for (let i = 0; i < p.count; i++) pts.push(new THREE.Vector3().fromBufferAttribute(p, i).applyMatrix4(o.matrixWorld));
    });
    const bb = new THREE.Box3().setFromPoints(pts);
    const at = (t) => pts.filter(t);
    const frontR = car.userData.handle.wheels[0].position.y, rearR = car.userData.handle.wheels[2].position.y;
    ok(Math.abs(bb.max.x - bb.min.x - 44) <= 4 && bb.max.y - bb.min.y > 15 && bb.max.y - bb.min.y < 24 &&
       Math.max(...at(p => p.z < -35).map(p => Math.abs(p.x))) > 19 &&
       Math.max(...at(p => p.z > 34).map(p => p.y)) > rearR * 2 &&
       Math.max(...at(p => p.z > -14 && p.z < -3 && Math.abs(p.x) < 8).map(p => p.y)) > frontR * 2,
       `${style}: still an F1 single-seater`);
}
window.playSolo();
for (let i = 0; i < 60; i++) fire();
const wP = new World(env.gameCanvas); wP.renderer.render = () => {};
for (let c = 0; c < 5; c++) { wP.playerHit(); for (let i = 0; i < 60; i++) wP.setPlayer(0, 0, { steer: 0, brake: 0, boost: 0, phase: i }); }
ok(Math.abs(wP.playerCar.rotation.x) < 0.001, 'car dead level after five crashes');
let gk = 0; while (ammo() < 10 && gk++ < 20000) drive();
const ga = ammo(); window.useGhost();
ok(ammo() === ga - 5, `GHOST costs 5 (${ga} -> ${ammo()})`);
let on = 0, onDrop = 0, offDrop = 0, ps = score();
const ghostSub = el('skill-btn-ghost').querySelector('.btn-sub');
for (let i = 0; i < 700; i++) {
    if (i % 170 === 0) window.useGhost();
    drive();
    const now = score(); const crashedNow = now < ps - 400; ps = now;
    if (/^\d+s$/.test(ghostSub.innerText || '')) { on++; if (crashedNow) onDrop++; } else if (crashedNow) offDrop++;
}
ok(on > 250 && onDrop === 0, `ghost still phases through traffic (${onDrop} crashes in ${on} ghost frames)`);

console.log('\n=== long run, both shapes, no exceptions ===');
let err = null, frames = 0;
try {
    for (let i = 0; i < 1200; i++) {
        if (!rafCb) break;
        if (i === 200) { el('btn-boost').fire('touchstart', {}); env.win.fire('keydown', { key: 'w' }); }
        if (i === 400) { el('btn-boost').fire('touchend', {}); env.win.fire('keyup', { key: 'w' }); }
        if (i === 600) { el('btn-brake').fire('touchstart', {}); env.win.fire('keydown', { key: 'a' }); }
        if (i === 700) { el('btn-brake').fire('touchend', {}); env.win.fire('keyup', { key: 'a' }); }
        if (i === 800) { touchAt('touchstart', CX, CY + 300); touchAt('touchmove', CX + 200, CY + 200); }
        if (i === 1000) zone.fire('touchend', { touches: [] });
        if (i % 120 === 0) { window.useGhost(); window.useNuke(); window.shootBullet(); }
        fire(); frames++;
    }
} catch (e) { err = e; }
ok(!err, `1200 frames, wheel + pedals + abilities, no exception ${err ? '(' + err.stack.split('\n').slice(0, 2).join(' | ') + ')' : ''}`);
ok(frames === 1200, `all 1200 frames rendered (${frames})`);
for (const [vw, vh] of [[844, 390], [740, 360], [480, 850], [360, 640], [1024, 768]]) {
    env.setSize(vw, vh);
    let e2 = null; try { for (let i = 0; i < 60; i++) fire(); } catch (e) { e2 = e; }
    ok(!e2, `${vw}x${vh}: 60 frames clean ${e2 ? '(' + e2.message + ')' : ''}`);
}
env.setSize(844, 390);

/* =================================================================== */
console.log('\n=== upright, the game locks until you turn the phone ===');
ok(/id="rotate-screen"/.test(htmlSrc) && /rotate-title/.test(htmlSrc), 'there is a lock screen');
ok(/@keyframes rotateTilt/.test(cssSrc) && /@keyframes rotatePulse/.test(cssSrc) &&
   /animation: rotateTilt/.test(cssSrc), 'and it is animated: the phone turns itself, rings pulse');
ok(/\.rotate-lock\s*\{[^}]*z-index:\s*(\d+)/.test(cssSrc) &&
   +cssSrc.match(/\.rotate-lock\s*\{[^}]*z-index:\s*(\d+)/)[1] > 20, 'it sits above the lobby and the HUD');
env.setSize(480, 850);
grab().checkOrientation();
ok(el('rotate-screen').classList.contains('show'), 'upright: the screen is locked');
window.playSolo();
for (let i = 0; i < 30; i++) fire();
const lockedScore = score(), lockedTime = el('timer-txt').innerText, lockedX = livePlayerX;
for (let i = 0; i < 120; i++) fire();
T.advance(4000); await flush();
ok(score() === lockedScore && el('timer-txt').innerText === lockedTime && livePlayerX === lockedX,
   `and the race is held still while it is up (score ${lockedScore}, clock ${lockedTime})`);
env.setSize(844, 390);
grab().checkOrientation();
ok(!el('rotate-screen').classList.contains('show'), 'rotated: the lock lifts');
for (let i = 0; i < 30; i++) fire();
ok(livePlayerX !== lockedX || score() !== lockedScore, 'and the race picks up where it left off');
T.advance(1500); await flush();
ok(el('timer-txt').innerText !== lockedTime, 'the clock runs again');

console.log('\n=== quick match still pairs two strangers and cleans up ===');
T.advance(RACE_MS); await flush();
el('random-name').value = 'ALICE';
A.findRandomGame();
await flush();
ok(Object.keys(db._get(['car_matchmaking']) || {}).length === 1, 'first player queues');
await import('../script.js?player2');
const B = grab();
el('random-name').value = 'BOB';
B.findRandomGame();
await flush(); await flush();
const rooms = db._get(['car_rooms']) || {};
const codes = Object.keys(rooms);
ok(codes.length === 1 && Object.keys((rooms[codes[0]] || {}).players || {}).length === 2, 'one room, both drivers');
const before = T.createdIntervals;
T.advance(4500);
ok(T.createdIntervals >= before + 2, 'and both games start themselves');
T.advance(RACE_MS); await flush();
T.advance(20000); await flush();
ok(!db._get(['car_rooms', codes[0]]), 'the room is wiped from Firebase afterwards');
const hist = audio.log.history;
ok(hist.lastIndexOf(0) >= 0, 'the engine is cut when a race ends');
window.playSolo();
for (let i = 0; i < 5; i++) fire();
ok(hist.slice(hist.lastIndexOf(0) + 1).some(v => v > 0.05), 'and the engine comes back for the next race');

/* =================================================================== */
console.log('\n=== hills, banking and the roadside city ===');
{
    const w = new World(env.gameCanvas); w.renderer.render = () => {};
    env.setSize(844, 390); w.resize(); w._playerZ = 0;
    let maxGrade = 0, lo = 0, hi = 0, maxBank = 0, flat = true;
    for (let seed = 0; seed < 24; seed++) {
        reseedCurves(seed);
        for (let step = 0; step < 6; step++) {
            w.scrollRoad(seed * 977 + step * 4100);
            w.setPlayer(0, 0, { steer: 0, brake: 0, boost: 0, phase: 0 });
            if (Math.abs(w.heightAt(0)) > 1e-9) flat = false;
            maxGrade = Math.max(maxGrade, Math.abs(w.roadGrade()));
            for (const d of [500, 1500, 3000]) { const h = w.heightAt(-d); lo = Math.min(lo, h); hi = Math.max(hi, h); }
            maxBank = Math.max(maxBank, Math.abs(w.bankSlopeAt(-1200)));
        }
    }
    ok(flat, 'the road is always flat and level under the car itself');
    ok(hi - lo > 90, `and it really rolls: ${lo.toFixed(0)}..+${hi.toFixed(0)} units of crest and dip ahead`);
    ok(maxGrade <= 0.055 && maxGrade > 0.02, `grades stay road-like but real (worst ${(maxGrade * 100).toFixed(1)}%)`);
    ok(maxBank > 0.03, `corners are banked (up to ${(Math.atan(maxBank) * 180 / Math.PI).toFixed(1)}deg)`);
    /* the outside of a bend is the high side */
    let checked = 0, right = 0;
    for (let seed = 0; seed < 24; seed++) {
        reseedCurves(seed);
        for (let s = 0; s < 6; s++) {
            w.scrollRoad(seed * 613 + s * 3700);
            for (const z of [-600, -1400]) {
                const yr = w.trackHeadingAtS(w.roadSAt(z - 60)) - w.trackHeadingAtS(w.roadSAt(z + 60));
                const b = w.bankSlopeAt(z);
                if (Math.abs(yr) > 0.004 && Math.abs(b) > 0.01) { checked++; if (Math.sign(b) === -Math.sign(yr)) right++; }
            }
        }
    }
    ok(checked > 20 && right === checked, `and banked the right way round: outside edge up in ${right}/${checked} bends`);
    /* the city is actually there, on screen, and clear of the road */
    reseedCurves(CURVE_SEED);
    w.scrollRoad(12345);
    w.setPlayer(0, 0, { steer: 0, brake: 0, boost: 0, phase: 0 });
    w.camera.updateMatrixWorld(true);
    const m4 = new THREE.Matrix4();
    let towersSeen = 0, clear = 1e9, nan = 0;
    for (const b of w.buildings) for (let i = 0; i < b.count; i++) {
        b.getMatrixAt(i, m4);
        const e = m4.elements;
        if (e.some(n => !isFinite(n))) nan++;
        clear = Math.min(clear, Math.abs(e[12] - w.bendAt(e[14])) - Math.abs(e[0]) / 2);
        const v = new THREE.Vector3(e[12], e[13] + 80, e[14]).project(w.camera);
        if (e[14] < 250 && Math.abs(v.x) < 1 && Math.abs(v.y) < 1) towersSeen++;
    }
    ok(w.buildings.length === 2 && w.posters.length === 4 && w.lampHeads.count === 36 && !w.billboards && !w.gBeams,
       'roadside built: towers and street lamps with pole posters — nothing hangs over the road');
    /* every poster stands clear of the tarmac and above the cars */
    let posterClear = 1e9, posterBase = 1e9, posterNan = 0;
    for (const pm of w.posters) for (let i = 0; i < pm.count; i++) {
        pm.getMatrixAt(i, m4);
        const e = m4.elements;
        if (e.some(n => !isFinite(n))) posterNan++;
        posterClear = Math.min(posterClear, Math.abs(e[12] - w.bendAt(e[14])) - 11.5);
        posterBase = Math.min(posterBase, (e[13] - 20) - w.terrainYAt(e[14], e[12] - w.bendAt(e[14])));
    }
    ok(posterClear > 225 && posterBase > 21 && posterNan === 0,
       `posters ride on the poles at the shoulder (inner edge ${posterClear.toFixed(0)}u out, bottom ${posterBase.toFixed(0)}u up)`);
    ok(towersSeen > 4, `and visible from the driver's seat (${towersSeen} towers in frame)`);
    ok(clear > 230 && nan === 0, `standing clear of the tarmac (nearest face ${clear.toFixed(0)}u out, no NaNs)`);
    reseedCurves(CURVE_SEED);
}

console.log('\n=== traffic drives, and physics runs on time, not frames ===');
window.playSolo();
let laneChanges = 0; const laneSeen = new Map(); let vMin = 1e9, vMax = 0, brakeFrames = 0;
for (let i = 0; i < 2400; i++) {
    drive();
    for (const e of (liveEnemies || [])) {
        vMin = Math.min(vMin, e.v); vMax = Math.max(vMax, e.v);
        if (e.brake) brakeFrames++;
        const prev = laneSeen.get(e);
        if (prev !== undefined && Math.abs(prev - e.laneX) > 30) laneChanges++;
        laneSeen.set(e, e.laneX);
    }
}
console.log(`  traffic pace ${vMin.toFixed(0)}..${vMax.toFixed(0)} KMH, ${laneChanges} lane changes, ${brakeFrames} braking car-frames`);
ok(vMax - vMin > 8, 'each driver settles at their own pace around the old 60');
ok(brakeFrames > 0, 'and they brake for the car in front instead of driving through it');
ok(laneChanges > 3, 'and they change lanes when there is a gap');
/* one simulated second from rest must be the same second at any refresh rate */
const burst = (frames, ms) => {
    window.playSolo();
    let t = burst.t || 1000;
    for (let i = 0; i < frames; i++) {
        aimWheel();
        const cb = rafCb; rafCb = null; t += ms; if (cb) cb(t);
    }
    burst.t = t;
    return speed();
};
const at60 = burst(60, 1000 / 60);
const at120 = burst(120, 1000 / 120);
const at30 = burst(30, 1000 / 30);
console.log(`  one second from rest: 30Hz ${at30} | 60Hz ${at60} | 120Hz ${at120}`);
ok(at60 > 120 && Math.abs(at120 - at60) < at60 * 0.14 && Math.abs(at30 - at60) < at60 * 0.18,
   'a 120Hz phone no longer runs the game at double speed');

/* =================================================================== */
console.log('\n=== a real car: straight means straight, bends do not carry you ===');
/* The simulator contract, locked both ways:
   - where the road runs straight, a hands-off car holds its lane; and
   - where the road bends, a hands-off car keeps its WORLD heading and
     travels in a straight line across the lanes — the road turns away
     under it, exactly as in Vice City or any car simulator. Only the
     steering (and the barriers, at the very end of the drift) may ever
     change the heading. The old suite asserted the opposite — that the
     car was glued to its lane through bends — which is precisely the
     on-rails feel this replaces. Seeds are chosen from the geometry at
     the car's current station, so the stretches are real. */
{
    const wScan = new World(env.gameCanvas); wScan.renderer.render = () => {};
    const predict = (S0, dist) => {            // hands-off drift, geometry alone
        const psi = wScan.trackHeadingAtS(S0);
        let dd = 0, hMin = 1e9, hMax = -1e9;
        for (let q = 0; q < dist; q += 25) dd += (Math.tan(psi) - wScan.trackSlopeAtS(S0 + q)) * 25;
        for (let q = 0; q < dist; q += 100) {
            const hh = wScan.trackHeadingAtS(S0 + q);
            hMin = Math.min(hMin, hh); hMax = Math.max(hMax, hh);
        }
        return { drift: dd, swing: hMax - hMin };
    };
    const findSeed = (test) => {
        window.playSolo(); fire();                     // learn the station
        const S0 = window.carPhysicsState().station;
        for (let seed = 0; seed < 160; seed++) {
            reseedCurves(seed);
            const p = predict(S0, 5200);
            if (test(p)) { window.playSolo(); reseedCurves(seed); return { seed, ...p }; }
        }
        return null;
    };
    const runHandsOff = (dist) => {
        fire();
        const s0 = window.carPhysicsState();
        let maxOff = 0, headChange = 0, hMin = s0.roadHeading, hMax = s0.roadHeading, n = 0;
        while (n++ < 2400) {
            fire();
            const s = window.carPhysicsState();
            maxOff = Math.max(maxOff, Math.abs(s.offset));
            headChange = Math.max(headChange, Math.abs(s.heading - s0.heading));
            hMin = Math.min(hMin, s.roadHeading); hMax = Math.max(hMax, s.roadHeading);
            if (s.station - s0.station >= dist) break;
        }
        return { end: window.carPhysicsState(), maxOff, headChange, swing: hMax - hMin };
    };
    /* --- the straight --- */
    const flat = findSeed(p => Math.abs(p.drift) < 14 && p.swing * 180 / Math.PI < 1.6);
    ok(!!flat, 'found a genuinely straight stretch of road to test on');
    if (flat) {
        const r = runHandsOff(4600);
        console.log(`  straight: road heading wandered ${(r.swing * 180 / Math.PI).toFixed(2)}deg, car offset ended ${r.end.offset.toFixed(1)} (worst ${r.maxOff.toFixed(1)})`);
        ok(r.headChange < 0.001, 'on a straight, hands off: the heading never moves a hair');
        ok(r.maxOff < 25, 'and the car simply holds its lane — no wandering, no auto-turn');
    }
    /* --- the bend --- */
    const bendy = findSeed(p => Math.abs(p.drift) > 110 && Math.abs(p.drift) < 165 && p.swing * 180 / Math.PI > 2.2);
    ok(!!bendy, 'found a real bend to test on');
    if (bendy) {
        const r = runHandsOff(4800);
        console.log(`  bend: road heading swung ${(r.swing * 180 / Math.PI).toFixed(2)}deg, car drifted to ${r.end.offset.toFixed(0)} across the lanes, heading change ${(r.headChange * 180 / Math.PI).toFixed(3)}deg`);
        ok(r.headChange < 0.001, 'on a bend, hands off: the car still never turns itself');
        ok(Math.abs(r.end.offset) > 45 && r.maxOff < 192,
           'but it does not follow the road either — it runs straight and crosses the lanes until you steer');
    }
    /* --- and steering really is the thing that turns it --- */
    window.playSolo();
    drive(200);                                        // settle at cruise, centred
    const before = window.carPhysicsState();
    for (let i = 0; i < 40; i++) { window.wheelSetAngle(60); fire(); }
    const turned = window.carPhysicsState();
    ok((turned.heading - before.heading) * 180 / Math.PI > 3 && turned.offset > before.offset + 15,
       `holding the wheel right yaws the car right (+${((turned.heading - before.heading) * 180 / Math.PI).toFixed(1)}deg) and it travels that way`);
    drive(300);
    ok(Math.abs(window.carRoadOffset()) < 45, 'and a driver who counter-steers brings it back to the middle');
}

console.log(fail ? `\n${fail} CHECK(S) FAILED` : '\nALL CHECKS PASSED');
process.exit(fail ? 1 : 0);
