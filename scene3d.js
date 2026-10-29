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
const FAR_Z = -4200;                // ... and this far ahead
const SPAN = NEAR_Z - FAR_Z;

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
    follow: 0.65,       // how much the camera slides sideways with the car
    camY: 220,          // camera height above the road
    camZ: 330,          // camera distance behind the car
    lookY: -90,         // aim point: below road level, well up the track
    lookZ: -340         // shallow aim: drops the car to ~62% of screen height
};

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
        this.scene.fog = new THREE.Fog('#04050c', 700, 2900);

        this.camera = new THREE.PerspectiveCamera(CAM.fov, 1, 5, 6000);
        this.camShake = new THREE.Vector3();

        this._buildLights();
        this._buildRoad();
        this._buildPools();

        this.dummy = new THREE.Object3D();
        this.color = new THREE.Color();
        this.resize();
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
        this.asphalt = new THREE.CanvasTexture(c);
        this.asphalt.wrapS = this.asphalt.wrapT = THREE.RepeatWrapping;
        this.asphalt.colorSpace = THREE.SRGBColorSpace;
        this.asphalt.anisotropy = 4;
        this.asphalt.repeat.set(2, 20);

        const road = new THREE.Mesh(
            new THREE.PlaneGeometry(ROAD_W, SPAN),
            new THREE.MeshStandardMaterial({ map: this.asphalt, roughness: 0.95, metalness: 0.05 }));
        road.rotation.x = -Math.PI / 2;
        road.position.z = (NEAR_Z + FAR_Z) / 2;
        this.scene.add(road);

        /* dark ground either side so the void reads as night, not a hole */
        const ground = new THREE.Mesh(
            new THREE.PlaneGeometry(6000, SPAN),
            new THREE.MeshStandardMaterial({ color: '#05060e', roughness: 1 }));
        ground.rotation.x = -Math.PI / 2;
        ground.position.set(0, -1.2, (NEAR_Z + FAR_Z) / 2);
        this.scene.add(ground);

        /* ---- instanced, recycled road furniture ---- */
        const dashGeo = new THREE.BoxGeometry(3.5, 0.8, 42);
        this.dashes = new THREE.InstancedMesh(dashGeo,
            new THREE.MeshStandardMaterial({ color: '#ffffff', emissive: '#8899bb', emissiveIntensity: 0.25, roughness: 0.7 }), 42);
        this.dashes.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
        this.scene.add(this.dashes);

        const kerbGeo = new THREE.BoxGeometry(13, 2.4, 28);
        this.kerbs = new THREE.InstancedMesh(kerbGeo,
            new THREE.MeshStandardMaterial({ color: '#ffffff', roughness: 0.6 }), 68);
        this.kerbs.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
        this.kerbs.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(68 * 3), 3);
        this.scene.add(this.kerbs);

        const postGeo = new THREE.BoxGeometry(7, 30, 7);
        this.posts = new THREE.InstancedMesh(postGeo,
            new THREE.MeshStandardMaterial({ color: '#101423', emissive: '#ffffff', emissiveIntensity: 0.35, roughness: 0.5 }), 40);
        this.posts.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
        this.posts.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(40 * 3), 3);
        this.scene.add(this.posts);

        /* ---- neon barriers (static, they run the whole length) ---- */
        for (const side of [-1, 1]) {
            const col = side < 0 ? '#00f0ff' : '#ff0055';
            const bar = new THREE.Mesh(
                new THREE.BoxGeometry(5, 7, SPAN),
                new THREE.MeshStandardMaterial({ color: col, emissive: col, emissiveIntensity: 2.4, roughness: 0.3 }));
            bar.position.set(side * (ROAD_HALF + 2), 3.5, (NEAR_Z + FAR_Z) / 2);
            this.scene.add(bar);

            const halo = new THREE.Mesh(
                new THREE.PlaneGeometry(70, SPAN),
                new THREE.MeshBasicMaterial({
                    map: glowTexture(), color: col, transparent: true, opacity: 0.30,
                    blending: THREE.AdditiveBlending, depthWrite: false
                }));
            halo.rotation.set(-Math.PI / 2, 0, 0);
            halo.position.set(side * (ROAD_HALF + 20), 2, (NEAR_Z + FAR_Z) / 2);
            this.scene.add(halo);
        }
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
        const target = this._boost > 0.02 ? 1 : 0;
        this.airLevel += (target - this.airLevel) * 0.16;
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
            a.z += a.spd * (0.45 + L * 1.55);
            if (a.z - pz > 430) { this._respawnAir(a, false); }
            const len = a.len * (0.5 + L * 0.9);
            const o = i * 6;
            arr[o] = a.x;     arr[o + 1] = a.y; arr[o + 2] = a.z;
            arr[o + 3] = a.x; arr[o + 4] = a.y; arr[o + 5] = a.z + len;
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
            const pos = this.dropGeo.attributes.position.array;
            pos[i0 * 3] = x + (Math.random() - 0.5) * 16;
            pos[i0 * 3 + 1] = 5 + Math.random() * 14;
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
            m.position.set(x + (Math.random() - 0.5) * 90, 0.9, z + (Math.random() - 0.5) * 70);
        }
        /* shock ring */
        const r = this.ringPool.find(s => !s.visible) || this._oldest(this.ringPool);
        r.visible = true;
        r.userData.t = 0;
        r.material.color.set(color);
        r.position.set(x, 1.6, z);
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
        car.position.set(x, 0, z);
        car.rotation.set(0, 0, 0);
        this.spawnSplatter(x, z, color, power);
    }

    /* the player's own impact animation */
    playerHit() { this.hitT = 34; }

    _updateEffects() {
        /* ---- droplets ---- */
        const pos = this.dropGeo.attributes.position.array;
        const col = this.dropGeo.attributes.color.array;
        for (let i = 0; i < this.maxDrops; i++) {
            const life = this.dropLife[i];
            if (life <= 0) { col[i * 4 + 3] = 0; continue; }
            this.dropLife[i] = life - 1;
            this.dropV.y[i] -= 0.62;                       // gravity
            this.dropV.x[i] *= 0.982;
            this.dropV.z[i] *= 0.982;
            pos[i * 3] += this.dropV.x[i];
            pos[i * 3 + 1] += this.dropV.y[i];
            pos[i * 3 + 2] += this.dropV.z[i];
            if (pos[i * 3 + 1] < 0.7) {                    // lands: flattens and crawls
                pos[i * 3 + 1] = 0.7;
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
            m.userData.t++;
            const k = m.userData.t / m.userData.life;
            if (k >= 1) { m.visible = false; m.material.opacity = 0; continue; }
            const s = m.userData.size * (0.35 + k * 1.25);
            m.scale.set(s, s, 1);
            m.material.opacity = 0.6 * (1 - k) * (1 - k);
        }

        /* ---- shock rings ---- */
        for (const r of this.ringPool) {
            if (!r.visible) continue;
            r.userData.t++;
            const k = r.userData.t / 26;
            if (k >= 1) { r.visible = false; r.material.opacity = 0; continue; }
            r.scale.setScalar(14 + k * 190);
            r.material.opacity = 0.75 * (1 - k);
        }

        /* ---- wrecked cars ---- */
        for (const w of this.wreckPool) {
            if (!w.active) continue;
            w.t++;
            const car = w.car;
            car.rotation.x += w.spinX;
            car.rotation.z += w.spinZ;
            car.rotation.y += w.spinY;
            w.vy -= 0.85;
            car.position.x += w.vx;
            car.position.z += w.vz;
            car.position.y += w.vy;
            if (car.position.y < 0) {                      // hits the road, loses energy
                car.position.y = 0;
                w.vy = -w.vy * 0.3;
                w.spinX *= 0.7; w.spinZ *= 0.7; w.spinY *= 0.7;
                w.vx *= 0.7; w.vz *= 0.7;
            }
            if (w.t < 20 && w.t % 4 === 0) {               // liquid streaming off the wreck
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
        this.camera.aspect = this.aspect;
        this.camera.updateProjectionMatrix();
    }

    /* ---------------------------------------------------------------- *
     *  per-frame sync
     * ---------------------------------------------------------------- */
    scrollRoad(roadOffset) {
        this.asphalt.offset.y = roadOffset / 230;
        const d = this.dummy;
        const wrap = (i, spacing, count) => {
            const total = spacing * count;
            return (((i * spacing + roadOffset) % total) + total) % total - total + NEAR_Z;
        };

        /* centre + quarter lane dashes */
        let n = 0;
        for (const x of [-120, 0, 120])
            for (let i = 0; i < 14; i++) {
                d.position.set(x, 0.4, wrap(i, 165, 14));
                d.rotation.set(0, 0, 0); d.scale.set(1, 1, 1);
                d.updateMatrix();
                this.dashes.setMatrixAt(n++, d.matrix);
            }
        this.dashes.instanceMatrix.needsUpdate = true;

        /* rumble kerbs, alternating colour */
        n = 0;
        for (const side of [-1, 1]) {
            for (let i = 0; i < 34; i++) {
                d.position.set(side * (ROAD_HALF - 6), 1.2, wrap(i, 60, 34));
                d.rotation.set(0, 0, 0); d.scale.set(1, 1, 1);
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
            for (let i = 0; i < 20; i++) {
                d.position.set(side * (ROAD_HALF + 26), 15, wrap(i, 240, 20));
                d.rotation.set(0, 0, 0); d.scale.set(1, 1, 1);
                d.updateMatrix();
                this.posts.setMatrixAt(n, d.matrix);
                this.color.set(side < 0 ? '#00f0ff' : '#ff0055');
                this.posts.setColorAt(n, this.color);
                n++;
            }
        }
        this.posts.instanceMatrix.needsUpdate = true;
        if (this.posts.instanceColor) this.posts.instanceColor.needsUpdate = true;
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
        car.position.set(x, 0, z);
        const h = car.userData.handle;
        /* Full base pose every frame. rotation.x used to be touched only by the
           crash animation below, so every crash added its tumble to the last one
           and the car drove around permanently nose-up. */
        car.rotation.set(0, -(opts.steer || 0) * 0.10, -(opts.steer || 0) * 0.045);
        h.setBrake(opts.brake || 0);
        h.setBoost(opts.boost || 0);
        this._boost = opts.boost || 0;
        this._playerZ = z;
        h.spinWheels(opts.phase * 0.05, -(opts.steer || 0));
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
            car.position.y = Math.abs(Math.sin(n * 0.5)) * 6 * w;
            this.hitT--;
        }
        /* ---- chase camera: fixed rig that follows the car sideways ----
           Deliberately NOT tied to nitro. The livery swaps to cyan under
           boost and the camera used to widen and pull back at the same
           moment, which read as the camera "changing with the colour". */
        /* Follow by CAM.follow, but never let the car slide off the edge of a
           very narrow screen: clamp how far the car may sit from the camera
           axis to what the current aspect can actually show. */
        const halfExtent = Math.tan(this.camera.fov * Math.PI / 360) * this.aspect * CAM.camZ;
        const limit = Math.max(0, halfExtent * 0.92 - CAR.W * 0.5 - 4);
        const off = Math.max(-limit, Math.min(limit, x * (1 - CAM.follow)));
        const cx = x - off;
        this.camera.position.set(cx + this.camShake.x, CAM.camY + this.camShake.y, z + CAM.camZ);
        this.camera.lookAt(cx, CAM.lookY, z + CAM.lookZ);
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
            car.visible = true;
            car.position.set(e.wx, 0, e.wz);
            const h = car.userData.handle;
            const braking = (speed > 120 && e.wz < playerZ && playerZ - e.wz < 300) ? 1 : 0;
            h.setBrake(braking);
            h.setBoost(0);
            h.spinWheels(e.phase * 0.05, e.steer || 0);
            car.rotation.set(0, -(e.steer || 0) * 0.16, -(e.steer || 0) * 0.03);
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
            m.position.set(list[i].wx, 12, list[i].wz);
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
            m.position.set(s.wx, 26, s.wz);
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
            pos[i * 3] = p.wx; pos[i * 3 + 1] = p.wy; pos[i * 3 + 2] = p.wz;
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
            car.position.set(g.wx, 0, g.wz);
            car.rotation.set(0, -(g.steer || 0) * 0.12, 0);
            car.scale.setScalar(1);
            const h = car.userData.handle;
            h.setBrake(0); h.setBoost(0);
            h.spinWheels(phase * 0.05, g.steer || 0);

            /* the name tag belongs to whoever is in this slot right now */
            if (!slot.label || slot.name !== g.name) {
                if (slot.label) { this.scene.remove(slot.label); slot.label.material.map.dispose(); slot.label.material.dispose(); }
                slot.label = this._labelSprite(g.name, g.color);
                slot.label.scale.set(70, 17.5, 1);
                this.scene.add(slot.label);
                slot.name = g.name;
            }
            slot.label.visible = true;
            slot.label.position.set(g.wx, 62, g.wz);
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
