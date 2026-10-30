/* =============================================================================
   NEON DRIVE — ribbon geometry helper
   -----------------------------------------------------------------------------
   Builds the long triangle strips used by the tarmac, aprons, neon edges,
   barriers and barrier glow in scene3d.js.
   ============================================================================= */

import * as THREE from 'three';

/* A ribbon: a strip of quads running the length of the road, rebuilt every
   frame so it can follow the bend. Used for the tarmac, the neon barriers
   and their glow, all of which used to be one straight slab each. */
export function makeRibbon(segments, material, normal) {
    const count = segments + 1;
    const geo = new THREE.BufferGeometry();
    const uv = new Float32Array(count * 2 * 2);
    for (let i = 0; i < count; i++) {                 // v runs 0..1 along the road
        const v = i / segments;
        uv[i * 4 + 0] = 0; uv[i * 4 + 1] = v;
        uv[i * 4 + 2] = 1; uv[i * 4 + 3] = v;
    }
    const idx = new Uint16Array(segments * 6);
    for (let i = 0; i < segments; i++) {
        const a = i * 2, b = a + 1, c = a + 2, d = a + 3;
        idx.set([a, b, d, a, d, c], i * 6);
    }
    geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(count * 2 * 3), 3));
    geo.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
    if (normal) {
        const nrm = new Float32Array(count * 2 * 3);
        for (let i = 0; i < count * 2; i++) nrm.set(normal, i * 3);
        geo.setAttribute('normal', new THREE.BufferAttribute(nrm, 3));
    }
    geo.setIndex(new THREE.BufferAttribute(idx, 1));
    const mesh = new THREE.Mesh(geo, material);
    mesh.frustumCulled = false;               // it always spans the whole road
    return mesh;
}
