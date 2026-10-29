/* A small in-memory stand-in for the Firebase Realtime Database, enough to
   exercise rooms, the matchmaking queue, transactions and change listeners. */

const clone = (v) => (v === null || v === undefined) ? null : JSON.parse(JSON.stringify(v));

class Snap {
    constructor(key, val) { this.key = key; this._v = val; }
    val() { return clone(this._v); }
    exists() { return this._v !== null && this._v !== undefined; }
    numChildren() { return this._v && typeof this._v === 'object' ? Object.keys(this._v).length : 0; }
    forEach(cb) {
        if (!this._v || typeof this._v !== 'object') return;
        for (const k of this._keys) { if (cb(new Snap(k, this._v[k])) === true) return true; }
        return false;
    }
    get _keys() { return this._order || Object.keys(this._v); }
    _sorted(key, n) {
        const keys = Object.keys(this._v).sort((a, b) => (this._v[a]?.[key] ?? 0) - (this._v[b]?.[key] ?? 0));
        const s = new Snap(this.key, this._v);
        s._order = n ? keys.slice(0, n) : keys;
        return s;
    }
}

export class FakeDB {
    constructor() {
        this.data = {};
        this.listeners = [];          // { path, cb }
        this.writes = [];             // audit trail
        this.removed = [];
        this.onDisconnect = [];       // { path, op }
    }
    ref(path) { return new Ref(this, String(path).split('/').filter(Boolean)); }
    _get(parts) {
        let o = this.data;
        for (const p of parts) {
            if (o === null || typeof o !== 'object') return null;
            o = o[p];
            if (o === undefined) return null;
        }
        return o === undefined ? null : o;
    }
    _set(parts, val) {
        if (!parts.length) { this.data = val; return; }
        let o = this.data;
        for (let i = 0; i < parts.length - 1; i++) {
            if (o[parts[i]] === undefined || typeof o[parts[i]] !== 'object') o[parts[i]] = {};
            o = o[parts[i]];
        }
        if (val === null) delete o[parts[parts.length - 1]];
        else o[parts[parts.length - 1]] = val;
    }
    _merge(parts, val) {
        for (const k in val) {
            if (val[k] && typeof val[k] === 'object' && !Array.isArray(val[k])) this._merge(parts.concat(k), val[k]);
            else this._set(parts.concat(k), val[k]);
        }
    }
    _notify(path) {
        const p = path.split('/').filter(Boolean);
        for (const l of this.listeners.slice()) {
            const lp = l.path.split('/').filter(Boolean);
            /* notify the path itself and every ancestor, like the real thing */
            if (lp.length > p.length) continue;
            if (lp.every((seg, i) => seg === p[i])) {
                l.cb(new Snap(lp[lp.length - 1] || null, this._get(lp)));
            }
        }
    }
    /* simulate the client going away */
    disconnect() {
        for (const d of this.onDisconnect.slice()) {
            if (d.op === 'remove') { this._set(d.path.split('/').filter(Boolean), null); this._notify(d.path); }
        }
    }
}

class Ref {
    constructor(db, parts) { this.db = db; this.parts = parts; }
    get path() { return this.parts.join('/'); }
    child(p) { return new Ref(this.db, this.parts.concat(String(p).split('/').filter(Boolean))); }
    get key() { return this.parts[this.parts.length - 1] || null; }

    set(v) { this.db.writes.push(['set', this.path, clone(v)]); this.db._set(this.parts, clone(v)); this.db._notify(this.path); return Promise.resolve(); }
    update(v) { this.db.writes.push(['update', this.path, clone(v)]); this.db._merge(this.parts, clone(v)); this.db._notify(this.path); return Promise.resolve(); }
    remove() {
        this.db.writes.push(['remove', this.path]);
        this.db.removed.push(this.path);
        this.db._set(this.parts, null);
        this.db._notify(this.path);
        return Promise.resolve();
    }
    once(event, cb) {
        const snap = new Snap(this.key, this.db._get(this.parts));
        if (event === 'value') {
            if (typeof cb === 'function') { cb(snap); return Promise.resolve(snap); }
            return Promise.resolve(snap);
        }
        return Promise.resolve(snap);
    }
    on(event, cb) {
        if (event !== 'value') return cb;
        const l = { path: this.path, cb };
        this.db.listeners.push(l);
        const snap = new Snap(this.key, this.db._get(this.parts));
        cb(snap);                                  // fires immediately, as Firebase does
        return cb;
    }
    off(event, cb) {
        this.db.listeners = this.db.listeners.filter(l => !(l.path === this.path && (!cb || l.cb === cb)));
    }
    transaction(fn) {
        const cur = this.db._get(this.parts);
        const next = fn(clone(cur));
        if (next === undefined) return Promise.resolve({ committed: false, snapshot: new Snap(this.key, cur) });
        this.db._set(this.parts, clone(next));
        this.db._notify(this.path);
        return Promise.resolve({ committed: true, snapshot: new Snap(this.key, next) });
    }
    orderByChild(k) { return new Query(this.db, this.parts, k); }
    limitToFirst() { return this; }
    push(v) {
        const key = 'push-' + Math.random().toString(36).slice(2, 10);
        const r = this.child(key);
        if (v !== undefined) r.set(v);
        return r;
    }
    onDisconnect() {
        const self = this;
        return {
            remove() { self.db.onDisconnect.push({ path: self.path, op: 'remove' }); return Promise.resolve(); },
            set(v) { self.db.onDisconnect.push({ path: self.path, op: 'set', v }); return Promise.resolve(); }
        };
    }
}

class Query extends Ref {
    constructor(db, parts, orderKey) { super(db, parts); this.orderKey = orderKey; }
    limitToFirst(n) { this._limit = n; return this; }
    once(event, cb) {
        const val = this.db._get(this.parts);
        const snap = new Snap(this.key, val);
        const ordered = (val && typeof val === 'object')
            ? snap._sorted(this.orderKey, this._limit)
            : new Snap(this.key, null);
        if (typeof cb === 'function') { cb(ordered); return Promise.resolve(ordered); }
        return Promise.resolve(ordered);
    }
    on(event, cb) { return this.once(event, cb).then(() => cb); }
}

export function makeFirebase(db) {
    return {
        initializeApp: () => ({}),
        database: () => db,
        databaseGT: () => db
    };
}
