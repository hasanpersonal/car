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
        this._playerCars = [buildCar('sports', '#ff0055'), buildCar('sports', '#00f0ff')];
        this._livery = 0;
        this._playerCars[1].visible = false;
        this.scene.add(this._playerCars[0], this._playerCars[1]);

        this.enemyPool = [];      // { car, key }
        this.bulletPool = [];
        this.starPool = [];
        this.ghostPool = [];

        this.bulletGeo = new THREE.BoxGeometry(5, 5, 24);
        this.bulletMat = new THREE.MeshStandardMaterial({
            color: '#ffea00', emissive: '#ffea00', emissiveIntensity: 2.6, roughness: 0.2
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
        car.rotation.z = -(opts.steer || 0) * 0.045;          // body roll into the turn
        car.rotation.y = -(opts.steer || 0) * 0.10;           // and a little yaw
        h.setBrake(opts.brake || 0);
        h.setBoost(opts.boost || 0);
        h.spinWheels(opts.phase * 0.05, -(opts.steer || 0));
        if (opts.boost > 0.02) {
            const f = 0.75 + Math.random() * 0.5;
            h.flames.forEach(fl => fl.scale.set(0.8, f, 0.8));
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
            car.rotation.y = -(e.steer || 0) * 0.16;
            car.rotation.z = -(e.steer || 0) * 0.03;
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
                this.bulletPool[i] = m;
                this.scene.add(m);
            }
            m.visible = true;
            m.position.set(list[i].wx, 9, list[i].wz);
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
    _labelSprite(name, color) {
        if (!this._labels) this._labels = {};
        if (this._labels[name]) return this._labels[name];
        const c = document.createElement('canvas');
        c.width = 256; c.height = 64;
        const g = c.getContext('2d');
        g.fillStyle = 'rgba(0,0,0,0.66)';
        g.strokeStyle = color; g.lineWidth = 3;
        g.beginPath(); g.roundRect(4, 8, 248, 48, 12); g.fill(); g.stroke();
        g.font = 'bold 30px Segoe UI, Roboto, sans-serif';
        g.fillStyle = '#ffffff'; g.textAlign = 'center'; g.textBaseline = 'middle';
        g.fillText(name.slice(0, 12), 128, 33);
        const tex = new THREE.CanvasTexture(c);
        tex.colorSpace = THREE.SRGBColorSpace;
        const sp = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, transparent: true, depthTest: false }));
        sp.scale.set(70, 17.5, 1);
        this._labels[name] = sp;
        return sp;
    }

    syncGhosts(list, phase) {
        for (let i = 0; i < list.length; i++) {
            const g = list[i];
            const key = g.style + '|' + g.color;
            let slot = this.ghostPool[i];
            if (!slot || slot.key !== key) {
                if (slot) { releaseCar(slot.car); this.scene.remove(slot.car); }
                const car = acquireCar(g.style, g.color);
                this.scene.add(car);
                slot = this.ghostPool[i] = { car, key };
            }
            const car = slot.car;
            car.visible = true;
            car.position.set(g.wx, 0, g.wz);
            car.rotation.y = -(g.steer || 0) * 0.12;
            const h = car.userData.handle;
            h.setBrake(0); h.setBoost(0);
            h.spinWheels(phase * 0.05, g.steer || 0);
            car.traverse(o => { if (o.material && o.material.transparent !== undefined) o.material.opacity = o.material.opacity; });
            if (!slot.label) {
                slot.label = this._labelSprite(g.name, g.color);
                this.scene.add(slot.label);
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
        this.renderer.render(this.scene, this.camera);
    }
}

/* world coordinates helpers used by script.js (old screen px -> 3D) */
export const SCREEN_CENTRE_X = 240;
export const PLAYER_SCREEN_Y = 690;
export const wx = (screenX) => screenX - SCREEN_CENTRE_X;
export const wz = (screenY) => screenY - PLAYER_SCREEN_Y;
