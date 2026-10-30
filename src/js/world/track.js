/* =============================================================================
   NEON DRIVE — track shape
   -----------------------------------------------------------------------------
   The road centreline, hills, banking inputs and seeded curve generation.
   scene3d.js draws this shape; ../game/main.js reads its heading/grade for
   the driving physics.
   ============================================================================= */

/* ------------------------------------------------------------------ *
 *  ROAD SHAPE
 *  A straight road is dull, so the centreline is a sum of three sines
 *  over distance travelled: long sweepers, real bends, and a ripple so
 *  it never reads as a plain arc. Re-seeded every race, so no two runs
 *  are alike and it never loops.
 *  The road is its own object: it is drawn where its centreline runs,
 *  relative to where that centreline is under the car, and nothing in it
 *  is measured against the car. So a car that is going straight does not
 *  stay on the road — the road curves out from under it and the driver
 *  has to answer with the wheel. Measuring it against the car (which is
 *  what it used to do) glued the car to the centreline, and that was the
 *  car following the bends with nobody steering.
 * ------------------------------------------------------------------ */
const CURVE_BANDS = [
    { wave: 2600, amp: 420 },       // long sweepers
    { wave: 1250, amp: 110 },       // the bends you actually steer for
    { wave: 620, amp: 20 }          // ripple, so it is never a plain arc
];
const CURVE = CURVE_BANDS.map(() => ({ wave: 1, amp: 0, phase: 0 }));
/* The road also rises and falls: two sine bands over distance, seeded
   with the bends, normalised so the grade never exceeds 5%. ../game/main.js
   reads the grade under the car and turns it into gravity, so a crest
   is something you feel in the speed, not just something you see. */
const ELEV_BANDS = [
    { wave: 950, amp: 30 },         // long crests and dips
    { wave: 420, amp: 9 }           // shorter undulations
];
const ELEV = ELEV_BANDS.map(() => ({ wave: 1, amp: 0, phase: 0 }));
const MAX_GRADE = 0.05;
/* Corners are banked: the tarmac tilts into the bend, outside edge up,
   by an amount proportional to how hard the road is curving there. */
export const BANK_GAIN = 1050, BANK_MAX = 0.13;
/* How hard the road is allowed to turn away from the car. The car no longer
   follows the centreline by itself, so a bend steeper than the steering can
   answer is a bend that simply carries you into the barrier whatever you do.
   Whole road is scaled by this, not band by band, so a steep seed stays
   drivable while a gentle one keeps its full sweep. */
const MAX_ROAD_SLOPE = 0.08;
/* bumped every time the bends are re-seeded, so anything caching a position
   on the old road knows to measure itself again */
let CURVE_GEN = 0;
export function curveGeneration() { return CURVE_GEN; }
function mulberry32(a) {
    return function () {
        a = a + 0x6D2B79F5 | 0;
        let t = Math.imul(a ^ a >>> 15, 1 | a);
        t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
        return ((t ^ t >>> 14) >>> 0) / 4294967296;
    };
}
/* no seed (the normal case) means a fresh random set of bends; a seed makes
   a shape reproducible, which is what the test harness needs */
export function reseedCurves(seed) {
    const rnd = seed === undefined ? Math.random : mulberry32(seed | 0);
    CURVE_BANDS.forEach((b, i) => {
        CURVE[i].wave = b.wave * (0.80 + rnd() * 0.45);
        CURVE[i].amp = b.amp * (0.55 + rnd() * 0.90);
        CURVE[i].phase = rnd() * Math.PI * 2;
    });
    const slope = CURVE.reduce((t, c) => t + c.amp / c.wave, 0);
    if (slope > MAX_ROAD_SLOPE) for (const c of CURVE) c.amp *= MAX_ROAD_SLOPE / slope;
    ELEV_BANDS.forEach((b, i) => {
        ELEV[i].wave = b.wave * (0.80 + rnd() * 0.45);
        ELEV[i].amp = b.amp * (0.55 + rnd() * 0.90);
        ELEV[i].phase = rnd() * Math.PI * 2;
    });
    const grade = ELEV.reduce((t, c) => t + c.amp / c.wave, 0);
    if (grade > MAX_GRADE) for (const c of ELEV) c.amp *= MAX_GRADE / grade;
    CURVE_GEN++;            // a new race is a new road: drop any stale cache
}
reseedCurves();
/* lateral offset of the road centre at absolute distance S along it */
const centreAt = (S) =>
    CURVE[0].amp * Math.sin(S / CURVE[0].wave + CURVE[0].phase) +
    CURVE[1].amp * Math.sin(S / CURVE[1].wave + CURVE[1].phase) +
    CURVE[2].amp * Math.sin(S / CURVE[2].wave + CURVE[2].phase);
/* and its slope, which is what sets the heading of everything sitting on it */
const slopeAt = (S) =>
    CURVE[0].amp / CURVE[0].wave * Math.cos(S / CURVE[0].wave + CURVE[0].phase) +
    CURVE[1].amp / CURVE[1].wave * Math.cos(S / CURVE[1].wave + CURVE[1].phase) +
    CURVE[2].amp / CURVE[2].wave * Math.cos(S / CURVE[2].wave + CURVE[2].phase);
/* how hard the heading itself is changing — the curvature that banks the road */
const bendRateAt = (S) =>
    -(CURVE[0].amp / (CURVE[0].wave * CURVE[0].wave) * Math.sin(S / CURVE[0].wave + CURVE[0].phase) +
      CURVE[1].amp / (CURVE[1].wave * CURVE[1].wave) * Math.sin(S / CURVE[1].wave + CURVE[1].phase) +
      CURVE[2].amp / (CURVE[2].wave * CURVE[2].wave) * Math.sin(S / CURVE[2].wave + CURVE[2].phase));
/* road height and grade (rise per unit travelled) at absolute distance S */
const elevAt = (S) =>
    ELEV[0].amp * Math.sin(S / ELEV[0].wave + ELEV[0].phase) +
    ELEV[1].amp * Math.sin(S / ELEV[1].wave + ELEV[1].phase);
const gradeAt = (S) =>
    ELEV[0].amp / ELEV[0].wave * Math.cos(S / ELEV[0].wave + ELEV[0].phase) +
    ELEV[1].amp / ELEV[1].wave * Math.cos(S / ELEV[1].wave + ELEV[1].phase);
/* The track's own direction in mathematical (not three.js Euler) terms:
   positive heading veers toward +x/right as distance increases. ../game/main.js
   integrates the player's independent heading against this. Curvature is
   d(heading)/d(arc length) for the centreline graph x = centreAt(S). */
const trackHeadingAtS = (S) => Math.atan(slopeAt(S));
const trackCurvatureAtS = (S) => {
    const m = slopeAt(S);
    return bendRateAt(S) / Math.pow(1 + m * m, 1.5);
};
/* stable per-index pseudo-random, so roadside furniture keeps its size
   and offset every frame while its position wraps down the road */
const hash1 = (n) => { const s = Math.sin(n * 127.1 + 311.7) * 43758.5453; return s - Math.floor(s); };


export { centreAt, slopeAt, bendRateAt, elevAt, gradeAt, trackHeadingAtS, trackCurvatureAtS, hash1 };
