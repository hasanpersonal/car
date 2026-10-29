/* Geometry probe: how does the scene frame up on each device shape, and in
   landscape? Used to tune the camera. Not part of the suite. */
import { makeEnv } from './glstub.mjs';
const env = makeEnv(844, 390);
globalThis.document = env.doc; globalThis.window = env.win; globalThis.self = env.win;
const THREE = await import('three');
const { World, CAM } = await import('../scene3d.js');

const CARB = [[-22, 0, -42.5], [22, 0, -42.5], [-22, 21, 41], [22, 21, 41], [0, 21, -42.5]];

function measure(W, H, t) {
    env.setSize(W, H);
    const w = new World(env.gameCanvas); w.renderer.render = () => {};
    Object.assign(CAM, t);
    w.camera.fov = CAM.fov;
    w.camera.position.set(0, CAM.camY, CAM.camZ);
    w.camera.lookAt(0, CAM.lookY, CAM.lookZ);
    w.camera.aspect = W / H; w.camera.updateProjectionMatrix(); w.camera.updateMatrixWorld(true);
    w.setPlayer(0, 0, { steer: 0, brake: 0, boost: 0, phase: 0 });
    const p = (x, y, z) => { const v = new THREE.Vector3(x, y, z).project(w.camera); return { x: (v.x + 1) / 2 * W, y: (1 - v.y) / 2 * H }; };
    const roadW = Math.abs(p(220, 0, 0).x - p(-220, 0, 0).x) / W;
    const roadAhead = Math.abs(p(220, 0, -1500).x - p(-220, 0, -1500).x) / W;
    let top = 1e9, bot = -1e9, left = 1e9, right = -1e9;
    for (const c of CARB) { const q = p(...c); top = Math.min(top, q.y); bot = Math.max(bot, q.y); left = Math.min(left, q.x); right = Math.max(right, q.x); }
    const horizon = p(0, 0, -100000).y / H;
    const spawn = p(0, 0, -2490).y / H;
    const fog = Math.min(1, Math.max(0, (Math.abs(-2490 - CAM.camZ) - 700) / 2200));
    return { roadW, roadAhead, carTop: top / H, carBot: bot / H, carH: bot - top, carW: right - left, horizon, spawn, fog };
}
const show = (label, m) => console.log(
    `${label.padEnd(34)} road ${(m.roadW * 100).toFixed(0)}%@car ${(m.roadAhead * 100).toFixed(0)}%@1500u | ` +
    `car ${m.carW.toFixed(0)}x${m.carH.toFixed(0)}px top ${(m.carTop * 100).toFixed(0)}% bot ${(m.carBot * 100).toFixed(0)}% | ` +
    `horizon ${(m.horizon * 100).toFixed(0)}% spawn ${(m.spawn * 100).toFixed(0)}% fog ${(m.fog * 100).toFixed(0)}%`);

/* score a landscape candidate: wide road, low readable car, horizon in
   frame, cars entering right at the vanishing point */
const score = (m) => {
    let s = 0;
    s += Math.max(0, 0.85 - m.roadW) * 300;                       // road must fill the width
    s += Math.max(0, 0.26 - m.roadAhead) * 200;                   // and stay wide up the track
    s += Math.abs(m.carH - 78) / 78 * 40;                         // car about 78px tall
    s += Math.max(0, 0.68 - m.carBot) * 400;                      // car sits LOW
    s += Math.max(0, m.carBot - 0.90) * 400;
    s += Math.max(0, 0.05 - m.horizon) * 300 + Math.max(0, m.horizon - 0.20) * 300;
    s += Math.max(0, m.spawn - m.horizon - 0.04) * 400;           // cars appear at the horizon
    return s;
};
let best = null;
for (const fov of [38, 41, 44, 47, 50])
for (const lookZ of [-700, -850, -1000, -1150, -1300])
for (const camY of [185, 200, 215, 230])
for (const camZ of [290, 310, 330]) {
    const t = { fov, camY, camZ, lookY: -90, lookZ, follow: 0.65 };
    const m = measure(844, 390, t);
    const sc = score(m);
    if (!best || sc < best.sc) best = { sc, t, m };
}
console.log('=== best landscape rig (844x390) ===');
show(JSON.stringify(best.t), best.m);
console.log('score', best.sc.toFixed(1), '\n');
console.log('=== that rig across landscape shapes ===');
for (const [W, H] of [[844, 390], [740, 360], [926, 428], [1024, 768], [667, 375]]) show(`${W}x${H}`, measure(W, H, best.t));
console.log('\n=== portrait must be untouched (blend by aspect) ===');
const lerp = (a, b, t) => a + (b - a) * t;
for (const [W, H] of [[480, 850], [360, 640], [412, 915], [768, 1024]]) {
    const tt = Math.max(0, Math.min(1, ((W / H) - 0.72) / (1.75 - 0.72)));
    show(`${W}x${H} blend ${tt.toFixed(2)}`, measure(W, H, {
        fov: lerp(60, best.t.fov, tt), camY: lerp(220, best.t.camY, tt), camZ: lerp(330, best.t.camZ, tt),
        lookY: lerp(-90, best.t.lookY, tt), lookZ: lerp(-340, best.t.lookZ, tt), follow: 0.65 }));
}
