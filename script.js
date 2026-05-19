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

// --- MULTIPLAYER VARIABLES ---
let myId = Math.random().toString(36).substr(2, 9);
let myName = "";
let currentRoom = null;
let isHost = false;
let opponentsData = {};
let lastSyncTime = 0;
let isMultiplayer = false;

// --- GAME VARIABLES ---
const canvas = document.getElementById('canvas');
const ctx = canvas.getContext('2d');
const gameWidth = 480;
const gameHeight = 850;
canvas.width = gameWidth;
canvas.height = gameHeight;

let gameActive = false;
let score = 0, speed = 0, targetSpeed = 0;
let nitro = 0, bullets = 0; 
let isNitro = false;
let screenShake = 0, roadOffset = 0, screenFlash = 0; 
let player;
let enemies = [], stars = [], activeBullets = [], particles = [];

// UI Elements
const hud = document.getElementById('hud');
const btnLeft = document.getElementById('shoot-btn-left');
const btnRight = document.getElementById('shoot-btn-right');
const joyContainer = document.getElementById('joystick-container');
const joyKnob = document.getElementById('joystick-knob');

let joyActive = false, joyTouchId = null, joyStartX = 0, joyStartY = 0;
let joyDX = 0, joyDY = 0;
const maxRange = 55; 
let lastTapTime = 0; 
let audioCtx, engineOsc, engineGain;

// --- MULTIPLAYER LOGIC ---
function createRoom() {
    myName = document.getElementById('player-name').value.trim();
    if(!myName) return alert("Enter your name!");
    
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
    myName = document.getElementById('player-name').value.trim();
    currentRoom = document.getElementById('room-code-input').value.trim();
    if(!myName || !currentRoom) return alert("Enter Name and Room Code!");
    isMultiplayer = true;

    database.ref('car_rooms/' + currentRoom).once('value', snapshot => {
        if(!snapshot.exists()) return alert("Room not found!");
        if(snapshot.val().status !== "waiting") return alert("Game already running!");
        
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
            const list = document.getElementById('players-list');
            list.innerHTML = "";
            Object.keys(data.players).forEach(pid => {
                let li = document.createElement('li');
                li.innerText = "🏎️ " + data.players[pid].name + (pid === data.hostId ? " (Host)" : "");
                list.appendChild(li);
            });
        } 
        else if (data.status === "playing" && !gameActive) {
            initGameAndFullscreen();
        }
        
        if(data.players) {
            opponentsData = data.players;
        }
    });
}

function startMultiplayerGame() {
    database.ref('car_rooms/' + currentRoom).update({ status: "playing" });
}

function playSolo() {
    isMultiplayer = false;
    initGameAndFullscreen();
}

// --- GAME SYSTEM ---
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
        this.x += this.vx; this.angle = this.vx * 0.04;
        if(this.x < 22) { this.x = 22; this.vx = 0; }
        if(this.x > gameWidth - 22 - this.w) { this.x = gameWidth - 22 - this.w; this.vx = 0; }
        if(speed > 40 && Math.random() < 0.6) particles.push(new Particle(this.x + this.w/2, this.y + this.h, isNitro ? '#00f0ff' : '#ff0055', -speed*0.03, Math.random()*4+1));
    }
    draw() {
        ctx.save(); ctx.translate(this.x + this.w/2, this.y + this.h/2); ctx.rotate(this.angle);
        ctx.shadowBlur = 20; ctx.shadowColor = isNitro ? '#00f0ff' : '#ff0055';
        ctx.fillStyle = '#0a0a18'; ctx.strokeStyle = isNitro ? '#00f0ff' : '#ff0055'; ctx.lineWidth = 3;
        ctx.beginPath(); ctx.rect(-this.w/2, -this.h/2, this.w, this.h); ctx.fill(); ctx.stroke();
        ctx.shadowBlur = 0; ctx.fillStyle = '#1a1a3a'; ctx.strokeStyle = '#8da1d6';
        ctx.beginPath(); ctx.rect(-this.w/3, -this.h/6, (this.w/3)*2, this.h/2.5); ctx.fill(); ctx.stroke(); ctx.restore();
    }
}

class Enemy {
    constructor() {
        this.w = 44; this.h = 85;
        const lanes = [40, 140, 240, 340, 410];
        this.x = lanes[Math.floor(Math.random() * lanes.length)] + (Math.random()*8 - 4);
        this.y = -250; this.vShift = Math.random() * 3 + 2; 
        this.color = ['#a200ff', '#00ff66', '#ff8800', '#ff00aa'][Math.floor(Math.random() * 4)];
    }
    update() { this.y += this.vShift + (speed * 0.08); }
    draw() {
        ctx.save(); ctx.shadowBlur = 15; ctx.shadowColor = this.color;
        ctx.fillStyle = '#050510'; ctx.strokeStyle = this.color; ctx.lineWidth = 2.5;
        ctx.beginPath(); ctx.rect(this.x, this.y, this.w, this.h); ctx.fill(); ctx.stroke(); ctx.restore();
    }
}

class Star {
    constructor() {
        this.r = 18; const lanes = [50, 150, 250, 350, 420];
        this.x = lanes[Math.floor(Math.random() * lanes.length)]; this.y = -250; this.rot = 0;
    }
    update() { this.y += speed * 0.08; this.rot += 0.05; }
    draw() {
        ctx.save(); ctx.translate(this.x, this.y); ctx.rotate(this.rot);
        ctx.shadowBlur = 20; ctx.shadowColor = '#ffea00'; ctx.fillStyle = '#ffea00';
        ctx.beginPath();
        for (let i = 0; i < 5; i++) {
            ctx.lineTo(Math.cos((18 + i * 72) * Math.PI / 180) * this.r, -Math.sin((18 + i * 72) * Math.PI / 180) * this.r);
            ctx.lineTo(Math.cos((54 + i * 72) * Math.PI / 180) * (this.r/2), -Math.sin((54 + i * 72) * Math.PI / 180) * (this.r/2));
        }
        ctx.closePath(); ctx.fill(); ctx.restore();
    }
}

class Particle {
    constructor(x, y, color, vy, size) {
        this.x = x; this.y = y; this.color = color;
        this.vx = Math.random() * 4 - 2; this.vy = vy; this.alpha = 1; this.size = size;
    }
    update() { this.x += this.vx; this.y += this.vy; this.alpha -= 0.05; }
    draw() {
        ctx.save(); ctx.globalAlpha = this.alpha; ctx.fillStyle = this.color;
        ctx.beginPath(); ctx.arc(this.x, this.y, this.size, 0, Math.PI*2); ctx.fill(); ctx.restore();
    }
}

function restartGame() {
    player = new Player();
    enemies = []; stars = []; particles = []; activeBullets = [];
    score = 0; speed = 0; nitro = 0; bullets = 0;
    gameActive = true; joyActive = false; joyTouchId = null; screenFlash = 0;
    joyContainer.style.display = 'none'; updateAmmoUI();
    document.getElementById('gameover-screen').classList.add('hidden');
}

function triggerCrash() {
    gameActive = false; screenShake = 30;
    playSfx(120, 'sawtooth', 0.8, 0.4);
    if(engineGain) engineGain.gain.setValueAtTime(0, audioCtx.currentTime);
    document.getElementById('final-score-lbl').innerText = `FINAL SCORE: ${Math.floor(score)}`;
    document.getElementById('gameover-screen').classList.remove('hidden');
    hud.style.display = 'none';
}

function drawOpponents() {
    if(!isMultiplayer || !opponentsData) return;
    for(let id in opponentsData) {
        if(id === myId) continue; 
        let opp = opponentsData[id];
        let drawY = player.y - (opp.score - score) * 3;
        
        if(drawY > -300 && drawY < gameHeight + 100) {
            ctx.save();
            ctx.translate(opp.x + 22, drawY + 42.5); 
            ctx.globalAlpha = 0.5;
            ctx.shadowBlur = 20; ctx.shadowColor = opp.color || '#a200ff';
            ctx.fillStyle = '#0a0a18'; ctx.strokeStyle = opp.color || '#a200ff'; ctx.lineWidth = 3;
            ctx.beginPath(); ctx.rect(-22, -42.5, 44, 85); ctx.fill(); ctx.stroke();
            
            ctx.globalAlpha = 0.8;
            ctx.shadowBlur = 0; ctx.fillStyle = '#fff'; ctx.font = 'bold 12px sans-serif';
            ctx.textAlign = 'center';
            ctx.fillText(opp.name, 0, -50);
            ctx.restore();
        }
    }
}

function render() {
    ctx.clearRect(0,0, gameWidth, gameHeight);
    ctx.save();

    if(screenShake > 0) {
        ctx.translate((Math.random()-0.5)*screenShake, (Math.random()-0.5)*screenShake);
        screenShake *= 0.9; if(screenShake < 0.5) screenShake = 0;
    }

    if(gameActive) {
        let nitroReq = (joyActive && joyDY < -14) || keys.w;
        let brakeReq = (joyActive && joyDY > 14) || keys.s; 
        isNitro = nitroReq && nitro > 0;
        
        if(isNitro) { targetSpeed = 270; nitro -= 0.12; if(nitro < 0) nitro = 0; screenShake = Math.max(screenShake, 2.0); }
        else if (brakeReq) targetSpeed = 60; else targetSpeed = 130; 

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
    }

    ctx.fillStyle = '#020206'; ctx.fillRect(0, 0, gameWidth, gameHeight);
    ctx.fillStyle = '#060612'; ctx.fillRect(20, 0, gameWidth - 40, gameHeight); 
    ctx.shadowBlur = 15; ctx.shadowColor = '#00f0ff'; ctx.fillStyle = '#00f0ff'; ctx.fillRect(18, 0, 4, gameHeight);
    ctx.shadowColor = '#ff0055'; ctx.fillStyle = '#ff0055'; ctx.fillRect(gameWidth - 22, 0, 4, gameHeight);
    ctx.shadowBlur = 0;
    ctx.fillStyle = 'rgba(255, 255, 255, 0.15)';
    let lineY = roadOffset % 80;
    for(let y = -80; y < gameHeight; y += 80) {
        ctx.fillRect(gameWidth * 0.25, y + lineY, 2, 40);
        ctx.fillRect(gameWidth * 0.5 - 2, y + lineY, 4, 40);
        ctx.fillRect(gameWidth * 0.75, y + lineY, 2, 40);
    }

    ctx.save();
    ctx.fillStyle = '#ffea00'; ctx.shadowBlur = 15; ctx.shadowColor = '#ffea00';
    for(let i = activeBullets.length - 1; i >= 0; i--) {
        let b = activeBullets[i]; b.y -= 18; ctx.fillRect(b.x - b.w/2, b.y, b.w, b.h);
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
    ctx.restore();

    for(let i = particles.length - 1; i >= 0; i--) {
        particles[i].update(); particles[i].draw();
        if(particles[i].alpha <= 0) particles.splice(i,1);
    }

    if(gameActive && Math.random() < 0.015 && stars.length < 2) stars.push(new Star());
    for(let i = stars.length - 1; i >= 0; i--) {
        stars[i].update(); stars[i].draw();
        if(gameActive && player && Math.abs(player.x + player.w/2 - stars[i].x) < player.w/2 + stars[i].r && Math.abs(player.y + player.h/2 - stars[i].y) < player.h/2 + stars[i].r) {
            nitro = Math.min(100, nitro + 20); bullets++; updateAmmoUI(); score += 150; playSfx(900, 'sine', 0.25, 0.3);
            for(let k=0; k<15; k++) particles.push(new Particle(stars[i].x, stars[i].y, '#ffea00', (Math.random()-0.5)*8, Math.random()*4+2));
            stars.splice(i, 1); continue;
        }
        if(stars[i].y > gameHeight + 100) stars.splice(i, 1);
    }

    if(gameActive && Math.random() < 0.038 && enemies.length < 5) enemies.push(new Enemy());
    for(let i = enemies.length - 1; i >= 0; i--) {
        enemies[i].update(); enemies[i].draw();
        if(gameActive && player && player.x < enemies[i].x + enemies[i].w - 5 && player.x + player.w > enemies[i].x + 5 && player.y < enemies[i].y + enemies[i].h - 5 && player.y + player.h > enemies[i].y + 6) {
            for(let k=0; k<40; k++) particles.push(new Particle(player.x+player.w/2, player.y+player.h/2, '#ff5500', (Math.random()-0.5)*16, Math.random()*7+2));
            triggerCrash();
        }
        if(enemies[i].y > gameHeight + 100) { enemies.splice(i, 1); if(gameActive) score += 30; }
    }

    drawOpponents();

    if(player) {
        if(gameActive) player.update();
        player.draw();
    }

    if (screenFlash > 0) {
        ctx.fillStyle = `rgba(255, 255, 255, ${screenFlash})`;
        ctx.fillRect(0, 0, gameWidth, gameHeight); screenFlash -= 0.05;
    }

    ctx.restore();
    requestAnimationFrame(render);
}

player = new Player();
requestAnimationFrame(render);
