/* =============================================================================
   NEON DRIVE — chase-camera settings
   -----------------------------------------------------------------------------
   Portrait and landscape camera rigs plus the aspect-ratio blend between
   them. scene3d.js applies these values to the actual three.js camera.
   ============================================================================= */

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
    follow: 1,          // how much the camera slides sideways with the car.
                        // 1 = it sits on the car, so the car never drifts off
                        // the centre of the screen and it is the road that
                        // moves under you
    camY: 220,          // camera height above the road
    camZ: 330,          // camera distance behind the car
    lookY: -90,         // aim point: below road level, well up the track
    lookZ: -340         // shallow aim: drops the car to ~62% of screen height
};

/* The same rig, solved for a phone on its side. Portrait keeps the road
   wider than the screen, so a landscape view has to zoom IN or the road
   shrinks to a 45%-wide strip with a 40px car on it. Aiming further down
   the track flattens the pitch, which puts the horizon back in frame and
   drops the car to ~75-92% of the height — low, where a rotated phone has
   the most room, with the whole road ahead visible. */
export const CAM_WIDE = { fov: 38, camY: 185, camZ: 310, lookY: -90, lookZ: -700 };
export const CAM_KEYS = ['fov', 'camY', 'camZ', 'lookY', 'lookZ'];
export const CAM_TALL = { fov: 60, camY: 220, camZ: 330, lookY: -90, lookZ: -340 };
/* 0 at aspect 0.72 (every portrait phone), 1 at 1.75 and wider */
export function camBlend(aspect) {
    return Math.max(0, Math.min(1, (aspect - 0.72) / (1.75 - 0.72)));
}
