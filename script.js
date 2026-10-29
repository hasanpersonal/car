import * as THREE from 'three';
import { World, wx, wz } from './scene3d.js';

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
const MAX_ENEMIES = 9;
const SPAWN_Y = -1800;          // screen units: ~97% fogged, well past the horizon

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

/* --- race length: 2.5 minutes --- */
const RACE_SECONDS = 150;
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
const btnLeft = document.getElementById('shoot-btn-left');
const btnRight = document.getElementById('shoot-btn-right');
const btnSkillLeft = document.getElementById('skill-btn-left');
const btnSkillRight = document.getElementById('skill-btn-right');
const joyContainer = document.getElementById('joystick-container');
const joyKnob = document.getElementById('joystick-knob');

let joyActive = false, joyTouchId = null, joyStartX = 0, joyStartY = 0;
let joyDX = 0, joyDY = 0, brakeActive = false;
const maxRange = 55; 
let audioCtx, engineOsc, engineGain, masterGain;
const MASTER_VOLUME = 1.0;      // overall output
const SFX_VOLUME = 1.7;         // effects were barely audible before
const ENGINE_VOLUME = 0.055;    // idle engine level (was 0.015)

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

    masterGain = audioCtx.createGain();
    masterGain.gain.setValueAtTime(MASTER_VOLUME, audioCtx.currentTime);
    const comp = audioCtx.createDynamicsCompressor();
    comp.threshold.setValueAtTime(-14, audioCtx.currentTime);
    comp.knee.setValueAtTime(24, audioCtx.currentTime);
    comp.ratio.setValueAtTime(8, audioCtx.currentTime);
    comp.attack.setValueAtTime(0.004, audioCtx.currentTime);
    comp.release.setValueAtTime(0.18, audioCtx.currentTime);
    masterGain.connect(comp); comp.connect(audioCtx.destination);

    engineOsc = audioCtx.createOscillator();
    engineGain = audioCtx.createGain();
    engineOsc.type = 'sawtooth';
    engineOsc.frequency.setValueAtTime(40, audioCtx.currentTime);

    let filter = audioCtx.createBiquadFilter();
    filter.type = 'lowpass'; filter.frequency.setValueAtTime(180, audioCtx.currentTime);
    engineOsc.connect(filter); filter.connect(engineGain); engineGain.connect(masterGain);
    engineGain.gain.setValueAtTime(ENGINE_VOLUME, audioCtx.currentTime); engineOsc.start(0);
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
gameContainer.addEventListener('touchstart', (e) => {
    if (!gameActive) return;
    if (e.target.closest('.shoot-btn') || e.target.closest('.skill-btn') || e.target.closest('.overlay')) return;


    const rect = gameContainer.getBoundingClientRect();
    for (let i = 0; i < e.touches.length; i++) {
        const touch = e.touches[i];
        if (!joyActive) {
            joyActive = true; joyTouchId = touch.identifier;
            joyStartX = touch.clientX; joyStartY = touch.clientY;
            joyContainer.style.display = 'block';
            joyContainer.style.left = `${touch.clientX - rect.left}px`;
            joyContainer.style.top = `${touch.clientY - rect.top}px`;
            joyKnob.style.transform = 'translate(0px, 0px)';
            break;
        }
    }
});

gameContainer.addEventListener('touchmove', (e) => {
    if (!joyActive) return;
    let targetTouch = null;
    for (let i = 0; i < e.touches.length; i++) {
        if (e.touches[i].identifier === joyTouchId) { targetTouch = e.touches[i]; break; }
    }
    if (!targetTouch) return;
    joyDX = targetTouch.clientX - joyStartX; joyDY = targetTouch.clientY - joyStartY;
    const distance = Math.sqrt(joyDX * joyDX + joyDY * joyDY);
    if (distance > maxRange) { joyDX = (joyDX / distance) * maxRange; joyDY = (joyDY / distance) * maxRange; }
    joyKnob.style.transform = `translate(${joyDX}px, ${joyDY}px)`;
});

gameContainer.addEventListener('touchend', (e) => {
    if (!joyActive) return;
    let stillActive = false;
    for (let i = 0; i < e.touches.length; i++) {
        if (e.touches[i].identifier === joyTouchId) { stillActive = true; break; }
    }
    if (!stillActive) { joyActive = false; joyTouchId = null; joyDX = 0; joyDY = 0; joyContainer.style.display = 'none'; }
});

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
bindButton(btnLeft, shootBullet);
bindButton(btnRight, shootBullet);
bindButton(btnSkillLeft, useGhost);
bindButton(btnSkillRight, useNuke);

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
    if (btnSkillLeft) {
        btnSkillLeft.classList.toggle('empty', !(afford && !ghostActive));
        btnSkillLeft.classList.toggle('ghosting', ghostActive);
        const sub = btnSkillLeft.querySelector('.skill-sub');
        if (sub) sub.innerText = ghostActive ? `${Math.ceil(ghostTimer / 60)}s` : `${SKILL_COST} AMMO`;
    }
    if (btnSkillRight) {
        btnSkillRight.classList.toggle('empty', !nukeReady);
        const subR = btnSkillRight.querySelector('.skill-sub');
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
    }
    update() {
        let targetVX = joyActive ? (joyDX / maxRange) * 10 : (keys.a ? -8 : keys.d ? 8 : 0);
        this.vx += (targetVX - this.vx) * 0.25;
        this.x += this.vx; this.angle = this.vx * 0.012;
        if(this.x < 22) { this.x = 22; this.vx = 0; }
        if(this.x > gameWidth - 22 - this.w) { this.x = gameWidth - 22 - this.w; this.vx = 0; }

        /* --- exhaust trail (visual only) --- */
        if(speed > 40 && Math.random() < 0.6) {
            const tipX = this.x + this.w * (Math.random() < 0.5 ? 0.36 : 0.64);
            particles.push(new Particle(tipX, this.y + this.h * 0.84, isNitro ? '#00f0ff' : '#ff0055', -speed*0.03, Math.random()*4+1));
        }
        /* --- tyre smoke when the car is thrown sideways or braked hard --- */
        if(speed > 90 && (Math.abs(this.vx) > 6 || brakeActive) && Math.random() < 0.35) {
            const side = this.vx > 0 ? 0.07 : 0.93;
            particles.push(new Particle(this.x + this.w * side, this.y + this.h * 0.80,
                'rgba(190,196,215,0.55)', -speed*0.02, Math.random()*3+2));
        }
        
        this.y += ((gameHeight - 160) - this.y) * 0.05;
    }
    draw(hidden) {
        if(!world) return;
        world.setPlayer(wx(this.x + this.w / 2), wz(this.y + this.h / 2), {
            steer: Math.max(-1, Math.min(1, this.vx / 9)),
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
    }
    /* Traffic is moving too — it drives forward at the brake speed (60), so
       you reel it in instead of it charging at you. Brake to 60 and you match
       it exactly; stop dead after a crash and it drives away from you. */
    update() { this.y += (speed - NPC_SPEED) * 0.08; }
    /* world-space position + the bits the 3D renderer needs */
    get wx() { return wx(this.x + this.w / 2); }
    get wz() { return wz(this.y + this.h / 2); }
    get steer() { return Math.sin((roadOffset + this.phaseOff) * 0.012) * 0.16; }
    get phase() { return roadOffset + this.phaseOff; }
}

class Star {
    constructor() {
        this.r = 18; const lanes = [50, 150, 250, 350, 420];
        this.x = lanes[Math.floor(Math.random() * lanes.length)]; this.y = SPAWN_Y; this.rot = 0;
    }
    update() { this.y += speed * 0.08; this.rot += 0.05; }
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
    update() { this.x += this.vx; this.y += this.vy; this.alpha -= 0.05; }
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
    score = 0; speed = 0; nitro = 0; bullets = 0; crashStun = 0;
    raceTimeLeft = RACE_SECONDS; 
    gameActive = true; joyActive = false; joyTouchId = null; screenFlash = 0;
    ghostActive = false; ghostTimer = 0;
    joyContainer.style.display = 'none'; updateAmmoUI();
    document.getElementById('gameover-screen').classList.add('hidden');
    document.getElementById('leaderboard-box').style.display = 'none';
    document.getElementById('timer-txt').innerText = fmtTime(RACE_SECONDS);

    if(timerInterval) clearInterval(timerInterval);
    timerInterval = setInterval(() => {
        if(gameActive) {
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
    btnLeft.style.display = 'none';
    btnRight.style.display = 'none';
    if(btnSkillLeft) btnSkillLeft.style.display = 'none';
    if(btnSkillRight) btnSkillRight.style.display = 'none';
}
function showControls() {
    hud.style.display = 'block';
    btnLeft.style.display = 'flex';
    btnRight.style.display = 'flex';
    if(btnSkillLeft) btnSkillLeft.style.display = 'flex';
    if(btnSkillRight) btnSkillRight.style.display = 'flex';
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

function render() {
    if(screenShake > 0) { screenShake *= 0.9; if(screenShake < 0.5) screenShake = 0; }

    if(gameActive) {
        let nitroReq = (joyActive && joyDY < -14) || keys.w;
        let brakeReq = (joyActive && joyDY > 14) || keys.s; 
        isNitro = nitroReq && nitro > 0;
        brakeActive = brakeReq;
        
        // --- Nitro Speed set to 560 & Burn Rate set to 0.24 ---
        if(isNitro) { targetSpeed = SPEED_NITRO; nitro -= 0.24; if(nitro < 0) nitro = 0; screenShake = Math.max(screenShake, 2.0); }
        else if (brakeReq) targetSpeed = SPEED_BRAKE; else targetSpeed = SPEED_CRUISE; 

        /* a crash stops the car dead: no throttle, no nitro burn, 0 KMH on the
           clock for CRASH_STUN frames, then it accelerates away again */
        if(crashStun > 0) { crashStun--; isNitro = false; targetSpeed = 0; }

        speed += (targetSpeed - speed) * 0.08;
        score += (speed * 0.015);
        roadOffset += (speed * 0.08);

        if(engineOsc) engineOsc.frequency.setValueAtTime(40 + (speed/200)*140, audioCtx.currentTime);

        document.getElementById('score-txt').innerText = String(Math.floor(score)).padStart(5, '0');
        document.getElementById('speed-txt').innerText = `${Math.floor(speed)} KMH`;
        document.getElementById('nitro-bar-fill').style.width = `${nitro}%`;
        document.getElementById('nitro-percent-txt').innerText = `${Math.floor(nitro)}%`;

        if(isMultiplayer && Date.now() - lastSyncTime > 100) {
            database.ref('car_rooms/' + currentRoom + '/players/' + myId).update({
                x: player.x,
                score: score
            });
            lastSyncTime = Date.now();
        }
    } else {
        speed += (0 - speed) * 0.1;
        roadOffset += (speed * 0.08);
        brakeActive = false;
    }

    if(world) {
        world.scrollRoad(roadOffset);
        world.addShake(screenShake);
    }

    /* ---- bullets: travel forward, kill traffic on contact ---- */
    for(let i = activeBullets.length - 1; i >= 0; i--) {
        let b = activeBullets[i]; b.y -= 18; let killed = false;
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
        particles[i].update();
        if(particles[i].alpha <= 0) particles.splice(i,1);
    }
    if(world) world.syncParticles(particles);

    if(gameActive && Math.random() < 0.015 && stars.length < 2) stars.push(new Star());   // stars share the far spawn
    for(let i = stars.length - 1; i >= 0; i--) {
        stars[i].update();
        if(gameActive && player && Math.abs(player.x + player.w/2 - stars[i].x) < player.w/2 + stars[i].r && Math.abs(player.y + player.h/2 - stars[i].y) < player.h/2 + stars[i].r) {
            nitro = Math.min(100, nitro + 20); bullets++; updateAmmoUI(); score += 150; playSfx(900, 'sine', 0.25, 0.3);
            for(let k=0; k<15; k++) particles.push(new Particle(stars[i].x, stars[i].y, '#ffea00', (Math.random()-0.5)*8, Math.random()*4+2));
            stars.splice(i, 1); continue;
        }
        if(stars[i].y > gameHeight + 100) stars.splice(i, 1);
    }
    if(world) world.syncStars(stars, roadOffset);

    if(gameActive && Math.random() < 0.075 && enemies.length < MAX_ENEMIES && canSpawn(enemies)) enemies.push(new Enemy());
    for(let i = enemies.length - 1; i >= 0; i--) {
        enemies[i].update();
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
        ghostTimer--;
        const period = ghostTimer < 60 ? 4 : 6;             // blinks faster as it runs out
        playerHidden = Math.floor(ghostTimer / period) % 2 === 1;
        if(ghostTimer % 15 === 0) updateSkillUI();
        if(ghostTimer <= 0) { ghostActive = false; playerHidden = false; updateSkillUI(); }
    }

    if(player) {
        if(gameActive) player.update();
        player.draw(playerHidden);
    }

    if (screenFlash > 0) {
        flashEl.style.opacity = screenFlash;
        screenFlash -= 0.05;
    } else if (flashEl.style.opacity !== '0') {
        flashEl.style.opacity = '0';
    }

    if(world) world.render();
    requestAnimationFrame(render);
}

const flashEl = document.getElementById('flash');

/* the lobby buttons are wired with onclick="" in index.html, so the handlers
   have to live on window now that this file is an ES module */
Object.assign(window, {
    createRoom, joinRoom, playSolo, sendChatMessage, startMultiplayerGame, backToLobby,
    useGhost, useNuke, shootBullet, findRandomGame, cancelSearch
});

player = new Player();
requestAnimationFrame(render);
