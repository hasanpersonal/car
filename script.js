import * as THREE from 'three';
import { World, wx, wz, reseedCurves } from './scene3d.js';

// --- FIREBASE CONFIGURATION ---
const firebaseConfig = {
    apiKey: "AIzaSyCKqsxIC2aGBR0UnejiXlIaJeKAfdW_Zp0",
    authDomain: "online-ha.firebaseapp.com",
    databaseURL: "https://online-ha-default-rtdb.asia-southeast1.firebasedatabase.app",
    projectId: "online-ha",
    storageBucket: "online-ha.firebasestorage.app",
    messagingSenderId: "1033988386517",
    appId: "1:1033988386517:web:ff4c6befb8fcee7e84bc5c",
    measurementId: "G-QLLSTFR1XX"
};
firebase.initializeApp(firebaseConfig);
const database = firebase.database();

// --- GAME & MULTIPLAYER STATE ---
let myId = Math.random().toString(36).substr(2, 9);
let myName = "";
let currentRoom = null;
let isHost = false;
let opponentsData = {};
let lastSyncTime = 0;
let isMultiplayer = false;

let gameActive = false;
let score = 0, speed = 0, targetSpeed = 0;
let nitro = 0, bullets = 0; 
let isNitro = false;
let screenShake = 0, roadOffset = 0, screenFlash = 0;
/* frames the car sits dead still after a crash before it picks up again */
let crashStun = 0;
const CRASH_STUN = 36;                    // ~0.6s at 60fps

/* Traffic is much heavier now, so cars come from the very top of the road
   (deep in the fog) instead of blinking into existence halfway up it. */
const MAX_ENEMIES = 18;          // a longer road needs more cars to keep it busy
/* Cars and pickups launch at the far end of the road, deep in the fog, so
   they fade in at the top of the screen instead of blinking in halfway up. */
const SPAWN_Y = -5910;          // world z -6600: 120% fogged, past where you can see

/* Don't drop a new car on top of one that is still near the spawn line. */
function canSpawn(list) {
    for (let attempt = 0; attempt < 3; attempt++) {
        const lane = [40, 140, 240, 340, 410][Math.floor(Math.random() * 5)];
        let clear = true;
        for (const e of list) {
            if (e.y < SPAWN_Y + 420 && Math.abs((e.x + e.w / 2) - (lane + 22)) < 44) { clear = false; break; }
        }
        if (clear) { pendingLane = lane; return true; }
    }
    return false;
}
let pendingLane = null;

/* Traffic cruises forward at the same speed the brake drops you to. */
const NPC_SPEED = 60;
/* Top speeds: slower than before now that the road is busier. */
const SPEED_CRUISE = 160, SPEED_NITRO = 420, SPEED_BRAKE = 60;

/* ------------------------------------------------------------------ *
 *  VEHICLE PHYSICS
 *  The speed used to be one exponential lerp toward a target, so the
 *  car launched like a catapult, braked like a wall and felt the same
 *  uphill as down. It is a force balance now, in KMH per second:
 *    engine  constant-power (force = P/v) under a traction cap, so the
 *            launch is tyre-limited, then the shove fades with speed;
 *    drag    quadratic in speed plus a little rolling resistance;
 *    brakes  strong but finite, easing off as the hold speed nears;
 *    lift    engine braking on top of drag when you come off nitro;
 *    grade   gravity along the road slope — hills genuinely pull;
 *    scrub   cornering hard costs a little speed, like real tyres.
 *  The driver still aims at the same three speeds as ever (cruise 160,
 *  brake-hold 60, nitro 420) by working the throttle, which is why the
 *  car holds its speed up a hill until the power runs out. The aim
 *  point sits a few KMH past the target to cover the throttle droop.
 * ------------------------------------------------------------------ */
const PHYS = {
    traction: 180, tractionNitro: 330,     // KMH/s the tyres can put down
    power: 26000, powerNitro: 95000,       // engine force = power / (v + 55)
    dragK: 0.00105,                        // aero drag, quadratic
    rollR: 6,                              // rolling resistance, KMH/s
    engineBrake: 70,                       // lift-off decel cap, KMH/s
    brakeMax: 310,                         // full-pedal decel, KMH/s
    gradeK: 300                            // gravity per unit of road grade
};
let lonAccel = 0;                          // last frame's KMH/s, feeds body pitch
let engineLoad = 0;                        // 0..1 throttle, feeds the engine note
function longitudinalAccel(v, target, nitroOn, braking, grade, scrub) {
    const aim = target + (braking ? 2 : 6);
    const power = nitroOn ? PHYS.powerNitro : PHYS.power;
    const traction = nitroOn ? PHYS.tractionNitro : PHYS.traction;
    engineLoad = v < aim ? Math.min(1, (aim - v) / 18) : 0;
    let a = engineLoad * Math.min(traction, power / (v + 55));
    a -= PHYS.dragK * v * v + (v > 0.5 ? PHYS.rollR : 0);
    a -= grade * PHYS.gradeK;
    a -= scrub || 0;
    if (braking && v > target) a -= PHYS.brakeMax * Math.min(1, (v - target) / 45);
    else if (v > target) a -= Math.min(PHYS.engineBrake, (v - target) * 0.55);
    return a;
}

/* Frame-rate independence: every per-frame constant in the game was
   tuned at 60fps, so physics runs on a step scaled to that (1 at
   60Hz, 0.5 at 120Hz, 2 at 30Hz). A missing or frozen timestamp —
   first frame, backgrounded tab — safely reads as one 60fps step. */
let physStep = 1, lastFrameTs = 0;
function frameStep(ts) {
    if (!ts || !lastFrameTs || ts <= lastFrameTs) { lastFrameTs = ts || lastFrameTs; return 1; }
    const dt = (ts - lastFrameTs) / 1000;
    lastFrameTs = ts;
    return Math.max(0.25, Math.min(3, dt * 60));
}
/* a probability tuned per 60fps frame, rescaled to this frame's length */
const chance = (p) => Math.random() < 1 - Math.pow(1 - p, physStep);

/* --- race length: 2.5 minutes --- */
const RACE_SECONDS = 150;
/* races start with most of a tank: you can clear the first bit of traffic
   without waiting to farm a pickup */
const START_NITRO = 80;
const fmtTime = (s) => `${Math.floor(s / 60)}:${String(Math.max(0, s) % 60).padStart(2, '0')}`;

/* --- skills: both cost 5 ammo --- */
const SKILL_COST = 5;
const GHOST_FRAMES = 180;                 // 3 seconds at 60fps
let ghostActive = false, ghostTimer = 0;

let player;
let enemies = [], stars = [], activeBullets = [], particles = [];

let raceTimeLeft = RACE_SECONDS; 
let timerInterval = null;
let lastEnemyCount = -1;

/* The playfield is still described in the original 480 x 850 screen units so
   every rule (lanes, hit-boxes, speeds, spawning) is untouched. Those units
   are mapped into the 3D world by wx() / wz(). */
const canvas = document.getElementById('canvas');
const gameWidth = 480;
const gameHeight = 850;

let world = null;
try {
    world = new World(canvas);
} catch (err) {
    console.error('WebGL unavailable:', err);
    const warn = document.createElement('div');
    warn.style.cssText = 'position:absolute;inset:0;display:flex;align-items:center;' +
        'justify-content:center;padding:30px;text-align:center;color:#ff0055;' +
        'font-weight:bold;z-index:30;background:#04050c';
    warn.innerText = 'This device could not start WebGL, so the 3D track cannot run.';
    document.getElementById('game-container').appendChild(warn);
}
window.addEventListener('resize', () => world && world.resize());
/* phones drop the GL context when the page is backgrounded — ask for it back */
canvas.addEventListener('webglcontextlost', (e) => { e.preventDefault(); }, false);
canvas.addEventListener('webglcontextrestored', () => { if (world) world.resize(); }, false);
window.addEventListener('orientationchange', () => setTimeout(() => world && world.resize(), 250));

const hud = document.getElementById('hud');
const ctrlRight = document.getElementById('controls-right');
const btnShoot = document.getElementById('shoot-btn');
const btnBoost = document.getElementById('btn-boost');
const btnBrake = document.getElementById('btn-brake');
const btnSkillGhost = document.getElementById('skill-btn-ghost');
const btnSkillNuke = document.getElementById('skill-btn-nuke');
const boostSub = btnBoost ? btnBoost.querySelector('.btn-sub') : null;
/* held by the BOOST / BRAKE buttons until you let go */
let boostHeld = false, brakeHeld = false;
/* the stick steers; you only get nitro/brake by shoving it well past that */
const JOY_HOLD_DY = 34;              // out of a 55px range
const wheelZone = document.getElementById('wheel-zone');
const wheelRim = document.getElementById('wheel-rim');

/* A wheel, not a stick: grab the rim and turn it, and it springs back to
   centre when you let go. WHEEL_MAX is the lock in degrees each way. */
const WHEEL_MAX = 120;
let wheelAngle = 0, wheelGrab = false, wheelTouchId = null;
let wheelNearHub = false, wheelStartAngle = 0, wheelStartX = 0, wheelStartWheel = 0;
let brakeActive = false;
const wheelSteer = () => wheelAngle / WHEEL_MAX;        // -1 (full left) .. 1 (full right)
function wheelSetAngle(deg) {
    wheelAngle = Math.max(-WHEEL_MAX, Math.min(WHEEL_MAX, deg));
    if (wheelRim) wheelRim.style.transform = `rotate(${wheelAngle}deg)`;
}
function wheelCentre() {
    if (!wheelRim) return { x: 0, y: 0, r: 1 };
    const r = wheelRim.getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + r.height / 2, r: Math.max(1, r.width / 2) };
}
let audioCtx, engineOsc, engineOsc2, engineFilter, engineRasp, engineGain, masterGain;
const MASTER_VOLUME = 1.0;      // overall output
const SFX_VOLUME = 1.7;         // effects were barely audible before
const ENGINE_VOLUME = 0.12;     // engine level (was 0.015, then 0.055)

// --- MULTIPLAYER ROOM SYSTEMS ---
function createRoom() {
    myName = document.getElementById('host-name').value.trim();
    if(!myName) return alert("Enter Host Name!");
    
    currentRoom = Math.floor(1000 + Math.random() * 9000).toString();
    isHost = true;
    isMultiplayer = true;

    database.ref('car_rooms/' + currentRoom).set({
        status: "waiting",
        hostId: myId,
        players: {
            [myId]: { name: myName, score: 0, x: gameWidth/2, color: '#00f0ff' }
        }
    }).then(() => {
        document.getElementById('display-room-code').innerText = currentRoom;
        document.getElementById('btn-start').style.display = 'inline-block';
        document.getElementById('waiting-msg').style.display = 'none';
        
        document.getElementById('start-screen').classList.add('hidden');
        document.getElementById('waiting-screen').classList.remove('hidden');
        safeOnDisconnect(database.ref('car_rooms/' + currentRoom + '/players/' + myId));
        listenToRoom();
    });
}

function joinRoom() {
    myName = document.getElementById('joiner-name').value.trim();
    currentRoom = document.getElementById('room-code-input').value.trim();
    if(!myName || !currentRoom) return alert("Enter Player Name and Room Code!");
    isMultiplayer = true;

    database.ref('car_rooms/' + currentRoom).once('value', snapshot => {
        if(!snapshot.exists()) return alert("Room not found!");
        if(snapshot.val().status !== "waiting") return alert("Game already running/ended!");
        
        let c = ['#a200ff', '#ff00aa', '#ffea00', '#00ff66'][Math.floor(Math.random()*4)];
        
        database.ref('car_rooms/' + currentRoom + '/players/' + myId).set({
            name: myName, score: 0, x: gameWidth/2, color: c
        }).then(() => {
            document.getElementById('display-room-code').innerText = currentRoom;
            document.getElementById('start-screen').classList.add('hidden');
            document.getElementById('waiting-screen').classList.remove('hidden');
            listenToRoom();
        });
    });
}


/* ------------------------------------------------------------------ *
 *  QUICK MATCH — pair two strangers, then start the race by itself
 * ------------------------------------------------------------------ */
const MM_PATH = 'car_matchmaking';
const MM_STALE = 90000;              // ignore queue entries older than 90s
const START_DELAY = 3500;            // both cars launch off the same clock
const ROOM_CLEANUP_DELAY = 15000;    // room is wiped this long after the flag
let mmSearching = false, mmTimer = null, mmScan = null, mmListener = null;
let mmQueued = false, mmScanning = false, mmTs = 0, mmWaited = 0;
let raceStarting = false, roomClosed = false;

/* queue entries and abandoned rooms clean themselves up */
function safeOnDisconnect(ref) {
    try { ref.onDisconnect().remove(); } catch (e) { /* older SDK */ }
}
function setSearchUI(text, searching) {
    const t = document.getElementById('search-status');
    const b = document.getElementById('btn-find-random');
    if (t) t.innerText = text;
    if (b) b.innerText = searching ? 'CANCEL SEARCH' : '⚡ FIND RANDOM PLAYER';
}

function findRandomGame() {
    if (mmSearching) { cancelSearch(false); return; }
    const name = (document.getElementById('random-name').value || '').trim()
              || (document.getElementById('host-name').value || '').trim();
    if (!name) return alert("Enter your name first!");
    myName = name;
    isMultiplayer = true;
    roomClosed = false;
    mmSearching = true; mmWaited = 0; mmQueued = false; mmTs = Date.now();
    setSearchUI('SEARCHING FOR A DRIVER…', true);
    mmTimer = setInterval(() => {
        mmWaited++;
        if (mmSearching) setSearchUI(`SEARCHING FOR A DRIVER… ${mmWaited}s`, true);
        if (mmWaited >= 45) cancelSearch(true);
    }, 1000);
    mmLookForPartner();
    /* keep looking: whoever arrives second finds the first, and a dead heat
       on the queue timestamp resolves on the next pass */
    mmScan = setInterval(() => { if (mmSearching) mmLookForPartner(); }, 2000);
}

function mmLookForPartner() {
    if (mmScanning || !mmSearching) return;
    mmScanning = true;
    const q = database.ref(MM_PATH);
    q.once('value').then(snap => {
        mmScanning = false;
        if (!mmSearching) return;
        const now = Date.now();
        let partner = null;
        snap.forEach(c => {
            const v = c.val();
            if (!v || !v.id || v.id === myId) return;
            if (v.matched || now - (v.ts || 0) > MM_STALE) return;
            /* pair "up" only: whoever queued first hosts, so two players who
               click at the same instant can never both open a room.
               An identical timestamp is broken by comparing ids. */
            if ((v.ts || 0) > mmTs) return;
            if ((v.ts || 0) === mmTs && v.id < myId) return;
            if (!partner || (v.ts || 0) < partner.ts) partner = { key: c.key, ...v };
        });
        if (!partner) return mmEnterQueue(q);
        /* claim them with a transaction: only one player can win the pairing */
        q.child(partner.key + '/matched').transaction(cur => (cur === null ? myId : cur))
            .then(res => {
                if (!mmSearching) return;
                if (!res.committed) return;                         // beaten to it
                mmStartWith(partner, q);
            }).catch(() => mmEnterQueue(q));
    }).catch(() => { mmScanning = false; if (mmSearching) setSearchUI('COULD NOT REACH THE SERVER', true); });
}

function mmStartWith(partner, q) {
    const code = Math.floor(1000 + Math.random() * 9000).toString();
    isHost = true;
    currentRoom = code;
    const players = {};
    players[myId] = { name: myName, score: 0, x: gameWidth / 2, color: '#00f0ff' };
    players[partner.id] = { name: partner.name || 'Rival', score: 0, x: gameWidth / 2,
                            color: ['#a200ff', '#ff00aa', '#ffea00', '#00ff66'][Math.floor(Math.random() * 4)] };
    database.ref('car_rooms/' + code).set({
        status: 'playing', hostId: myId, auto: true,
        startAt: Date.now() + START_DELAY, players
    }).then(() => {
        q.child(partner.key).update({ room: code, hostName: myName });
        q.child(myId).remove();
        mmStopSearch();
        listenToRoom();
    });
}

function mmEnterQueue(q) {
    const ref = q.child(myId);
    ref.set({ id: myId, name: myName, ts: mmTs });
    if (mmQueued) return;                       // listener is already watching
    mmQueued = true;
    safeOnDisconnect(ref);
    mmListener = ref.on('value', snap => {
        const v = snap.val();
        if (!v || !v.room) return;
        if (!mmSearching) return;                // I already opened a room myself
        try { ref.off('value', mmListener); } catch (e) {}
        mmListener = null;
        currentRoom = v.room; isHost = false; isMultiplayer = true;
        mmStopSearch();
        ref.remove();
        listenToRoom();
    });
}

function mmStopSearch() {
    mmSearching = false;
    if (mmTimer) { clearInterval(mmTimer); mmTimer = null; }
    if (mmScan) { clearInterval(mmScan); mmScan = null; }
    setSearchUI('', false);
}
function cancelSearch(timedOut) {
    if (!mmSearching) return;
    mmSearching = false;
    if (mmTimer) { clearInterval(mmTimer); mmTimer = null; }
    if (mmScan) { clearInterval(mmScan); mmScan = null; }
    const ref = database.ref(MM_PATH + '/' + myId);
    if (mmListener) { try { ref.off('value', mmListener); } catch (e) {} mmListener = null; }
    ref.remove();
    setSearchUI(timedOut ? 'NO DRIVERS FOUND — TRY AGAIN' : '', false);
}

/* "3… 2… 1…" so both cars launch on the same beat */
function showStartCountdown(ms) {
    document.getElementById('start-screen').classList.add('hidden');
    document.getElementById('waiting-screen').classList.remove('hidden');
    const startBtn = document.getElementById('btn-start');
    if (startBtn) startBtn.style.display = 'none';
    const msg = document.getElementById('waiting-msg');
    let left = Math.max(1, Math.round(ms / 1000));
    if (msg) msg.innerText = `MATCH FOUND — RACE STARTS IN ${left}…`;
    const iv = setInterval(() => {
        left--;
        if (msg) msg.innerText = left > 0 ? `MATCH FOUND — RACE STARTS IN ${left}…` : 'GO!';
        if (left <= 0) clearInterval(iv);
    }, 1000);
    setTimeout(() => clearInterval(iv), ms + 400);
}

/* the room is wiped once everyone is done, so nothing is left on the server */
function scheduleRoomCleanup() {
    if (!isMultiplayer || !currentRoom || !isHost || roomClosed) return;
    const room = 'car_rooms/' + currentRoom;
    safeOnDisconnect(database.ref(room));              // gone even if the host closes the tab
    setTimeout(() => {
        if (roomClosed) return;
        roomClosed = true;
        database.ref(room).remove();
    }, ROOM_CLEANUP_DELAY);
}
function closeRoomNow() {
    if (!isMultiplayer || !currentRoom || !isHost || roomClosed) return;
    roomClosed = true;
    database.ref('car_rooms/' + currentRoom).remove();
}

function listenToRoom() {
    database.ref('car_rooms/' + currentRoom).on('value', snapshot => {
        const data = snapshot.val();
        if(!data) {                      // room was deleted — stop listening to it
            try { database.ref('car_rooms/' + currentRoom).off(); } catch (e) {}
            /* if the host pulled out of the lobby, send everyone back to it —
               but never yank a player off the results screen */
            const lobby = document.getElementById('waiting-screen');
            if (!gameActive && lobby && !lobby.classList.contains('hidden')) {
                lobby.classList.add('hidden');
                document.getElementById('start-screen').classList.remove('hidden');
                hideControls();
            }
            return;
        }

        if (data.status === "waiting") {
            // রুমে ব্যাক করার পর গেম ওভার স্ক্রিন হাইড করে ওয়েটিং স্ক্রিন চালু করা
            document.getElementById('gameover-screen').classList.add('hidden');
            document.getElementById('waiting-screen').classList.remove('hidden');
            hideControls();

            const list = document.getElementById('players-list');
            list.innerHTML = "";
            Object.keys(data.players).forEach(pid => {
                let li = document.createElement('li');
                li.innerText = "🏎️ " + data.players[pid].name + (pid === data.hostId ? " (Host)" : "");
                list.appendChild(li);
            });

            const chatBox = document.getElementById('chat-messages');
            chatBox.innerHTML = "";
            if (data.chats) {
                Object.keys(data.chats).forEach(msgId => {
                    let msg = data.chats[msgId];
                    let p = document.createElement('p');
                    p.style.marginBottom = "4px";
                    p.innerHTML = `<strong style="color:#ff0055;">${msg.sender}:</strong> <span style="color:#fff;">${msg.text}</span>`;
                    chatBox.appendChild(p);
                });
                chatBox.scrollTop = chatBox.scrollHeight;
            }
        } 
        else if (data.status === "playing" && !gameActive) {
            /* random matches carry a startAt so both cars launch together */
            const wait = Math.max(0, (data.startAt || 0) - Date.now());
            if (wait > 60) {
                if (!raceStarting) {
                    raceStarting = true;
                    showStartCountdown(wait);
                    setTimeout(() => { raceStarting = false; if (!gameActive) initGameAndFullscreen(); }, wait);
                }
            } else if (!raceStarting) {
                initGameAndFullscreen();
            }
        }
        
        if(data.players) {
            opponentsData = data.players;
            updateDistanceTrackerUI();
            
            if(data.status === "finished" && !gameActive) {
                showFinalLeaderboard();
            }
        }
    });

    document.getElementById('chat-input').addEventListener('keydown', function(e) {
        if (e.key === 'Enter') sendChatMessage();
    });
}

function sendChatMessage() {
    const input = document.getElementById('chat-input');
    const msgText = input.value.trim();
    if (!msgText) return;

    database.ref('car_rooms/' + currentRoom + '/chats').push({
        sender: myName,
        text: msgText,
        timestamp: Date.now()
    });
    input.value = "";
}

function startMultiplayerGame() {
    // পরবর্তী ম্যাচের জন্য সবার পয়েন্ট শুরুতে রিসেট করে দেওয়া
    let updates = { status: "playing" };
    Object.keys(opponentsData).forEach(id => {
        updates[`players/${id}/score`] = 0;
    });
    database.ref('car_rooms/' + currentRoom).update(updates);
}

function playSolo() {
    isMultiplayer = false;
    initGameAndFullscreen();
}

function updateDistanceTrackerUI() {
    if (!opponentsData) return;
    const laneBg = document.getElementById('tracker-lanes');
    laneBg.innerHTML = "";
    
    if (opponentsData[myId]) {
        let myKM = (opponentsData[myId].score / 1000).toFixed(2);
        const kmTxtEl = document.getElementById('km-txt');
        if(kmTxtEl) kmTxtEl.innerText = `${myKM} KM`;
    }

    let scores = Object.keys(opponentsData).map(id => opponentsData[id].score);
    let maxScore = Math.max(...scores, 1000); 

    Object.keys(opponentsData).forEach(id => {
        let p = opponentsData[id];
        let playerKM = (p.score / 1000).toFixed(2);
        
        let dot = document.createElement('div');
        dot.className = "player-progress-dot";
        dot.style.color = p.color || '#00f0ff';
        dot.style.backgroundColor = p.color || '#00f0ff';
        
        let progressPercent = (p.score / maxScore) * 82; 
        dot.style.left = `${progressPercent}%`;
        dot.innerHTML = `<span style="position:absolute; top:-20px; left:-12px; font-size:9px; color:#fff; white-space:nowrap; background:rgba(0,0,0,0.75); padding:1px 4px; border-radius:3px; border:1px solid ${p.color || '#00f0ff'}">${p.name.substring(0,3)}: ${playerKM}K</span>`;
        
        laneBg.appendChild(dot);
    });
}

function initGameAndFullscreen() {
    let container = document.getElementById('game-container');
    if (container.requestFullscreen) container.requestFullscreen().catch(()=>{});
    setupAudio();
    document.getElementById('start-screen').classList.add('hidden');
    document.getElementById('waiting-screen').classList.add('hidden');
    showControls();
    restartGame();
}

/* Everything runs through one compressor so the engine, the effects and the
   nitro can all be turned up without clipping when they overlap. */
function setupAudio() {
    if(audioCtx) return;
    audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    /* iOS leaves the context suspended unless it is made inside a real tap, and
       a random match starts from a network callback rather than a tap. Wake it
       now, and again on the first touch, so the engine is never silently dead. */
    const wake = () => { if (audioCtx && audioCtx.state === 'suspended' && audioCtx.resume) audioCtx.resume().catch(() => {}); };
    wake();
    ['touchstart', 'mousedown', 'keydown'].forEach(type =>
        document.addEventListener(type, wake, { once: true, passive: true }));

    masterGain = audioCtx.createGain();
    masterGain.gain.setValueAtTime(MASTER_VOLUME, audioCtx.currentTime);
    const comp = audioCtx.createDynamicsCompressor();
    comp.threshold.setValueAtTime(-14, audioCtx.currentTime);
    comp.knee.setValueAtTime(24, audioCtx.currentTime);
    comp.ratio.setValueAtTime(8, audioCtx.currentTime);
    comp.attack.setValueAtTime(0.004, audioCtx.currentTime);
    comp.release.setValueAtTime(0.18, audioCtx.currentTime);
    masterGain.connect(comp); comp.connect(audioCtx.destination);

    /* Engine: a low saw for the body, a detuned square an octave up for the
       rasp, and a filter that opens as the revs climb. A phone speaker cannot
       reproduce a 45 Hz fundamental at all, so it is the harmonics and the
       filter you actually hear — which is why one bare oscillator was silent. */
    engineOsc = audioCtx.createOscillator();
    engineOsc.type = 'sawtooth';
    engineOsc.frequency.setValueAtTime(45, audioCtx.currentTime);

    engineOsc2 = audioCtx.createOscillator();
    engineOsc2.type = 'square';
    engineOsc2.detune.setValueAtTime(9, audioCtx.currentTime);
    engineOsc2.frequency.setValueAtTime(91, audioCtx.currentTime);
    engineRasp = audioCtx.createGain();
    engineRasp.gain.setValueAtTime(0.5, audioCtx.currentTime);   // sits under the body

    engineFilter = audioCtx.createBiquadFilter();
    engineFilter.type = 'lowpass';
    engineFilter.frequency.setValueAtTime(400, audioCtx.currentTime);
    engineFilter.Q.setValueAtTime(1.2, audioCtx.currentTime);

    engineGain = audioCtx.createGain();
    engineGain.gain.setValueAtTime(ENGINE_VOLUME, audioCtx.currentTime);

    engineOsc.connect(engineFilter);
    engineOsc2.connect(engineRasp); engineRasp.connect(engineFilter);
    engineFilter.connect(engineGain); engineGain.connect(masterGain);
    engineOsc.start(0); engineOsc2.start(0);
}

function playSfx(freq, type, dur, vol) {
    if(!audioCtx) return;
    let osc = audioCtx.createOscillator(); let gain = audioCtx.createGain();
    osc.type = type; osc.frequency.setValueAtTime(freq, audioCtx.currentTime);
    const v = Math.min(0.9, vol * SFX_VOLUME);
    gain.gain.setValueAtTime(v, audioCtx.currentTime); gain.gain.exponentialRampToValueAtTime(0.01, audioCtx.currentTime + dur);
    osc.connect(gain); gain.connect(masterGain); osc.start(); osc.stop(audioCtx.currentTime + dur);
}

const gameContainer = document.getElementById('game-container');

/* ---- steering wheel ---- */
function wheelGrabAt(t) {
    const c = wheelCentre();
    const dx = t.clientX - c.x, dy = t.clientY - c.y;
    wheelGrab = true; wheelTouchId = t.identifier;
    /* near the hub the angle is all noise, so steer by drag there instead */
    wheelNearHub = Math.hypot(dx, dy) < c.r * 0.32;
    wheelStartAngle = Math.atan2(dy, dx) * 180 / Math.PI;
    wheelStartX = t.clientX;
    wheelStartWheel = wheelAngle;
}
if (wheelZone) {
    wheelZone.addEventListener('touchstart', (e) => {
        if (!gameActive) return;
        e.preventDefault(); e.stopPropagation();
        /* changedTouches, NOT touches: with a thumb already down on a pedal,
           touches[0] is that pedal finger, so the wheel used to latch onto
           the wrong touch and then ignore the one actually turning it. */
        const started = (e.changedTouches && e.changedTouches.length) ? e.changedTouches : e.touches;
        if (started && started.length) wheelGrabAt(started[started.length - 1]);
    }, { passive: false });

    wheelZone.addEventListener('touchmove', (e) => {
        if (!wheelGrab) return;
        const moved = (e.changedTouches && e.changedTouches.length) ? e.changedTouches : e.touches;
        for (const t of moved) {
            if (t.identifier !== wheelTouchId) continue;
            const c = wheelCentre();
            let delta;
            if (wheelNearHub) {
                delta = (t.clientX - wheelStartX) * 1.7;
            } else {
                const a = Math.atan2(t.clientY - c.y, t.clientX - c.x) * 180 / Math.PI;
                delta = ((a - wheelStartAngle + 540) % 360) - 180;   // shortest way round
            }
            wheelSetAngle(wheelStartWheel + delta);
            break;
        }
        e.preventDefault(); e.stopPropagation();
    }, { passive: false });

    const wheelRelease = (e) => {
        if (!wheelGrab) return;
        let still = false;
        const left = (e && e.touches) || [];
        for (const t of left) if (t.identifier === wheelTouchId) still = true;
        if (!still) { wheelGrab = false; wheelTouchId = null; }
    };
    wheelZone.addEventListener('touchend', wheelRelease);
    wheelZone.addEventListener('touchcancel', wheelRelease);

    /* desktop: drag the wheel with the mouse too */
    wheelZone.addEventListener('mousedown', (e) => { if (gameActive) { wheelGrabAt(e); wheelTouchId = null; } });
    window.addEventListener('mousemove', (e) => {
        if (!wheelGrab || wheelTouchId !== null) return;
        const c = wheelCentre();
        const delta = wheelNearHub ? (e.clientX - wheelStartX) * 1.7
            : ((Math.atan2(e.clientY - c.y, e.clientX - c.x) * 180 / Math.PI - wheelStartAngle + 540) % 360) - 180;
        wheelSetAngle(wheelStartWheel + delta);
    });
    window.addEventListener('mouseup', () => { wheelGrab = false; wheelTouchId = null; });
}

/* ---- landscape only: upright there is no road to look down ---- */
const rotateScreen = document.getElementById('rotate-screen');
let orientationLocked = false;
function checkOrientation() {
    const w = window.innerWidth, h = window.innerHeight;
    const locked = h > w * 1.05;            // upright, or so square it may as well be
    if (locked === orientationLocked) return;
    orientationLocked = locked;
    if (rotateScreen) rotateScreen.classList.toggle('show', locked);
}
window.addEventListener('resize', checkOrientation);
window.addEventListener('orientationchange', () => { setTimeout(checkOrientation, 250); });
checkOrientation();

const keys = { a: false, d: false, w: false, s: false };
window.addEventListener('keydown', e => {
    if(e.key === 'a' || e.key === 'ArrowLeft') keys.a = true;
    if(e.key === 'd' || e.key === 'ArrowRight') keys.d = true;
    if(e.key === 'w' || e.key === 'ArrowUp') keys.w = true;
    if(e.key === 's' || e.key === 'ArrowDown') keys.s = true;
    if(e.code === 'Space') { shootBullet(); e.preventDefault(); }
});
window.addEventListener('keyup', e => {
    if(e.key === 'a' || e.key === 'ArrowLeft') keys.a = false;
    if(e.key === 'd' || e.key === 'ArrowRight') keys.d = false;
    if(e.key === 'w' || e.key === 'ArrowUp') keys.w = false;
    if(e.key === 's' || e.key === 'ArrowDown') keys.s = false;
});

function bindButton(el, fn) {
    if (!el) return;
    const run = (e) => { fn(); e.preventDefault(); e.stopPropagation(); };
    el.addEventListener('touchstart', run, { passive: false });
    el.addEventListener('mousedown', run);
}
/* BOOST and BRAKE are hold-to-use: press down, keep, let go */
function bindHold(el, down, up) {
    if (!el) return;
    const on = (e) => { down(); e.preventDefault(); e.stopPropagation(); };
    const off = (e) => { up(); if (e) { e.preventDefault(); e.stopPropagation(); } };
    el.addEventListener('touchstart', on, { passive: false });
    el.addEventListener('touchend', off);
    el.addEventListener('touchcancel', off);
    el.addEventListener('mousedown', on);
    window.addEventListener('mouseup', off);
    window.addEventListener('blur', off);
}
bindButton(btnShoot, shootBullet);
bindButton(btnSkillGhost, useGhost);
bindButton(btnSkillNuke, useNuke);
bindHold(btnBoost, () => { boostHeld = true; btnBoost.classList.add('held'); },
                  () => { boostHeld = false; if (btnBoost) btnBoost.classList.remove('held'); });
bindHold(btnBrake, () => { brakeHeld = true; btnBrake.classList.add('held'); },
                   () => { brakeHeld = false; if (btnBrake) btnBrake.classList.remove('held'); });

function shootBullet() {
    if(!gameActive || bullets <= 0) return;
    bullets--; playSfx(600, 'triangle', 0.15, 0.3);
    activeBullets.push(new Bullet(player.x + player.w / 2 - 3, player.y));
    updateAmmoUI();
}

function updateAmmoUI() {
    document.querySelectorAll('.ammo-count').forEach(c => c.innerText = `${bullets} BULLETS`);
    document.querySelectorAll('.shoot-btn').forEach(b => bullets <= 0 ? b.classList.add('empty') : b.classList.remove('empty'));
    updateSkillUI();
}

/* GHOST (left): 5 ammo buys 3 seconds of phasing through traffic, blinking
   visible / invisible the whole time.  NUKE (right): 5 ammo wipes the road. */
function updateSkillUI() {
    const afford = bullets >= SKILL_COST && gameActive;
    const nukeReady = afford && enemies.length > 0;
    if (btnSkillGhost) {
        btnSkillGhost.classList.toggle('empty', !(afford && !ghostActive));
        btnSkillGhost.classList.toggle('ghosting', ghostActive);
        const sub = btnSkillGhost.querySelector('.btn-sub');
        if (sub) sub.innerText = ghostActive ? `${Math.ceil(ghostTimer / 60)}s` : `${SKILL_COST} AMMO`;
    }
    if (btnSkillNuke) {
        btnSkillNuke.classList.toggle('empty', !nukeReady);
        const subR = btnSkillNuke.querySelector('.btn-sub');
        if (subR) subR.innerText = nukeReady ? `${SKILL_COST} AMMO` : (afford ? 'NO CARS' : `${SKILL_COST} AMMO`);
    }
}

function useGhost() {
    if(!gameActive || bullets < SKILL_COST || ghostActive) return;
    bullets -= SKILL_COST;
    ghostActive = true;
    ghostTimer = GHOST_FRAMES;
    playSfx(760, 'sine', 0.35, 0.22);
    updateAmmoUI();
}

function useNuke() {
    if(!gameActive || bullets < SKILL_COST) return;
    bullets -= SKILL_COST;
    /* every car on the road liquefies at once */
    for (const e of enemies) {
        if (world) world.wreck(e.style, e.color, e.wx, e.wz, 1.15);
        for (let k = 0; k < 16; k++)
            particles.push(new Particle(e.x + e.w / 2, e.y + e.h / 2, e.color, (Math.random() - 0.5) * 14, Math.random() * 6 + 2));
        score += 100;
    }
    enemies = [];
    playSfx(150, 'square', 0.7, 0.6);
    screenShake = 30;
    screenFlash = 1.0;
    updateAmmoUI();
}

/* Bullets used to be plain {x,y} objects, so the 3D renderer was fed
   undefined coordinates and drew them nowhere. Now they expose world space. */
class Bullet {
    constructor(x, y) { this.x = x; this.y = y; this.w = 6; this.h = 22; }
    get wx() { return wx(this.x + this.w / 2); }
    get wz() { return wz(this.y + this.h / 2); }
}

class Player {
    constructor() {
        this.w = 44; this.h = 85;
        this.x = gameWidth / 2 - this.w / 2;
        this.y = gameHeight - 160;
        this.vx = 0; this.angle = 0;
        /* steering rack, lateral grip and body-motion state */
        this.steer = 0;              // actual front-wheel angle, -1..1
        this.latAccel = 0;           // smoothed lateral KMH-ish/s for body roll
        this.slip = 0;               // drift yaw (rad) when demand outruns grip
        this.pitch = 0; this.pitchV = 0;   // suspension spring-dampers
        this.roll = 0; this.rollV = 0;
    }
    update(step = 1) {
        const dt = step / 60;
        /* --- steering: the wheel works through a rack, so the front
           wheels chase your hands at a finite rate instead of snapping.
           The wheel's response is slightly progressive, which keeps
           small corrections near the centre precise. --- */
        let input = 0;
        if (Math.abs(wheelAngle) > 0.5) {
            const ws = wheelSteer();
            input = Math.sign(ws) * Math.pow(Math.abs(ws), 1.12);
        } else input = keys.a ? -0.8 : keys.d ? 0.8 : 0;
        const rack = (input - this.steer) * (1 - Math.pow(0.72, step));
        this.steer += Math.max(-0.14 * step, Math.min(0.14 * step, rack));

        /* --- lateral grip: how much sideways pace the tyres can build.
           A parked car cannot move sideways, authority ramps in with
           speed, then tapers off when really fast so the car stays
           stable instead of darty. Lateral acceleration is capped by
           grip, and whatever demand the grip cannot meet shows up as
           slip — the car yaws into the turn ahead of its travel. --- */
        const ramp = Math.max(0, Math.min(1, speed / 55));
        const taper = 1 - 0.22 * Math.max(0, Math.min(1, (speed - 190) / 230));
        const desiredVX = this.steer * 10 * ramp * taper;
        let dv = (desiredVX - this.vx) * (1 - Math.pow(1 - 0.24, step));
        const maxLat = 2.6 * step;
        dv = Math.max(-maxLat, Math.min(maxLat, dv));
        this.vx += dv;
        this.latAccel += ((dt > 0 ? dv / dt : 0) - this.latAccel) * (1 - Math.pow(0.65, step));
        const slipTarget = -Math.max(-0.10, Math.min(0.10, (desiredVX - this.vx) * 0.008));
        this.slip += (slipTarget - this.slip) * (1 - Math.pow(0.80, step));
        this.x += this.vx * step;
        this.angle = this.slip;

        /* --- body motion: pitch under power/brakes, roll in corners,
           each on its own stiff spring-damper so it settles with a
           hint of overshoot instead of moving like a switch. --- */
        const pitchT = Math.max(-0.055, Math.min(0.040, lonAccel * 0.00016));
        this.pitchV += ((pitchT - this.pitch) * 135 - this.pitchV * 13) * dt;
        this.pitch += this.pitchV * dt;
        const rollT = Math.max(-0.06, Math.min(0.06, this.latAccel * 0.00042));
        this.rollV += ((rollT - this.roll) * 120 - this.rollV * 12) * dt;
        this.roll += this.rollV * dt;

        /* The car's place across the road is the driver's alone. This x is
           measured from the road's own centreline (lanes, traffic and the
           renderer's bend all share that frame), so holding the wheel
           straight simply holds the car straight down the track — round
           bends exactly as on straights, no sideways push from the road,
           no drift toward the outside of a curve. The only things that
           can move this car sideways are the steering above and the
           barriers below. (An older version slid the car by however far
           the centreline had moved under it each frame, which walked a
           hands-off car into the barrier even on a straight and pushed
           it against every bend. That is what read as the car turning
           by itself, and it is gone.) */
        /* The barriers are solid: steering is yours alone, but the wall
           will stop you leaving the road -- at a cost, so sitting against it
           is not a way to take a corner. Arrive at the wall already moving
           sideways and it bounces you back off it like a real barrier;
           merely lean on it and it just grinds the speed away. */
        const lo = 22, hi = gameWidth - 22 - this.w;
        if(this.x < lo) {
            this.x = lo;
            if(this.vx < -4.5) { this.vx = -this.vx * 0.22; speed *= 0.95; }
            else if(this.vx < 0) this.vx = 0;
            this.scrape(step);
        }
        else if(this.x > hi) {
            this.x = hi;
            if(this.vx > 4.5) { this.vx = -this.vx * 0.22; speed *= 0.95; }
            else if(this.vx > 0) this.vx = 0;
            this.scrape(step);
        }

        /* --- exhaust trail (visual only) --- */
        if(speed > 40 && chance(0.6)) {
            const tipX = this.x + this.w * (Math.random() < 0.5 ? 0.36 : 0.64);
            particles.push(new Particle(tipX, this.y + this.h * 0.84, isNitro ? '#00f0ff' : '#ff0055', -speed*0.03, Math.random()*4+1));
        }
        /* --- tyre smoke when the tyres are sliding or the brakes bite --- */
        if(speed > 85 && (Math.abs(this.slip) > 0.045 || Math.abs(this.latAccel) > 95 || brakeActive) && chance(0.35)) {
            const side = this.vx > 0 ? 0.07 : 0.93;
            particles.push(new Particle(this.x + this.w * side, this.y + this.h * 0.80,
                'rgba(190,196,215,0.55)', -speed*0.02, Math.random()*3+2));
        }

        this.y += ((gameHeight - 160) - this.y) * (1 - Math.pow(0.95, step));
    }
    /* scraping the wall: it costs speed, it shakes the car, and it throws
       sparks off the side that is touching */
    scrape(step = 1) {
        speed = Math.max(speed * Math.pow(0.972, step), 0);
        if(world) {
            world.addShake(Math.min(7, Math.abs(speed) * 0.02 + 1));
            if(Math.random() < 0.5) world.spawnSplatter(
                wx(this.x + this.w / 2) + (this.x < gameWidth / 2 ? -22 : 22),
                wz(this.y + this.h / 2), '#ffb03a', 0.3);
        }
    }
    draw(hidden) {
        if(!world) return;
        world.setPlayer(wx(this.x + this.w / 2), wz(this.y + this.h / 2), {
            steer: Math.max(-1, Math.min(1, this.steer)),
            slip: this.slip, pitch: this.pitch, roll: this.roll,
            speed01: Math.max(0, Math.min(1, speed / SPEED_NITRO)),
            brake: brakeActive ? 1 : 0,
            boost: isNitro ? 1 : 0,
            phase: roadOffset,
            hidden: !!hidden
        });
    }
}

class Enemy {
    constructor() {
        this.w = 44; this.h = 85;
        const lanes = [40, 140, 240, 340, 410];
        /* canSpawn() chose a gap; fall back to a random lane if called directly */
        this.x = (pendingLane !== null ? pendingLane : lanes[Math.floor(Math.random() * lanes.length)]) + (Math.random()*8 - 4);
        this.y = SPAWN_Y;
        this.color = ['#a200ff', '#00ff66', '#ff8800', '#ff00aa'][Math.floor(Math.random() * 4)];
        /* body shape + a personal animation offset so no two cars move alike */
        const shapes = ['f1', 'f2', 'f3', 'f4', 'f2'];
        this.style = shapes[Math.floor(Math.random() * shapes.length)];
        this.phaseOff = Math.random() * 400;
        /* traffic with somewhere to be: each driver settles at their own
           pace around the old uniform 60 — still the speed the brake
           drops you to, so braking still slots you into the traffic —
           follows the car in front instead of driving through it, and
           changes lanes now and then when there is a proper gap. */
        this.vCruise = NPC_SPEED + (Math.random() * 16 - 8);   // 52..68
        this.v = this.vCruise;
        this.laneX = this.x;             // where the car is headed, laterally
        this.vx = 0;
        this.brake = false;              // feeds the brake lights
        this.travel = Math.random() * 200;   // own distance, for its wheels
        this.laneTimer = 260 + Math.random() * 520;
    }
    /* Traffic is moving too — it drives forward around the brake speed,
       so you reel it in instead of it charging at you. Brake to 60 and
       you run with it; stop dead after a crash and it drives away. */
    update(step = 1, others = []) {
        const dt = step / 60;
        /* follow the car ahead (ahead = further up the road = smaller y):
           ease off to hold a gap, brake properly if it closes up */
        let targetV = this.vCruise;
        this.brake = false;
        for (const o of others) {
            if (o === this || o.y >= this.y - 1 || Math.abs(o.x - this.x) > 40) continue;
            const gap = this.y - o.y;
            const want = 130 + this.v * 0.9;
            if (gap < want) targetV = Math.min(targetV, o.v - (want - gap) * 0.045);
            if (gap < 110) targetV = Math.min(targetV, o.v * 0.82);
        }
        if (targetV < this.v - 1) this.brake = true;
        /* engines and brakes are finite here too */
        const dv = Math.max(-68 * dt, Math.min(26 * dt, targetV - this.v));
        this.v = Math.max(30, Math.min(78, this.v + dv));
        this.y += (speed - this.v) * 0.08 * step;
        this.travel += this.v * 0.08 * step;

        /* --- lane changes: only into a clear gap, eased over ~2s --- */
        const dx = this.laneX - this.x;
        if (Math.abs(dx) > 1.2 || Math.abs(this.vx) > 0.05) {
            const wantVX = Math.max(-0.95, Math.min(0.95, dx * 0.035));
            this.vx += (wantVX - this.vx) * (1 - Math.pow(0.94, step));
            this.x += this.vx * step;
            if (Math.abs(dx) <= 1.2) { this.x = this.laneX; this.vx = 0; }
        } else {
            this.vx = 0;
            this.laneTimer -= step;
            if (this.laneTimer <= 0) {
                this.laneTimer = 320 + Math.random() * 620;
                if (Math.random() < 0.55) this.tryLaneChange(others);
            }
        }
    }
    tryLaneChange(others) {
        const lanes = [40, 140, 240, 340, 410];
        let cur = 0;
        for (let i = 1; i < lanes.length; i++)
            if (Math.abs(lanes[i] - this.laneX) < Math.abs(lanes[cur] - this.laneX)) cur = i;
        const dir = cur === 0 ? 1 : cur === lanes.length - 1 ? -1 : (Math.random() < 0.5 ? -1 : 1);
        const target = lanes[cur + dir] + (Math.random() * 8 - 4);
        /* the target lane must be clear by a wide margin, counting cars
           already on their way into it — and never sideswipe the player */
        for (const o of others) {
            if (o === this) continue;
            if ((Math.abs(o.x - target) < 40 || Math.abs(o.laneX - target) < 40) &&
                Math.abs(o.y - this.y) < 240) return;
        }
        if (player && Math.abs(this.y - player.y) < 190 && Math.abs(player.x - target) < 58) return;
        this.laneX = target;
    }
    /* world-space position + the bits the 3D renderer needs */
    get wx() { return wx(this.x + this.w / 2); }
    get wz() { return wz(this.y + this.h / 2); }
    get steer() {
        const sway = Math.sin((roadOffset + this.phaseOff) * 0.012) * 0.16;
        return Math.max(-0.6, Math.min(0.6, sway + (this.vx || 0) * 0.35));
    }
    get phase() { return roadOffset + this.phaseOff; }
}

class Star {
    constructor() {
        this.r = 18; const lanes = [50, 150, 250, 350, 420];
        this.x = lanes[Math.floor(Math.random() * lanes.length)]; this.y = SPAWN_Y; this.rot = 0;
    }
    update(step = 1) { this.y += speed * 0.08 * step; this.rot += 0.05 * step; }
    get wx() { return wx(this.x); }
    get wz() { return wz(this.y); }
}

/* screen-space particle (unchanged maths) that the 3D renderer reads */
class Particle {
    constructor(x, y, color, vy, size) {
        this.x = x; this.y = y; this.color = color;
        this.vx = Math.random() * 4 - 2; this.vy = vy; this.alpha = 1; this.size = size;
        this.rgb = parseColor(color);
    }
    update(step = 1) { this.x += this.vx * step; this.y += this.vy * step; this.alpha -= 0.05 * step; }
    get wx() { return wx(this.x); }
    get wz() { return wz(this.y); }
    get wy() { return 6 + (1 - this.alpha) * 26; }        /* smoke rises as it fades */
    get r() { return this.rgb[0]; }
    get g() { return this.rgb[1]; }
    get b() { return this.rgb[2]; }
    get a() { return Math.max(0, this.alpha); }
}

/* '#rgb' | '#rrggbb' | 'rgba(r,g,b,a)' -> 0..1 components */
const _pcCache = {};
function parseColor(c) {
    if (_pcCache[c]) return _pcCache[c];
    let out = [1, 1, 1];
    const m = String(c).match(/^rgba?\(\s*([\d.]+)[\s,]+([\d.]+)[\s,]+([\d.]+)/i);
    if (m) out = [+m[1] / 255, +m[2] / 255, +m[3] / 255];
    else {
        let h = String(c).replace('#', '');
        if (h.length === 3) h = h[0] + h[0] + h[1] + h[1] + h[2] + h[2];
        const n = parseInt(h, 16) || 0;
        out = [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255];
    }
    return (_pcCache[c] = out);
}

function restartGame() {
    /* the engine was muted at the last flag — bring it back for the new race */
    if(engineGain) engineGain.gain.setValueAtTime(ENGINE_VOLUME, audioCtx.currentTime);
    player = new Player();
    enemies = []; stars = []; particles = []; activeBullets = [];
    score = 0; speed = 0; nitro = START_NITRO; bullets = 0; crashStun = 0;
    lonAccel = 0; engineLoad = 0;
    reseedCurves();          // a fresh set of bends for every race
    raceTimeLeft = RACE_SECONDS; 
    gameActive = true; screenFlash = 0;
    ghostActive = false; ghostTimer = 0;
    wheelSetAngle(0); wheelGrab = false; wheelTouchId = null; updateAmmoUI();
    document.getElementById('gameover-screen').classList.add('hidden');
    document.getElementById('leaderboard-box').style.display = 'none';
    document.getElementById('timer-txt').innerText = fmtTime(RACE_SECONDS);

    if(timerInterval) clearInterval(timerInterval);
    timerInterval = setInterval(() => {
        if(gameActive && !orientationLocked) {
            raceTimeLeft--;
            document.getElementById('timer-txt').innerText = fmtTime(raceTimeLeft);
            if(raceTimeLeft <= 0) {
                endRaceDuration();
            }
        }
    }, 1000);
}

function endRaceDuration() {
    gameActive = false;
    clearInterval(timerInterval);
    if(engineGain) engineGain.gain.setValueAtTime(0, audioCtx.currentTime);
    
    document.getElementById('gameover-title').innerText = "RACE FINISHED";
    document.getElementById('gameover-title').style.background = "linear-gradient(45deg, #00ff66, #ffea00)";
    
    let myKM = (score / 1000).toFixed(2);
    document.getElementById('final-score-lbl').innerText = `YOUR FINAL SCORE: ${Math.floor(score)} (${myKM} KM)`;
    
    if(isMultiplayer && isHost && !roomClosed) {
        database.ref('car_rooms/' + currentRoom).update({ status: "finished" });
        scheduleRoomCleanup();
    }
    
    if(isMultiplayer) {
        showFinalLeaderboard();
    } else {
        // সোলো গেমপ্লে ট্র্যাকিংয়ের জন্যও কিলোমিটার ডিসপ্লে
        const box = document.getElementById('leaderboard-box');
        const list = document.getElementById('leaderboard-list');
        list.innerHTML = `<li><strong style="color:#00f0ff;">${myName || 'Solo Driver'}</strong> - ${Math.floor(score)} pts (${myKM} KM)</li>`;
        box.style.display = 'block';
    }
    document.getElementById('gameover-screen').classList.remove('hidden');
    hideControls();
}

/* every on-screen control, so nothing is left live behind an overlay */
function hideControls() {
    hud.style.display = 'none';
    if(ctrlRight) ctrlRight.style.display = 'none';
    if(wheelZone) wheelZone.style.display = 'none';
    /* a held pedal or a turned wheel must never be left on behind an overlay */
    boostHeld = false; brakeHeld = false;
    if(btnBrake) btnBrake.classList.remove('held');
    if(btnBoost) btnBoost.classList.remove('held');
    wheelGrab = false; wheelTouchId = null; wheelSetAngle(0);
}
function showControls() {
    hud.style.display = 'block';
    if(ctrlRight) ctrlRight.style.display = 'flex';
    if(wheelZone) wheelZone.style.display = 'block';
}

// --- NEW FUNCTION: BACK TO LOBBY (WITHOUT DISCONNECTING) ---
function backToLobby() {
    if(isMultiplayer) {
        // হোস্ট ক্লিক করলে পুরো রুমের স্ট্যাটাসই "waiting" এ চলে যাবে এবং বাকিরা রিয়েল-টাইম লবিতে ফেরত যাবে
        if(isHost) {
            closeRoomNow();
        } else {
            // নরমাল জয়েন করা প্লেয়াররা জাস্ট ওয়েটিং স্ক্রিন অন করবে (হোস্ট স্ট্যাটাস চেঞ্জ করা পর্যন্ত)
            document.getElementById('gameover-screen').classList.add('hidden');
            document.getElementById('waiting-screen').classList.remove('hidden');
        }
    } else {
        // সোলো প্র্যাকটিসের ক্ষেত্রে রিফ্রেশ না করে মেইন স্ক্রিনে ব্যাক করা
        document.getElementById('gameover-screen').classList.add('hidden');
        document.getElementById('start-screen').classList.remove('hidden');
    }
}

/* A collision animates BOTH cars: the traffic car wrecks and sprays liquid,
   the player's car is thrown into a spin. */
function crashInto(e) {
    if (world) {
        world.wreck(e.style, e.color, e.wx, e.wz, 1.25);
        world.spawnSplatter(wx(player.x + player.w / 2), wz(player.y + player.h * 0.35),
                            isNitro ? '#00f0ff' : '#ffaa22', 1.3);
        world.playerHit();
    }
    triggerCrash();
}

function triggerCrash() {
    screenShake = 30;
    screenFlash = 0.5;
    playSfx(120, 'sawtooth', 0.5, 0.4);

    /* sparks + shards flying off the impact (visual only) */
    const debris = ['#ff8800', '#ffea00', '#ffffff', '#ff0055'];
    for (let k = 0; k < 24; k++) {
        particles.push(new Particle(player.x + player.w / 2, player.y + player.h * 0.35,
            debris[k % 4], -(Math.random() * 6 + 2), Math.random() * 6 + 2));
    }

    score = Math.max(0, score - 800); 
    speed = 0;
    crashStun = CRASH_STUN;              // the car sits at 0 KMH before it picks up
    player.y = Math.min(gameHeight - 80, player.y + 120); 
}

function showFinalLeaderboard() {
    const box = document.getElementById('leaderboard-box');
    const list = document.getElementById('leaderboard-list');
    list.innerHTML = "";
    box.style.display = 'block';

    let playersArr = Object.keys(opponentsData).map(id => opponentsData[id]);
    playersArr.sort((a, b) => b.score - a.score);

    playersArr.forEach((p, idx) => {
        let pKM = (p.score / 1000).toFixed(2); // কিলোমিটার ক্যালকুলেশন
        let li = document.createElement('li');
        // লিডারবোর্ডে পয়েন্টের পাশাপাশি অতিক্রান্ত দূরত্ব (KM) যুক্ত করা হয়েছে
        li.innerHTML = `<strong style="color:${p.color || '#fff'}">${p.name}</strong> - ${Math.floor(p.score)} pts <span style="color:#00ff66; font-size:0.9rem; margin-left:8px;">(${pKM} KM)</span>`;
        list.appendChild(li);
    });
}

/* rival drivers are drawn as real cars in the 3D world, ahead of or behind
   you according to their score, with a floating name tag */
function syncOpponents() {
    if(!world || !isMultiplayer || !opponentsData) { if(world) world.syncGhosts([], roadOffset); return; }
    const ghosts = [];
    for(let id in opponentsData) {
        if(id === myId) continue;
        const opp = opponentsData[id];
        const drawY = player.y - (opp.score - score) * 3;
        if(drawY > -300 && drawY < gameHeight + 100) {
            ghosts.push({
                wx: wx(opp.x + 22), wz: wz(drawY + 42.5),
                style: ['f1', 'f2', 'f3'][(id.charCodeAt(0) + id.length) % 3],
                color: opp.color || '#a200ff',
                name: opp.name,
                steer: Math.sin((roadOffset + (opp.score % 50)) * 0.01) * 0.2
            });
        }
    }
    world.syncGhosts(ghosts, roadOffset);
}

function render(ts) {
    physStep = frameStep(ts);
    /* locked upright: hold the race exactly where it is until they turn round */
    if (orientationLocked) { requestAnimationFrame(render); return; }
    if(screenShake > 0) { screenShake *= Math.pow(0.9, physStep); if(screenShake < 0.5) screenShake = 0; }

    /* the steering wheel self-centres the moment you let go of it --
       and like a real car's castor, it winds back harder the faster
       you are going */
    if(!wheelGrab && wheelAngle !== 0) {
        const centreF = Math.pow(0.86 - Math.min(1, speed / SPEED_NITRO) * 0.10, physStep);
        wheelSetAngle(Math.abs(wheelAngle) < 0.6 ? 0 : wheelAngle * centreF);
    }

    if(gameActive) {
        /* steering is the stick's whole job; nitro and brake only kick in
           when you drag it well past that, or you hold the new buttons */
        let nitroReq = keys.w || boostHeld;
        let brakeReq = keys.s || brakeHeld; 
        isNitro = nitroReq && nitro > 0;
        brakeActive = brakeReq;
        
        /* a crash stops the car dead: no throttle, no nitro burn, 0 KMH on the
           clock for CRASH_STUN frames, then it accelerates away again */
        if(crashStun > 0) { crashStun -= physStep; isNitro = false; }

        // --- Nitro top speed & burn rate (0.24 per 60fps frame) ---
        if(isNitro) { targetSpeed = SPEED_NITRO; nitro -= 0.24 * physStep; if(nitro < 0) nitro = 0; screenShake = Math.max(screenShake, 2.0); }
        else if (brakeReq) targetSpeed = SPEED_BRAKE; else targetSpeed = SPEED_CRUISE;

        /* the force balance: engine, drag, brakes, the hill under the
           car and the speed scrubbed off by cornering hard */
        if(crashStun > 0) { speed = 0; lonAccel = 0; engineLoad = 0; }
        else {
            const grade = world ? world.roadGrade() : 0;
            const scrub = player ? Math.abs(player.steer) * Math.abs(player.vx) * 0.9 : 0;
            lonAccel = longitudinalAccel(speed, targetSpeed, isNitro, brakeReq, grade, scrub);
            speed = Math.max(0, speed + lonAccel * (physStep / 60));
        }
        score += (speed * 0.015) * physStep;
        roadOffset += (speed * 0.08) * physStep;

        /* the note follows the speed: revs climb, the rasp tracks an octave up
           and the filter opens, so accelerating sounds like accelerating.
           Revs now climb in gears — each band sweeps up and drops at the
           shift — and the filter opens wider the harder the engine works. */
        if(engineOsc && audioCtx) {
            const GEARS = [0, 70, 115, 165, 225, 295, 360, 430];
            let gFrac = 1;
            for (let gi = 1; gi < GEARS.length; gi++)
                if (speed < GEARS[gi]) { gFrac = (speed - GEARS[gi - 1]) / (GEARS[gi] - GEARS[gi - 1]); break; }
            const rev = (45 + speed * 0.55) * (0.88 + 0.24 * gFrac);   // 45 idle .. ~275 flat out
            engineOsc.frequency.setValueAtTime(rev, audioCtx.currentTime);
            engineOsc2.frequency.setValueAtTime(rev * 2.02, audioCtx.currentTime);
            engineFilter.frequency.setValueAtTime(320 + speed * 7 + engineLoad * 450, audioCtx.currentTime);
            /* louder the faster you go, and it howls under nitro, but never
               while the race is over — that mute is set in gameOver() */
            if(engineGain && gameActive) engineGain.gain.setValueAtTime(
                ENGINE_VOLUME * (isNitro ? 1.5 : 1) * (0.55 + Math.min(1, speed / 220) * 0.45),
                audioCtx.currentTime);
        }

        document.getElementById('score-txt').innerText = String(Math.floor(score)).padStart(5, '0');
        document.getElementById('speed-txt').innerText = `${Math.floor(speed)} KMH`;
        document.getElementById('nitro-bar-fill').style.width = `${nitro}%`;
        document.getElementById('nitro-percent-txt').innerText = `${Math.floor(nitro)}%`;
        /* the BOOST button mirrors the gauge and greys out when it is empty */
        const nitroTxt = `${Math.floor(nitro)}%`;
        if(boostSub && boostSub.innerText !== nitroTxt) boostSub.innerText = nitroTxt;
        if(btnBoost) btnBoost.classList.toggle('empty', nitro <= 0);

        if(isMultiplayer && Date.now() - lastSyncTime > 100) {
            database.ref('car_rooms/' + currentRoom + '/players/' + myId).update({
                x: player.x,
                score: score
            });
            lastSyncTime = Date.now();
        }
    } else {
        speed *= Math.pow(0.9, physStep);
        roadOffset += (speed * 0.08) * physStep;
        brakeActive = false;
        lonAccel = 0; engineLoad = 0;
    }

    if(world) {
        world.scrollRoad(roadOffset, physStep);
        world.addShake(screenShake);
    }

    /* ---- bullets: travel forward, kill traffic on contact ---- */
    for(let i = activeBullets.length - 1; i >= 0; i--) {
        let b = activeBullets[i]; b.y -= 18 * physStep; let killed = false;
        for(let j = enemies.length - 1; j >= 0; j--) {
            let e = enemies[j];
            if(b.x > e.x && b.x < e.x + e.w && b.y > e.y && b.y < e.y + e.h) {
                /* the shot car tumbles away and sprays liquid */
                if(world) world.wreck(e.style, e.color, e.wx, e.wz, 1);
                for(let k=0; k<25; k++) particles.push(new Particle(e.x + e.w/2, e.y + e.h/2, e.color, (Math.random()-0.5)*12, Math.random()*5+2));
                playSfx(300, 'sawtooth', 0.2, 0.25);
                enemies.splice(j, 1); activeBullets.splice(i, 1); score += 100; killed = true; break;
            }
        }
        /* Only retire the bullet for going off screen if it did NOT just kill
           something: the array has shifted by then, so splicing again ate the
           next bullet in line. */
        if(!killed && b.y < -50) activeBullets.splice(i, 1);
    }
    if(world) world.syncBullets(activeBullets);

    for(let i = particles.length - 1; i >= 0; i--) {
        particles[i].update(physStep);
        if(particles[i].alpha <= 0) particles.splice(i,1);
    }
    if(world) world.syncParticles(particles);

    /* stars share the far spawn, so a longer road means each one takes far longer
       to arrive: three in flight keeps a pickup reaching you every ~5 s */
    if(gameActive && chance(0.022) && stars.length < 3) stars.push(new Star());
    for(let i = stars.length - 1; i >= 0; i--) {
        stars[i].update(physStep);
        if(gameActive && player && Math.abs(player.x + player.w/2 - stars[i].x) < player.w/2 + stars[i].r && Math.abs(player.y + player.h/2 - stars[i].y) < player.h/2 + stars[i].r) {
            nitro = Math.min(100, nitro + 20); bullets++; updateAmmoUI(); score += 150; playSfx(900, 'sine', 0.25, 0.3);
            for(let k=0; k<15; k++) particles.push(new Particle(stars[i].x, stars[i].y, '#ffea00', (Math.random()-0.5)*8, Math.random()*4+2));
            stars.splice(i, 1); continue;
        }
        if(stars[i].y > gameHeight + 100) stars.splice(i, 1);
    }
    if(world) world.syncStars(stars, roadOffset);

    if(gameActive && chance(0.075) && enemies.length < MAX_ENEMIES && canSpawn(enemies)) enemies.push(new Enemy());
    for(let i = enemies.length - 1; i >= 0; i--) {
        enemies[i].update(physStep, enemies);
        if(gameActive && player && !ghostActive && player.x < enemies[i].x + enemies[i].w - 5 && player.x + player.w > enemies[i].x + 5 && player.y < enemies[i].y + enemies[i].h - 5 && player.y + player.h > enemies[i].y + 6) {
            crashInto(enemies[i]);
            enemies.splice(i, 1); continue;
        }
        if(enemies[i].y > gameHeight + 100) { enemies.splice(i, 1); if(gameActive) score += 30; }
    }
    if(enemies.length !== lastEnemyCount) { lastEnemyCount = enemies.length; updateSkillUI(); }
    if(world) world.syncEnemies(enemies, speed, player ? wz(player.y + player.h / 2) : 0);

    syncOpponents();

    /* ---- ghost skill countdown + blink ---- */
    let playerHidden = false;
    if(ghostActive && !gameActive) { ghostActive = false; ghostTimer = 0; updateSkillUI(); }
    if(ghostActive) {
        const was = ghostTimer;
        ghostTimer -= physStep;
        const period = ghostTimer < 60 ? 4 : 6;             // blinks faster as it runs out
        playerHidden = Math.floor(ghostTimer / period) % 2 === 1;
        if(Math.floor(was / 15) !== Math.floor(ghostTimer / 15)) updateSkillUI();
        if(ghostTimer <= 0) { ghostActive = false; playerHidden = false; updateSkillUI(); }
    }

    if(player) {
        if(gameActive) player.update(physStep);
        player.draw(playerHidden);
    }

    if (screenFlash > 0) {
        flashEl.style.opacity = screenFlash;
        screenFlash -= 0.05 * physStep;
    } else if (flashEl.style.opacity !== '0') {
        flashEl.style.opacity = '0';
    }

    if(world) world.render();
    requestAnimationFrame(render);
}

const flashEl = document.getElementById('flash');

/* the lobby buttons are wired with onclick="" in index.html, so the handlers
   have to live on window now that this file is an ES module */
/* how far the car is from the centreline, in world units -- negative means
   left of the middle of the road. It is the one number that says whether you
   are still on the road, and the dev harness steers by it. */
const carRoadOffset = () => player ? wx(player.x + player.w / 2) : 0;
Object.assign(window, {
    createRoom, joinRoom, playSolo, sendChatMessage, startMultiplayerGame, backToLobby,
    useGhost, useNuke, shootBullet, findRandomGame, cancelSearch, checkOrientation,
    wheelSetAngle, carRoadOffset
});

player = new Player();
requestAnimationFrame(render);
