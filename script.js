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
let player;
let enemies = [], stars = [], activeBullets = [], particles = [];

let raceTimeLeft = 60; 
let timerInterval = null;

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
const joyContainer = document.getElementById('joystick-container');
const joyKnob = document.getElementById('joystick-knob');

let joyActive = false, joyTouchId = null, joyStartX = 0, joyStartY = 0;
let joyDX = 0, joyDY = 0, brakeActive = false;
const maxRange = 55; 
let lastTapTime = 0; 
let audioCtx, engineOsc, engineGain;

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

function listenToRoom() {
    database.ref('car_rooms/' + currentRoom).on('value', snapshot => {
        const data = snapshot.val();
        if(!data) return;

        if (data.status === "waiting") {
            // রুমে ব্যাক করার পর গেম ওভার স্ক্রিন হাইড করে ওয়েটিং স্ক্রিন চালু করা
            document.getElementById('gameover-screen').classList.add('hidden');
            document.getElementById('waiting-screen').classList.remove('hidden');
            hud.style.display = 'none';
            btnLeft.style.display = 'none';
            btnRight.style.display = 'none';

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
            initGameAndFullscreen();
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
    hud.style.display = 'block';
    btnLeft.style.display = 'flex';
    btnRight.style.display = 'flex';
    restartGame();
}

function setupAudio() {
    if(audioCtx) return;
    audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    engineOsc = audioCtx.createOscillator();
    engineGain = audioCtx.createGain();
    engineOsc.type = 'sawtooth';
    engineOsc.frequency.setValueAtTime(40, audioCtx.currentTime);
    
    let filter = audioCtx.createBiquadFilter();
    filter.type = 'lowpass'; filter.frequency.setValueAtTime(180, audioCtx.currentTime);
    engineOsc.connect(filter); filter.connect(engineGain); engineGain.connect(audioCtx.destination);
    engineGain.gain.setValueAtTime(0.015, audioCtx.currentTime); engineOsc.start(0);
}

function playSfx(freq, type, dur, vol) {
    if(!audioCtx) return;
    let osc = audioCtx.createOscillator(); let gain = audioCtx.createGain();
    osc.type = type; osc.frequency.setValueAtTime(freq, audioCtx.currentTime);
    gain.gain.setValueAtTime(vol, audioCtx.currentTime); gain.gain.exponentialRampToValueAtTime(0.01, audioCtx.currentTime + dur);
    osc.connect(gain); gain.connect(audioCtx.destination); osc.start(); osc.stop(audioCtx.currentTime + dur);
}

const gameContainer = document.getElementById('game-container');
gameContainer.addEventListener('touchstart', (e) => {
    if (!gameActive) return;
    if (e.target.closest('.shoot-btn') || e.target.closest('.overlay')) return;

    let currentTime = new Date().getTime();
    let tapLength = currentTime - lastTapTime;
    
    if (tapLength < 300 && tapLength > 0 && bullets >= 10) {
        bullets -= 10; updateAmmoUI();
        enemies.forEach(en => {
            for(let k=0; k<25; k++) particles.push(new Particle(en.x + en.w/2, en.y + en.h/2, '#ff0055', (Math.random()-0.5)*12, Math.random()*5+2));
            score += 100;
        });
        enemies = []; playSfx(150, 'square', 0.6, 0.6); screenShake = 30; screenFlash = 1.0; lastTapTime = 0; e.preventDefault(); return; 
    }
    lastTapTime = currentTime;

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

btnLeft.addEventListener('touchstart', (e) => { shootBullet(); e.preventDefault(); e.stopPropagation(); });
btnRight.addEventListener('touchstart', (e) => { shootBullet(); e.preventDefault(); e.stopPropagation(); });

function shootBullet() {
    if(!gameActive || bullets <= 0) return;
    bullets--; playSfx(600, 'triangle', 0.15, 0.3);
    activeBullets.push({ x: player.x + player.w / 2, y: player.y, w: 6, h: 22 });
    updateAmmoUI();
}

function updateAmmoUI() {
    document.querySelectorAll('.ammo-count').forEach(c => c.innerText = `${bullets} BULLETS`);
    document.querySelectorAll('.shoot-btn').forEach(b => bullets <= 0 ? b.classList.add('empty') : b.classList.remove('empty'));
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
    draw() {
        if(!world) return;
        world.setPlayer(wx(this.x + this.w / 2), wz(this.y + this.h / 2), {
            steer: Math.max(-1, Math.min(1, this.vx / 9)),
            brake: brakeActive ? 1 : 0,
            boost: isNitro ? 1 : 0,
            phase: roadOffset
        });
    }
}

class Enemy {
    constructor() {
        this.w = 44; this.h = 85;
        const lanes = [40, 140, 240, 340, 410];
        this.x = lanes[Math.floor(Math.random() * lanes.length)] + (Math.random()*8 - 4);
        this.y = -250; this.vShift = Math.random() * 3 + 2; 
        this.color = ['#a200ff', '#00ff66', '#ff8800', '#ff00aa'][Math.floor(Math.random() * 4)];
        /* body shape + a personal animation offset so no two cars move alike */
        const shapes = ['sedan', 'coupe', 'van', 'sedan', 'coupe'];
        this.style = shapes[Math.floor(Math.random() * shapes.length)];
        this.phaseOff = Math.random() * 400;
    }
    update() { this.y += this.vShift + (speed * 0.08); }
    /* world-space position + the bits the 3D renderer needs */
    get wx() { return wx(this.x + this.w / 2); }
    get wz() { return wz(this.y + this.h / 2); }
    get steer() { return Math.sin((roadOffset + this.phaseOff) * 0.012) * 0.16; }
    get phase() { return roadOffset + this.phaseOff; }
}

class Star {
    constructor() {
        this.r = 18; const lanes = [50, 150, 250, 350, 420];
        this.x = lanes[Math.floor(Math.random() * lanes.length)]; this.y = -250; this.rot = 0;
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
    player = new Player();
    enemies = []; stars = []; particles = []; activeBullets = [];
    score = 0; speed = 0; nitro = 0; bullets = 0;
    raceTimeLeft = 60; 
    gameActive = true; joyActive = false; joyTouchId = null; screenFlash = 0;
    joyContainer.style.display = 'none'; updateAmmoUI();
    document.getElementById('gameover-screen').classList.add('hidden');
    document.getElementById('leaderboard-box').style.display = 'none';

    if(timerInterval) clearInterval(timerInterval);
    timerInterval = setInterval(() => {
        if(gameActive) {
            raceTimeLeft--;
            document.getElementById('timer-txt').innerText = `${raceTimeLeft}s`;
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
    
    if(isMultiplayer && isHost) {
        database.ref('car_rooms/' + currentRoom).update({ status: "finished" });
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
    hud.style.display = 'none';
}

// --- NEW FUNCTION: BACK TO LOBBY (WITHOUT DISCONNECTING) ---
function backToLobby() {
    if(isMultiplayer) {
        // হোস্ট ক্লিক করলে পুরো রুমের স্ট্যাটাসই "waiting" এ চলে যাবে এবং বাকিরা রিয়েল-টাইম লবিতে ফেরত যাবে
        if(isHost) {
            database.ref('car_rooms/' + currentRoom).update({ status: "waiting" });
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
                style: ['sports', 'sedan', 'coupe'][(id.charCodeAt(0) + id.length) % 3],
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
        if(isNitro) { targetSpeed = 560; nitro -= 0.24; if(nitro < 0) nitro = 0; screenShake = Math.max(screenShake, 2.0); }
        else if (brakeReq) targetSpeed = 100; else targetSpeed = 210; 

        speed += (targetSpeed - speed) * 0.08;
        score += (speed * 0.015);
        roadOffset += (speed * 0.08);

        if(engineOsc) engineOsc.frequency.setValueAtTime(40 + (speed/270)*140, audioCtx.currentTime);

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
        let b = activeBullets[i]; b.y -= 18;
        for(let j = enemies.length - 1; j >= 0; j--) {
            let e = enemies[j];
            if(b.x > e.x && b.x < e.x + e.w && b.y > e.y && b.y < e.y + e.h) {
                for(let k=0; k<25; k++) particles.push(new Particle(e.x + e.w/2, e.y + e.h/2, '#ff0055', (Math.random()-0.5)*12, Math.random()*5+2));
                playSfx(300, 'sawtooth', 0.2, 0.25);
                enemies.splice(j, 1); activeBullets.splice(i, 1); score += 100; break;
            }
        }
        if(b && b.y < -50) activeBullets.splice(i, 1);
    }
    if(world) world.syncBullets(activeBullets);

    for(let i = particles.length - 1; i >= 0; i--) {
        particles[i].update();
        if(particles[i].alpha <= 0) particles.splice(i,1);
    }
    if(world) world.syncParticles(particles);

    if(gameActive && Math.random() < 0.015 && stars.length < 2) stars.push(new Star());
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

    if(gameActive && Math.random() < 0.038 && enemies.length < 5) enemies.push(new Enemy());
    for(let i = enemies.length - 1; i >= 0; i--) {
        enemies[i].update();
        if(gameActive && player && player.x < enemies[i].x + enemies[i].w - 5 && player.x + player.w > enemies[i].x + 5 && player.y < enemies[i].y + enemies[i].h - 5 && player.y + player.h > enemies[i].y + 6) {
            triggerCrash();
            enemies.splice(i, 1); continue;
        }
        if(enemies[i].y > gameHeight + 100) { enemies.splice(i, 1); if(gameActive) score += 30; }
    }
    if(world) world.syncEnemies(enemies, speed, player ? wz(player.y + player.h / 2) : 0);

    syncOpponents();

    if(player) {
        if(gameActive) player.update();
        player.draw();
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
    createRoom, joinRoom, playSolo, sendChatMessage, startMultiplayerGame, backToLobby
});

player = new Player();
requestAnimationFrame(render);
