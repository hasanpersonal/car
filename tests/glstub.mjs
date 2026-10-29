/* Minimal DOM + WebGL stubs plus a virtual clock, so the real game code can
   be driven deterministically under node. */
import { createCanvas } from '@napi-rs/canvas';

const CONSTS = new Map(), NAMES = new Map();
let nextConst = 0x8000;
const constant = (n) => {
    if (!CONSTS.has(n)) { const v = nextConst++; CONSTS.set(n, v); NAMES.set(v, n); }
    return CONSTS.get(n);
};
function paramValue(p) {
    const n = NAMES.get(p) || '';
    if (/VERSION|VENDOR|RENDERER/.test(n)) return 'WebGL 2.0 (stub)';
    if (/BOX|VIEWPORT/.test(n)) return new Int32Array([0, 0, 1, 1]);
    if (/RANGE/.test(n)) return new Float32Array([1, 1]);
    if (/MAX_TEXTURE_SIZE|MAX_CUBE|MAX_RENDERBUFFER/.test(n)) return 16384;
    if (/MAX_/.test(n)) return 1024;
    if (/SAMPLES/.test(n)) return 4;
    return 0;
}
function makeGL() {
    const fns = new Map();
    return new Proxy({}, {
        get(_t, prop) {
            if (typeof prop !== 'string') return undefined;
            if (/^[A-Z][A-Z0-9_]*$/.test(prop)) return constant(prop);
            if (prop === 'drawingBufferWidth') return 480;
            if (prop === 'drawingBufferHeight') return 850;
            if (!fns.has(prop)) fns.set(prop, (...args) => {
                switch (prop) {
                    case 'getContextAttributes':
                        return { alpha: false, depth: true, stencil: false, antialias: true,
                                 premultipliedAlpha: true, preserveDrawingBuffer: false,
                                 powerPreference: 'default', failIfMajorPerformanceCaveat: false,
                                 xrCompatible: false };
                    case 'getExtension': return null;
                    case 'getParameter': return paramValue(args[0]);
                    case 'getShaderPrecisionFormat': return { precision: 23, rangeMin: 127, rangeMax: 127 };
                    case 'getProgramParameter': {
                        const n = (NAMES.get(args[1]) || '') + (NAMES.get(args[0]) || '');
                        if (/LINK_STATUS|VALIDATE_STATUS/.test(n)) return true;
                        if (/ACTIVE_/.test(n)) return 0;
                        return 1;
                    }
                    case 'getShaderParameter': return true;
                    case 'getProgramInfoLog': case 'getShaderInfoLog': return '';
                    case 'getSupportedExtensions': return [];
                    case 'getUniformLocation': return {};
                    case 'getAttribLocation': return 0;
                    case 'getError': return 0;
                    case 'isContextLost': return false;
                    case 'createProgram': case 'createShader': case 'createBuffer':
                    case 'createTexture': case 'createFramebuffer': case 'createRenderbuffer':
                    case 'createVertexArray': case 'createSampler': case 'getUniformBlockIndex':
                        return {};
                    default: return undefined;
                }
            });
            return fns.get(prop);
        }
    });
}

/* ---- virtual clock: timers only advance when the test says so ---- */
export class Timers {
    constructor() { this.t = []; this.nextId = 1; this.now = 0; this.createdIntervals = 0; }
    setTimeout(fn, ms) { const id = this.nextId++; this.t.push({ id, fn, at: this.now + Math.max(0, ms || 0) }); return id; }
    setInterval(fn, ms) { const id = this.nextId++; this.createdIntervals++; this.t.push({ id, fn, at: this.now + Math.max(1, ms || 1), every: Math.max(1, ms || 1) }); return id; }
    clear(id) { this.t = this.t.filter(x => x.id !== id); }
    get intervalCount() { return this.t.filter(x => x.every).length; }
    advance(ms) {
        const target = this.now + ms;
        let guard = 0;
        while (guard++ < 200000) {
            let due = null;
            for (const x of this.t) if (x.at <= target && (!due || x.at < due.at)) due = x;
            if (!due) break;
            this.now = due.at;
            if (due.every) due.at = this.now + due.every;
            else this.t = this.t.filter(x => x !== due);
            due.fn();
        }
        this.now = target;
    }
}

export function makeEnv(width = 480, height = 850) {
    const timers = new Timers();
    const listeners = {};
    const gameCanvas = {
        width, height, clientWidth: width, clientHeight: height,
        style: {}, _l: {},
        addEventListener(t, f) { this._l[t] = f; },
        removeEventListener() {},
        getBoundingClientRect: () => ({ left: 0, top: 0, width, height }),
        getContext(kind) { return kind === '2d' ? createCanvas(8, 8).getContext('2d') : makeGL(); }
    };
    const els = {};
    const mkEl = (id) => ({
        id, value: '', innerText: '', innerHTML: '', scrollTop: 0, scrollHeight: 0,
        style: new Proxy({}, { get: (t, k) => t[k] || '', set: (t, k, v) => (t[k] = v, true) }),
        classList: {
            _s: new Set(),
            add(c) { this._s.add(c); }, remove(c) { this._s.delete(c); },
            toggle(c, on) { on === undefined ? (this._s.has(c) ? this._s.delete(c) : this._s.add(c)) : (on ? this._s.add(c) : this._s.delete(c)); },
            contains(c) { return this._s.has(c); }
        },
        _l: {},
        addEventListener(t, f) { this._l[t] = f; },
        fire(t, ev) { this._l[t] && this._l[t](Object.assign({ preventDefault() {}, stopPropagation() {}, target: this }, ev)); },
        querySelector(sel) { return (this._q || (this._q = {}))[sel] || ((this._q[sel] = mkEl(sel))); },
        querySelectorAll(sel) { return (this._qa || (this._qa = {}))[sel] || ((this._qa[sel] = [mkEl(sel)])); },
        closest(sel) { return this._closest === undefined ? null : this._closest; },
        appendChild() {}, focus() {},
        getBoundingClientRect: () => ({ left: 0, top: 0, width, height }),
        requestFullscreen: () => Promise.resolve()
    });
    const docCache = {};
    const doc = {
        getElementById(id) { return id === 'canvas' ? gameCanvas : (els[id] || (els[id] = mkEl(id))); },
        querySelectorAll: (sel) => (docCache[sel] = docCache[sel] || [mkEl(sel), mkEl(sel)]),
        createElement(tag) { return tag === 'canvas' ? createCanvas(64, 64) : mkEl(tag); },
        addEventListener() {}
    };
    const win = {
        innerWidth: width, innerHeight: height, devicePixelRatio: 2,
        addEventListener(t, f) { (listeners[t] || (listeners[t] = [])).push(f); },
        removeEventListener() {},
        requestAnimationFrame: () => 0,
        fire(t, ev) { for (const f of (listeners[t] || [])) f(Object.assign({ preventDefault() {}, target: mkEl('x') }, ev)); }
    };
    return { doc, win, gameCanvas, timers, listeners, setSize(w, h) {
        gameCanvas.clientWidth = w; gameCanvas.clientHeight = h;
        gameCanvas.width = w; gameCanvas.height = h;
        win.innerWidth = w; win.innerHeight = h;
    } };
}

/* Web Audio stub that records what was actually asked for: every node by
   kind, in creation order, and every value set on every parameter. */
export function makeAudio() {
    const log = { gains: [], history: [] };
    class Param {
        constructor(v, what = '?') {
            this.value = v; this.what = what; this.sets = [];
            log.gains.push(this);
        }
        setValueAtTime(v) { this.value = v; this.set = v; this.sets.push(v); log.history.push(v); return this; }
        linearRampToValueAtTime(v) { return this; }
        exponentialRampToValueAtTime(v) { this.ramp = v; return this; }
    }
    const node = (kind, extra = {}) => {
        const n = Object.assign({
            kind,
            connect() { return this; }, disconnect() {}, start() {}, stop() {},
            frequency: new Param(440, kind + '.frequency'),
            gain: new Param(1, kind + '.gain'),
            Q: new Param(1, kind + '.Q'),
            detune: new Param(0, kind + '.detune'),
            threshold: new Param(0, kind + '.threshold'),
            knee: new Param(0, kind + '.knee'),
            ratio: new Param(0, kind + '.ratio'),
            attack: new Param(0, kind + '.attack'),
            release: new Param(0, kind + '.release'),
            type: 'sine'
        }, extra);
        (log[kind] || (log[kind] = [])).push(n);
        return n;
    };
    class Ctx {
        constructor() { this.currentTime = 0; this.destination = node('dest'); this.sampleRate = 44100; this.state = 'suspended'; log.ctx = this; }
        resume() { this.state = 'running'; log.resumed = (log.resumed || 0) + 1; return Promise.resolve(); }
        createOscillator() { return node('osc'); }
        createGain() { return node('gain'); }
        createBiquadFilter() { return node('filter'); }
        createBufferSource() { return node('bufsrc'); }
        createStereoPanner() { return node('panner', { pan: new Param(0, 'panner.pan') }); }
        createDynamicsCompressor() { return node('comp'); }
        createBuffer(c, l, r) { return { length: l, sampleRate: r, numberOfChannels: c, getChannelData: () => new Float32Array(l) }; }
    }
    return { Ctx, log };
}
