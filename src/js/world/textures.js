/* =============================================================================
   NEON DRIVE — procedural roadside textures
   -----------------------------------------------------------------------------
   Canvas-drawn tower facades, lamp-pole posters and the horizon skyline.
   These are generated once and shared by the meshes in scene3d.js.
   ============================================================================= */

import * as THREE from 'three';
import { hash1 } from './track.js';

/* ------------------------------------------------------------------ *
 *  Roadside textures, drawn once and shared by every World: tower
 *  facades with lit windows, neon signs, and the far skyline that sits
 *  on the horizon. All in the game's cyan / pink neon palette.
 * ------------------------------------------------------------------ */
let _facades = null;
export function facadeTextures() {
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

/* Portrait posters for the lamp poles: one short word stacked letter
   by letter, the way real pole banners read, over a small strapline. */
let _posters = null;
export function posterTextures() {
    if (_posters) return _posters;
    const specs = [
        { w: 'NEON', s: 'DRIVE', c: '#00f0ff' },
        { w: 'NITRO', s: 'MAX BOOST', c: '#ff0055' },
        { w: 'TURBO', s: 'CITY', c: '#ffea00' },
        { w: 'APEX', s: 'RACING CLUB', c: '#00ff66' }
    ];
    _posters = specs.map(spec => {
        const c = document.createElement('canvas');
        c.width = 256; c.height = 448;
        const g = c.getContext('2d');
        g.fillStyle = '#04060d'; g.fillRect(0, 0, 256, 448);
        g.strokeStyle = spec.c; g.lineWidth = 9; g.strokeRect(11, 11, 234, 426);
        g.strokeStyle = 'rgba(255,255,255,0.32)'; g.lineWidth = 2; g.strokeRect(24, 24, 208, 400);
        g.fillStyle = spec.c; g.fillRect(24, 24, 208, 12);            // header bar
        g.textAlign = 'center'; g.textBaseline = 'middle';
        g.shadowColor = spec.c; g.shadowBlur = 22;
        g.fillStyle = spec.c;
        g.font = 'italic 900 84px "Segoe UI", Roboto, sans-serif';
        const letters = spec.w.split('');
        const stepY = 72, blockH = letters.length * stepY;
        let cy = 46 + (356 - blockH) / 2 + stepY / 2;                 // centred above the strapline
        for (const ch of letters) { g.fillText(ch, 128, cy); cy += stepY; }
        g.shadowBlur = 9; g.fillStyle = '#eaf4ff';
        g.font = 'bold 27px "Segoe UI", Roboto, sans-serif';
        g.fillText(spec.s, 128, 408);
        const t = new THREE.CanvasTexture(c);
        t.colorSpace = THREE.SRGBColorSpace; t.anisotropy = 4;
        return t;
    });
    return _posters;
}

let _skyline = null;
export function skylineTexture() {
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
