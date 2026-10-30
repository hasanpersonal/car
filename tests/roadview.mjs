/* Prints the road as ASCII from the real camera, so the bends and the framing
   can be checked without a browser. Dev tool: node roadview.mjs [seed] [offset] */
import { makeEnv } from './glstub.mjs';
import * as THREE from 'three';
const W = 844, H = 390, COLS = 84, ROWS = 26;
const env = makeEnv(W, H);
globalThis.document = env.doc; globalThis.window = env.win; globalThis.self = env.win;
const { World, reseedCurves } = await import('../src/js/world/scene3d.js');
const w = new World(env.gameCanvas); w.renderer.render = () => {};
w.resize(); w._playerZ = 0;
const sx = (x, y, z) => { const v = new THREE.Vector3(x, y, z).project(w.camera); return (v.x + 1) / 2 * W; };
const sy = (x, y, z) => { const v = new THREE.Vector3(x, y, z).project(w.camera); return (1 - v.y) / 2 * H; };

function plot(label, seed, off) {
    reseedCurves(seed); w.roadOffset = off; w._shapeRoad();
    w.setPlayer(0, 0, { steer: 0, brake: 0, boost: 0, phase: 0 });
    w.camera.updateMatrixWorld(true);
    const grid = Array.from({ length: ROWS }, () => Array(COLS).fill(' '));
    /* sample the road edges every 40 units of depth and stamp the rows */
    for (let d = 0; d <= 6000; d += 25) {
        const c = w.bendAt(-d);
        const l = sx(c - 220, 0, -d), r = sx(c + 220, 0, -d);
        const yy = sy(c, 0, -d);
        const row = Math.round(yy / H * (ROWS - 1));
        if (row < 0 || row >= ROWS) continue;
        for (let col = Math.round(l / W * (COLS - 1)); col <= Math.round(r / W * (COLS - 1)); col++)
            if (col >= 0 && col < COLS) grid[row][col] = '#';
    }
    /* the car: bottom rows, centre */
    const pl = sx(-22, 0, -42), pr = sx(22, 0, 42);
    for (let row = ROWS - 4; row < ROWS; row++)
        for (let col = Math.round(pl / W * (COLS - 1)); col <= Math.round(pr / W * (COLS - 1)); col++)
            if (col >= 0 && col < COLS) grid[row][col] = 'A';
    console.log('\n' + label + '   (#' + ' = tarmac, A = your car)');
    console.log('+' + '-'.repeat(COLS) + '+');
    grid.forEach(r => console.log('|' + r.join('') + '|'));
    console.log('+' + '-'.repeat(COLS) + '+');
}
const [a, b] = process.argv.slice(2);
if (a !== undefined) {
    plot(`seed ${a}, ${b || 0} units in`, +a, +(b || 0));
} else {
    plot('seed 3, just after the start', 3, 0);
    plot('seed 3, 24 000 units in', 3, 24000);
    plot('seed 11, 48 000 units in', 11, 48000);
    plot('seed 5, 71 000 units in', 5, 71000);
}
