/* =============================================================================
   NEON DRIVE — editable game settings
   -----------------------------------------------------------------------------
   This file contains connection settings and the main tuning numbers only.
   The game rules that use them live in main.js. Keeping the values here makes
   speeds, race length, traffic and physics easy to find without searching
   through the whole game. Changing a value changes the game; the starting
   values below are the game's original values.
   ============================================================================= */

export const FIREBASE_CONFIG = {
    apiKey: "AIzaSyCKqsxIC2aGBR0UnejiXlIaJeKAfdW_Zp0",
    authDomain: "online-ha.firebaseapp.com",
    databaseURL: "https://online-ha-default-rtdb.asia-southeast1.firebasedatabase.app",
    projectId: "online-ha",
    storageBucket: "online-ha.firebasestorage.app",
    messagingSenderId: "1033988386517",
    appId: "1:1033988386517:web:ff4c6befb8fcee7e84bc5c",
    measurementId: "G-QLLSTFR1XX"
};

/* Frames the car stays stunned after a crash. */
export const CRASH_STUN = 36;                    // ~0.6s at 60fps

/* Traffic is much heavier now, so cars come from the very top of the road
   (deep in the fog) instead of blinking into existence halfway up it. */
export const MAX_ENEMIES = 18;          // a longer road needs more cars to keep it busy
/* Cars and pickups launch at the far end of the road, deep in the fog, so
   they fade in at the top of the screen instead of blinking in halfway up. */
export const SPAWN_Y = -5910;          // world z -6600: 120% fogged, past where you can see

/* Traffic cruises forward at the same speed the brake drops you to. */
export const NPC_SPEED = 60;
/* Top speeds: slower than before now that the road is busier. */
export const SPEED_CRUISE = 160, SPEED_NITRO = 420, SPEED_BRAKE = 60;

/* --- race length: 2.5 minutes --- */
export const RACE_SECONDS = 150;
/* races start with most of a tank: you can clear the first bit of traffic
   without waiting to farm a pickup */
export const START_NITRO = 80;
/* --- skills: both cost 5 ammo --- */
export const SKILL_COST = 5;
export const GHOST_FRAMES = 180;                 // 3 seconds at 60fps
/* Vehicle physics tuning used by longitudinalAccel() in main.js. */
export const PHYS = {
    traction: 180, tractionNitro: 330,     // KMH/s the tyres can put down
    power: 26000, powerNitro: 95000,       // engine force = power / (v + 55)
    dragK: 0.00105,                        // aero drag, quadratic
    rollR: 6,                              // rolling resistance, KMH/s
    engineBrake: 70,                       // lift-off decel cap, KMH/s
    brakeMax: 310,                         // full-pedal decel, KMH/s
    gradeK: 300                            // gravity per unit of road grade
};
