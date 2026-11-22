const express = require('express');
const http = require('http');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' }, pingTimeout: 20000, pingInterval: 10000 });
app.use(express.static(path.join(__dirname, 'public')));

// ==== CONSTANTS & BALANCE ====
const PLAYER_R = 30, BALL_R = 20;
const PLAYER_MAX = 390, DASH_IMPULSE = 660;
const PLAYER_ACCEL = 1350;
const FRICTION = 0.965, BOUNCE = 0.78;
const KICK_MAX = 980, PASS_MAX = 660, LOB_MAX = 820, FINESSE_MAX = 860;
const DASH_CD = 1.7, TACKLE_CD = 1.8;
const DRIBBLE_DIST = PLAYER_R + BALL_R + 3;
const SERVER_TICK = 60, SYNC_RATE = 30, MAX_PLAYERS = 6;

const ARENAS = {
  classic:   { w: 1800, h: 1100, obstacles: [] },
  ice:       { w: 1800, h: 1100, obstacles: [] },
  obstacles: { w: 1900, h: 1200, obstacles: [[-300, -200, 100, 60], [300, 200, 100, 60], [0, 0, 80, 80]] },
  narrow:    { w: 2400, h: 800, obstacles: [] }
};
const MODES = {
  classic: { goals: 5 },
  time:    { duration: 120 },
  golden:  { goals: 1 },
  chaos:   { goals: 5 },
  penalty: { goals: 5 }
};
const WEATHERS = { clear: 1, rain: 0.94, night: 1, fog: 1 };
const CELEBRATIONS = ['slide', 'spin', 'jump', 'flex'];

// Skin prices: Common = 500, Rare = 1000, Epic = 2000, Legendary = 4000
const PLAYER_SKIN_CATALOG = {
  plain: { price: 0, rarity: 'common' },
  star:  { price: 500, rarity: 'common' },
  fire:  { price: 1000, rarity: 'rare' },
  ice:   { price: 2000, rarity: 'epic' },
  metal: { price: 4000, rarity: 'legendary' }
};
const BALL_SKIN_CATALOG = {
  classic: { price: 0, rarity: 'common' },
  beach:   { price: 500, rarity: 'common' },
  fire:    { price: 1000, rarity: 'rare' },
  ice:     { price: 1000, rarity: 'rare' },
  neon:    { price: 2000, rarity: 'epic' },
  star:    { price: 4000, rarity: 'legendary' }
};
const COMMON_PLAYER_SKINS = ['star'];
const COMMON_BALL_SKINS = ['beach'];

// ==== PERSISTENT DATA STORE (ACCOUNTS, PROMOS, ADMIN LOGS) ====
const DATA_FILE = path.join(__dirname, 'ball_brawl_data.json');
const ADMIN_SECRET_HASH = crypto.createHash('sha256').update('Srm7vAd').digest('hex');

const DEFAULT_PROMOS = {
  'BALL2026':   { type: 'coins', value: 50, maxUses: 100000, usedCount: 0, active: true },
  'WELCOME':    { type: 'coins', value: 30, maxUses: 100000, usedCount: 0, active: true },
  'GOALMASTER': { type: 'coins', value: 75, maxUses: 100000, usedCount: 0, active: true },
  'FOOTBALL':   { type: 'coins', value: 100, maxUses: 100000, usedCount: 0, active: true },
  'FREESKIN':   { type: 'common_skin', value: 1, maxUses: 100000, usedCount: 0, active: true }
};

let db = {
  accounts: {},
  promos: JSON.parse(JSON.stringify(DEFAULT_PROMOS)),
  adminLogs: [],
  claimedMatchAwards: {}
};

function loadDB() {
  try {
    if (fs.existsSync(DATA_FILE)) {
      const parsed = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
      db.accounts = parsed.accounts || {};
      db.promos = Object.assign(JSON.parse(JSON.stringify(DEFAULT_PROMOS)), parsed.promos || {});
      db.adminLogs = Array.isArray(parsed.adminLogs) ? parsed.adminLogs.slice(-500) : [];
      db.claimedMatchAwards = parsed.claimedMatchAwards || {};
    }
  } catch (e) {
    console.error('DB load error:', e.message);
  }
}

let saveTimer = null;
function scheduleSaveDB() {
  if (saveTimer) return;
  saveTimer = setTimeout(() => {
    saveTimer = null;
    try {
      const keys = Object.keys(db.claimedMatchAwards);
      if (keys.length > 2000) {
        keys.slice(0, keys.length - 1500).forEach(k => delete db.claimedMatchAwards[k]);
      }
      fs.writeFileSync(DATA_FILE, JSON.stringify(db, null, 2), 'utf8');
    } catch (e) {
      console.error('DB save error:', e.message);
    }
  }, 400);
}
loadDB();

function todayStr() {
  const d = new Date();
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`;
}

function getOrCreateAccount(accountId, nick) {
  let cleanId = String(accountId || '').replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 40);
  if (!cleanId) cleanId = 'acc_' + crypto.randomBytes(6).toString('hex');
  if (!db.accounts[cleanId]) {
    db.accounts[cleanId] = {
      id: cleanId,
      nick: sanitize(nick || 'Игрок'),
      coins: 0,
      wins: 0,
      goals: 0,
      assists: 0,
      matches: 0,
      shots: 0,
      passes: 0,
      penaltyRecord: 0,
      ownedSkins: ['plain'],
      ownedBallSkins: ['classic'],
      usedPromos: [],
      daily: {
        date: todayStr(),
        loginClaimed: false,
        loginReward: 0,
        firstMatchDone: false,
        goals: 0,
        wins: 0,
        questReward: 0,
        questClaimed: false
      },
      createdAt: Date.now(),
      lastSeen: Date.now()
    };
    scheduleSaveDB();
  }
  const acc = db.accounts[cleanId];
  if (nick) acc.nick = sanitize(nick);
  acc.lastSeen = Date.now();
  const t = todayStr();
  if (!acc.daily || acc.daily.date !== t) {
    acc.daily = {
      date: t,
      loginClaimed: false,
      loginReward: 0,
      firstMatchDone: false,
      goals: 0,
      wins: 0,
      questReward: 30 + Math.floor(Math.random() * 71),
      questClaimed: false
    };
    // Daily quest reward: 75 to 150 coins
    acc.daily.questReward = 75 + Math.floor(Math.random() * 76);
    scheduleSaveDB();
  }
  if (!acc.daily.questReward || acc.daily.questReward < 75 || acc.daily.questReward > 150) {
    acc.daily.questReward = 75 + Math.floor(Math.random() * 76);
  }
  return acc;
}

function logAdminAction(actorId, action, details) {
  db.adminLogs.push({
    ts: new Date().toISOString(),
    actorId: String(actorId || 'unknown'),
    action: String(action),
    details
  });
  if (db.adminLogs.length > 500) db.adminLogs.shift();
  scheduleSaveDB();
}

function publicAccountPayload(acc) {
  return {
    id: acc.id,
    nick: acc.nick,
    coins: acc.coins,
    wins: acc.wins,
    goals: acc.goals,
    assists: acc.assists,
    matches: acc.matches,
    shots: acc.shots,
    passes: acc.passes,
    penaltyRecord: acc.penaltyRecord,
    ownedSkins: acc.ownedSkins,
    ownedBallSkins: acc.ownedBallSkins,
    daily: acc.daily
  };
}

// ==== HELPERS ====
const rooms = {};
const adminSessions = new Set();

function genRoomId() {
  const id = 'M_' + crypto.randomBytes(4).toString('hex').toUpperCase();
  return rooms[id] ? genRoomId() : id;
}
function sanitize(s, d = 'Игрок') { return String(s || d).replace(/[<>]/g, '').slice(0, 14); }
function sanitizeNum(n) { const v = parseInt(n, 10); return isNaN(v) ? 0 : Math.max(0, Math.min(99, v)); }
function sanitizeColor(c) { return /^#[0-9a-fA-F]{6}$/.test(c) ? c : '#ff3366'; }

function assignTeams(room) {
  const players = Object.values(room.players);
  const r = players.filter(p => p.team === 'red').length;
  const b = players.filter(p => p.team === 'blue').length;
  if (r + b >= 4) return 'spec';
  return r <= b ? 'red' : 'blue';
}

function arenaBounds(room) {
  const a = ARENAS[room.settings.arena] || ARENAS.classic;
  return {
    minX: -a.w / 2, maxX: a.w / 2,
    minY: -a.h / 2, maxY: a.h / 2,
    w: a.w, h: a.h,
    obstacles: a.obstacles || []
  };
}

function createPlayerState(base) {
  return {
    ...base,
    x: 0, y: 0, vx: 0, vy: 0, facing: 0,
    stamina: 100,
    dashCd: 0, tackleCd: 0, dashTimer: 0, pickupLock: 0,
    ready: false,
    stats: { goals: 0, assists: 0, shots: 0, passes: 0, tackles: 0, saves: 0 }
  };
}

function resetPositions(room) {
  const ids = Object.keys(room.players);
  const reds = ids.filter(id => room.players[id].team === 'red');
  const blues = ids.filter(id => room.players[id].team === 'blue');
  const bd = arenaBounds(room);

  reds.forEach((id, i) => {
    const p = room.players[id];
    const spread = reds.length === 1 ? 0 : (i - (reds.length - 1) / 2) * 90;
    p.x = bd.minX + 160; p.y = spread; p.vx = 0; p.vy = 0; p.facing = 0;
    p.pickupLock = 0; p.dashTimer = 0; p.stamina = Math.max(p.stamina || 100, 65);
  });
  blues.forEach((id, i) => {
    const p = room.players[id];
    const spread = blues.length === 1 ? 0 : (i - (blues.length - 1) / 2) * 90;
    p.x = bd.maxX - 160; p.y = spread; p.vx = 0; p.vy = 0; p.facing = Math.PI;
    p.pickupLock = 0; p.dashTimer = 0; p.stamina = Math.max(p.stamina || 100, 65);
  });

  const mkBall = (x, y) => ({
    x, y, prevX: x, prevY: y,
    vx: 0, vy: 0, z: 0, vz: 0,
    curve: 0, powerGlow: 0, shotType: 'normal',
    ownerId: null, lastTeam: null, scored: false
  });

  room.balls = [mkBall(0, 0)];
  if (room.settings.mode === 'chaos') {
    room.balls.push(mkBall(0, -210));
    room.balls.push(mkBall(0, 210));
  }
  if (room.settings.mode === 'penalty') {
    room.balls = [mkBall(-bd.w / 2 + 320, 0)];
  }
  room.lastToucher = null;
  room.prevToucher = null;
  room.goalLockUntil = 0;
  room.combo = { red: 0, blue: 0 };
}

function getPlayersPublic(room) {
  return Object.entries(room.players).map(([id, p]) => ({
    id, accountId: p.accountId, name: p.name, color: p.color, team: p.team,
    number: p.number, skin: p.skin, ready: Boolean(p.ready),
    celebration: p.celebration || 'jump',
    stats: p.stats || { goals: 0, assists: 0, shots: 0, passes: 0, tackles: 0, saves: 0 }
  }));
}

function recordTouch(room, playerId) {
  if (!playerId || !room.players[playerId]) return;
  if (room.lastToucher && room.lastToucher !== playerId) {
    const prevP = room.players[room.lastToucher];
    const curP = room.players[playerId];
    if (prevP && curP && prevP.team === curP.team) {
      room.prevToucher = room.lastToucher;
    } else {
      room.prevToucher = null;
    }
  }
  room.lastToucher = playerId;
}

function applyShot(room, p, playerId, b, kind, dirX, dirY, powerLevel, curveSign = 0) {
  b.ownerId = null;
  b.scored = false;
  p.pickupLock = 0.22;

  const speedBonus = 1 + Math.min(0.28, Math.hypot(p.vx, p.vy) / 800);
  const isOvercharged = kind === 'kick' && powerLevel >= 0.88;
  const maxImp = kind === 'lob' ? LOB_MAX : (kind === 'finesse' ? FINESSE_MAX : (kind === 'kick' ? KICK_MAX : PASS_MAX));
  const imp = maxImp * powerLevel * speedBonus * (isOvercharged ? 1.08 : 1);

  let dx = dirX, dy = dirY;
  const inp = room.inputs[playerId] || { x: 0, y: 0 };
  if (Math.hypot(dx, dy) < 0.05) {
    if (Math.hypot(inp.x, inp.y) > 0.05) { dx = inp.x; dy = inp.y; }
    else { dx = Math.cos(p.facing || 0); dy = Math.sin(p.facing || 0); }
  }
  const l = Math.hypot(dx, dy) || 1;
  const nx = dx / l, ny = dy / l;
  p.facing = Math.atan2(ny, nx);

  b.prevX = b.x;
  b.prevY = b.y;
  b.x = p.x + nx * (PLAYER_R + BALL_R + 6);
  b.y = p.y + ny * (PLAYER_R + BALL_R + 6);
  b.vx = nx * imp;
  b.vy = ny * imp;
  b.vz = kind === 'lob' ? 260 * Math.max(0.5, powerLevel) : (isOvercharged ? 95 : 0);
  b.shotType = kind;

  const moveCross = nx * (inp.y || 0) - ny * (inp.x || 0);
  const effectiveCurve = curveSign !== 0 ? curveSign : moveCross;
  const spin = kind === 'finesse'
    ? (effectiveCurve !== 0 ? Math.sign(effectiveCurve) : (p.team === 'red' ? -1 : 1)) * 340 * powerLevel
    : (kind === 'kick' ? effectiveCurve * 260 * powerLevel : (kind === 'lob' ? effectiveCurve * 140 * powerLevel : effectiveCurve * 90 * powerLevel));

  b.curve = spin;
  b.powerGlow = Math.min(1, powerLevel * speedBonus * (isOvercharged ? 1.2 : 1));
  b.lastTeam = p.team;

  if (!room.stats) room.stats = { shots: { red: 0, blue: 0 }, passes: { red: 0, blue: 0 }, possTicks: { red: 0, blue: 0 }, totalTicks: 0 };
  if (p.team === 'red' || p.team === 'blue') {
    if (kind === 'kick' || kind === 'finesse' || kind === 'lob') {
      room.stats.shots[p.team]++;
      if (p.stats) p.stats.shots++;
    }
    if (kind === 'pass' || kind === 'lob') {
      room.stats.passes[p.team]++;
      if (p.stats) p.stats.passes++;
    }
  }

  recordTouch(room, playerId);
  io.to(room.id).emit('ballImpact', { x: b.x, y: b.y, power: powerLevel, kind, overcharged: isOvercharged });
  if (imp > 660) {
    io.to(room.id).emit('screenShake', { intensity: Math.min(13, (imp - 600) / 36) });
  }
}

function resolveCircleRect(o, r, rx, ry, rw, rh, bounce) {
  const closestX = Math.max(rx - rw / 2, Math.min(o.x, rx + rw / 2));
  const closestY = Math.max(ry - rh / 2, Math.min(o.y, ry + rh / 2));
  const dx = o.x - closestX, dy = o.y - closestY;
  const d = Math.hypot(dx, dy);
  if (d < r) {
    const nx = d > 0.001 ? dx / d : 0;
    const ny = d > 0.001 ? dy / d : -1;
    o.x = closestX + nx * (r + 0.5);
    o.y = closestY + ny * (r + 0.5);
    const vn = o.vx * nx + o.vy * ny;
    if (vn < 0) {
      o.vx -= (1 + bounce) * vn * nx;
      o.vy -= (1 + bounce) * vn * ny;
    }
  }
}

// Accurate swept line-intersection goal check so fast shots/passes/deflections never miss
function checkGoalSegment(b, minX, maxX, goalHalfH) {
  const inZ = (b.z || 0) <= 68;
  if (!inZ) return null;

  const yTol = goalHalfH + BALL_R * 0.35;
  const leftLine = minX;
  const rightLine = maxX;

  // Check left goal (Blue scores when ball enters left goal at x <= minX)
  if (b.x <= leftLine + BALL_R * 0.25) {
    if (b.prevX > leftLine) {
      const t = (leftLine - b.prevX) / ((b.x - b.prevX) || -1e-6);
      const crossY = b.prevY + (b.y - b.prevY) * Math.max(0, Math.min(1, t));
      if (Math.abs(crossY) <= yTol) return 'blue';
    } else if (Math.abs(b.y) <= yTol && b.x < leftLine) {
      return 'blue';
    }
  }

  // Check right goal (Red scores when ball enters right goal at x >= maxX)
  if (b.x >= rightLine - BALL_R * 0.25) {
    if (b.prevX < rightLine) {
      const t = (rightLine - b.prevX) / ((b.x - b.prevX) || 1e-6);
      const crossY = b.prevY + (b.y - b.prevY) * Math.max(0, Math.min(1, t));
      if (Math.abs(crossY) <= yTol) return 'red';
    } else if (Math.abs(b.y) <= yTol && b.x > rightLine) {
      return 'red';
    }
  }
  return null;
}

function checkAllPlayersReady(room) {
  const players = Object.values(room.players);
  const active = players.filter(p => p.team !== 'spec');
  if (active.length < 2) return false;
  return players.every(p => p.ready === true);
}

function triggerMatchStartSequence(room) {
  if (room.started || room.countingDown) return;
  if (!checkAllPlayersReady(room)) return;
  room.countingDown = true;
  io.to(room.id).emit('countdown', { seconds: 3 });

  room.countdownTimer = setTimeout(() => {
    room.countingDown = false;
    if (!rooms[room.id]) return;
    if (!checkAllPlayersReady(room)) {
      io.to(room.id).emit('countdownCancelled', { reason: 'Один из игроков изменил ориентацию экрана' });
      io.to(room.id).emit('lobbyUpdate', { players: getPlayersPublic(room), host: room.host, settings: room.settings });
      return;
    }
    room.started = true;
    room.matchUid = 'OM_' + crypto.randomBytes(6).toString('hex');
    io.to(room.id).emit('gameStarted', { players: getPlayersPublic(room), settings: room.settings, matchUid: room.matchUid });
    startRoomLoop(room.id);
  }, 3100);
}

function startRoomLoop(roomId) {
  const room = rooms[roomId];
  if (!room || room.loop) return;
  room.id = roomId;
  room.loopRunning = true;
  room.lastTick = Date.now();
  room.syncTick = 0;
  room.score = { red: 0, blue: 0 };
  room.goalSeq = 0;
  room.goalLockUntil = 0;
  room.stats = { shots: { red: 0, blue: 0 }, passes: { red: 0, blue: 0 }, possTicks: { red: 0, blue: 0 }, totalTicks: 0 };
  for (const id in room.players) {
    room.players[id].stats = { goals: 0, assists: 0, shots: 0, passes: 0, tackles: 0, saves: 0 };
    room.players[id].stamina = 100;
  }
  room.startTime = Date.now();
  room.mode = room.settings.mode || 'classic';
  room.timeLeft = room.mode === 'time' ? (Number(room.settings.matchDuration) || MODES.time.duration) : 0;
  resetPositions(room);

  room.loop = setInterval(() => {
    const now = Date.now();
    let dt = (now - room.lastTick) / 1000;
    room.lastTick = now;
    if (dt > 0.05) dt = 0.05;
    if (dt <= 0) return;

    const bd = arenaBounds(room);
    const iceFriction = room.settings.arena === 'ice' ? 0.996 : FRICTION;
    const weatherFriction = WEATHERS[room.settings.weather] || 1;

    if (room.mode === 'time') {
      room.timeLeft -= dt;
      if (room.timeLeft <= 0) { finishMatch(room, roomId); return; }
    }

    for (const id in room.players) {
      const p = room.players[id];
      if (p.team === 'spec') continue;

      const inp = room.inputs[id] || { x: 0, y: 0 };
      const moving = Math.hypot(inp.x, inp.y) > 0.06;
      if (moving) p.facing = Math.atan2(inp.y, inp.x);

      const staminaFactor = (p.stamina ?? 100) > 12 ? 1.0 : 0.78;
      if ((p.dashTimer || 0) <= 0) {
        p.vx += inp.x * PLAYER_ACCEL * staminaFactor * dt;
        p.vy += inp.y * PLAYER_ACCEL * staminaFactor * dt;
        p.stamina = Math.min(100, (p.stamina ?? 100) + (moving ? 9 : 19) * dt);
      }

      if (!moving && (p.dashTimer || 0) <= 0) {
        const f = Math.pow(iceFriction * weatherFriction, dt * 60);
        p.vx *= f; p.vy *= f;
        if (Math.hypot(p.vx, p.vy) < 6) { p.vx = 0; p.vy = 0; }
      } else if ((p.dashTimer || 0) <= 0) {
        const sp = Math.hypot(p.vx, p.vy);
        const maxSp = PLAYER_MAX * staminaFactor;
        if (sp > maxSp) {
          p.vx = p.vx / sp * maxSp;
          p.vy = p.vy / sp * maxSp;
        }
      }

      p.x += p.vx * dt; p.y += p.vy * dt;
      if (p.dashCd > 0) p.dashCd -= dt;
      if (p.dashTimer > 0) p.dashTimer -= dt;
      if (p.tackleCd > 0) p.tackleCd -= dt;
      if (p.pickupLock > 0) p.pickupLock -= dt;
    }

    const activeIds = Object.keys(room.players).filter(id => room.players[id].team !== 'spec');

    // Player-to-player collisions
    for (let i = 0; i < activeIds.length; i++) {
      for (let j = i + 1; j < activeIds.length; j++) {
        const a = room.players[activeIds[i]], c = room.players[activeIds[j]];
        const dx = c.x - a.x, dy = c.y - a.y;
        const d = Math.hypot(dx, dy);
        const md = PLAYER_R * 2;
        if (d < md && d > 0.001) {
          const nx = dx / d, ny = dy / d, ov = md - d;
          a.x -= nx * ov * 0.55; a.y -= ny * ov * 0.55;
          c.x += nx * ov * 0.55; c.y += ny * ov * 0.55;
          const relVx = c.vx - a.vx, relVy = c.vy - a.vy;
          const sepVel = relVx * nx + relVy * ny;
          if (sepVel < 0) {
            const imp = -sepVel * 0.65;
            a.vx -= nx * imp; a.vy -= ny * imp;
            c.vx += nx * imp; c.vy += ny * imp;
          }
        }
      }
    }

    function boundRect(o, r) {
      if (o.x < bd.minX + r) { o.x = bd.minX + r; o.vx = Math.abs(o.vx) * BOUNCE; }
      if (o.x > bd.maxX - r) { o.x = bd.maxX - r; o.vx = -Math.abs(o.vx) * BOUNCE; }
      if (o.y < bd.minY + r) { o.y = bd.minY + r; o.vy = Math.abs(o.vy) * BOUNCE; }
      if (o.y > bd.maxY - r) { o.y = bd.maxY - r; o.vy = -Math.abs(o.vy) * BOUNCE; }
      for (const [ox, oy, ow, oh] of bd.obstacles) {
        resolveCircleRect(o, r, ox, oy, ow, oh, BOUNCE);
      }
    }
    for (const id of activeIds) boundRect(room.players[id], PLAYER_R);

    room.stats.totalTicks++;
    const goalHalfH = (bd.h * 0.3) / 2;

    for (let bi = 0; bi < room.balls.length; bi++) {
      const b = room.balls[bi];
      if (b.scored) continue;
      b.prevX = b.x;
      b.prevY = b.y;

      if (b.ownerId && room.players[b.ownerId] && room.players[b.ownerId].team !== 'spec') {
        const owner = room.players[b.ownerId];
        const ang = owner.facing || 0;
        b.x = owner.x + Math.cos(ang) * DRIBBLE_DIST;
        b.y = owner.y + Math.sin(ang) * DRIBBLE_DIST;
        b.vx = owner.vx;
        b.vy = owner.vy;
        b.z = 0; b.vz = 0; b.shotType = 'normal';
        b.curve = 0;
        b.powerGlow = 0;
        b.lastTeam = owner.team;
        recordTouch(room, b.ownerId);
        if (owner.team === 'red' || owner.team === 'blue') room.stats.possTicks[owner.team]++;
      } else {
        b.ownerId = null;
        if (b.lastTeam === 'red' || b.lastTeam === 'blue') room.stats.possTicks[b.lastTeam] += 0.25;

        if (b.curve && Math.abs(b.curve) > 1) {
          const perpX = -b.vy, perpY = b.vx;
          const pl = Math.hypot(perpX, perpY) || 1;
          b.vx += (perpX / pl) * b.curve * dt * 1.45;
          b.vy += (perpY / pl) * b.curve * dt * 1.45;
          b.curve *= Math.pow(0.89, dt * 60);
        }
        if (b.powerGlow > 0) b.powerGlow = Math.max(0, b.powerGlow - dt * 0.75);

        if ((b.z || 0) > 0 || (b.vz || 0) !== 0) {
          b.vz = (b.vz || 0) - 640 * dt;
          b.z = Math.max(0, (b.z || 0) + b.vz * dt);
          if (b.z === 0 && b.vz < 0) {
            b.vz = Math.abs(b.vz) * 0.45;
            if (b.vz < 45) { b.vz = 0; b.shotType = 'normal'; }
          }
        }

        const bf = Math.pow(iceFriction * weatherFriction * 0.992, dt * 60);
        b.vx *= bf; b.vy *= bf;
        b.x += b.vx * dt; b.y += b.vy * dt;

        for (const [ox, oy, ow, oh] of bd.obstacles) {
          resolveCircleRect(b, BALL_R, ox, oy, ow, oh, BOUNCE);
        }

        // Check player collision / deflection / pickup
        const canPickup = (b.z || 0) < 22;
        if (canPickup) {
          for (const id of activeIds) {
            const p = room.players[id];
            const d = Math.hypot(b.x - p.x, b.y - p.y);
            if (d <= PLAYER_R + BALL_R + 5) {
              if (p.pickupLock > 0) {
                // Body deflection even during pickup lock so deflections register toucher accurately
                const nx = d > 0.001 ? (b.x - p.x) / d : 1;
                const ny = d > 0.001 ? (b.y - p.y) / d : 0;
                b.x = p.x + nx * (PLAYER_R + BALL_R + 6);
                b.y = p.y + ny * (PLAYER_R + BALL_R + 6);
                b.vx = p.vx + nx * 160;
                b.vy = p.vy + ny * 160;
                b.lastTeam = p.team;
                recordTouch(room, id);
                break;
              }
              if (b.lastTeam && b.lastTeam !== p.team && Math.hypot(b.vx, b.vy) > 420 && p.stats) {
                p.stats.saves++;
              }
              b.ownerId = id;
              b.lastTeam = p.team;
              recordTouch(room, id);
              break;
            }
          }
        }
      }

      if (b.y < bd.minY + BALL_R) { b.y = bd.minY + BALL_R; b.vy = Math.abs(b.vy) * BOUNCE; }
      if (b.y > bd.maxY - BALL_R) { b.y = bd.maxY - BALL_R; b.vy = -Math.abs(b.vy) * BOUNCE; }

      const scoringTeam = now >= (room.goalLockUntil || 0) ? checkGoalSegment(b, bd.minX, bd.maxX, goalHalfH) : null;

      if (!scoringTeam) {
        if (b.x < bd.minX + BALL_R) { b.x = bd.minX + BALL_R; b.vx = Math.abs(b.vx) * BOUNCE; }
        if (b.x > bd.maxX - BALL_R) { b.x = bd.maxX - BALL_R; b.vx = -Math.abs(b.vx) * BOUNCE; }
        continue;
      }

      // Register single deduplicated goal
      b.scored = true;
      room.goalLockUntil = now + 700;
      room.goalSeq = (room.goalSeq || 0) + 1;

      const toucherId = room.lastToucher;
      const toucher = toucherId ? room.players[toucherId] : null;
      const isOwnGoal = Boolean(toucher && toucher.team !== scoringTeam);

      let assistName = '';
      if (!isOwnGoal && toucher && room.prevToucher && room.prevToucher !== toucherId) {
        const assister = room.players[room.prevToucher];
        if (assister && assister.team === scoringTeam) {
          if (assister.stats) assister.stats.assists++;
          assistName = assister.name;
        }
      }

      if (toucher && toucher.stats && !isOwnGoal) toucher.stats.goals++;
      const scorerName = toucher ? (isOwnGoal ? `${toucher.name} (Автогол)` : toucher.name) : '';
      const celebration = toucher?.celebration || CELEBRATIONS[room.score[scoringTeam] % CELEBRATIONS.length];

      room.score[scoringTeam]++;
      room.combo[scoringTeam]++;

      const comboLbl = room.combo[scoringTeam] >= 4 ? 'ОГОНЬ!' :
                       room.combo[scoringTeam] === 3 ? 'ХЕТ-ТРИК!' :
                       room.combo[scoringTeam] === 2 ? 'ДУБЛЬ!' : '';

      io.to(roomId).emit('goal', {
        goalId: `${room.matchUid}_${room.goalSeq}`,
        team: scoringTeam,
        red: room.score.red,
        blue: room.score.blue,
        scorerId: toucherId || null,
        scorerName,
        assistName,
        isOwnGoal,
        celebration,
        combo: comboLbl,
        players: getPlayersPublic(room)
      });

      const otherTeam = scoringTeam === 'red' ? 'blue' : 'red';
      room.combo[otherTeam] = 0;

      const goalLimit = MODES[room.mode]?.goals || 5;
      if (room.score[scoringTeam] >= goalLimit) { finishMatch(room, roomId); return; }
      resetPositions(room);
      break;
    }

    room.syncTick++;
    const every = Math.max(1, Math.round(SERVER_TICK / SYNC_RATE));
    if (room.syncTick >= every) {
      room.syncTick = 0;
      const snap = {
        balls: room.balls.map(b => ({
          x: b.x, y: b.y, vx: b.vx, vy: b.vy, z: b.z || 0,
          curve: b.curve, powerGlow: b.powerGlow, ownerId: b.ownerId
        })),
        players: {},
        timeLeft: room.timeLeft,
        stats: room.stats,
        playerStats: Object.fromEntries(activeIds.map(id => [id, room.players[id].stats]))
      };
      for (const id of activeIds) {
        const p = room.players[id];
        snap.players[id] = {
          x: p.x, y: p.y, vx: p.vx, vy: p.vy, facing: p.facing,
          stamina: p.stamina ?? 100,
          dashCd: p.dashCd, tackleCd: p.tackleCd, dashTimer: p.dashTimer,
          lastSeq: room.lastSeq[id] || 0
        };
      }
      io.to(roomId).volatile.emit('state', snap);
    }
  }, 1000 / SERVER_TICK);
}

function awardMatchRewards(acc, { outcome, goals, assists, shots, passes, matchId }) {
  const claimKey = `${acc.id}:${matchId}`;
  if (db.claimedMatchAwards[claimKey]) {
    return { alreadyClaimed: true, earned: 0, breakdown: [], account: publicAccountPayload(acc) };
  }
  db.claimedMatchAwards[claimKey] = Date.now();

  let earned = 0;
  const breakdown = [];

  if (outcome === 'win') {
    earned += 100;
    acc.wins += 1;
    acc.daily.wins = (acc.daily.wins || 0) + 1;
    breakdown.push('Победа: +100');
  } else if (outcome === 'draw') {
    earned += 50;
    breakdown.push('Ничья: +50');
  } else {
    earned += 25;
    breakdown.push('Участие: +25');
  }

  const g = Math.max(0, Math.min(30, parseInt(goals, 10) || 0));
  const a = Math.max(0, Math.min(30, parseInt(assists, 10) || 0));
  if (g > 0) {
    const gCoins = g * 20;
    earned += gCoins;
    acc.goals += g;
    acc.daily.goals = (acc.daily.goals || 0) + g;
    breakdown.push(`Голы (${g}): +${gCoins}`);
  }
  if (a > 0) {
    const aCoins = a * 15;
    earned += aCoins;
    acc.assists += a;
    breakdown.push(`Ассисты (${a}): +${aCoins}`);
  }

  acc.matches += 1;
  acc.shots += Math.max(0, Math.min(100, parseInt(shots, 10) || 0));
  acc.passes += Math.max(0, Math.min(100, parseInt(passes, 10) || 0));

  if (!acc.daily.firstMatchDone) {
    acc.daily.firstMatchDone = true;
    earned += 50;
    breakdown.push('Первый матч дня: +50');
  }

  // Daily quest completion check (3 goals and 1 win) -> 75..150 coins
  if (!acc.daily.questClaimed && (acc.daily.goals || 0) >= 3 && (acc.daily.wins || 0) >= 1) {
    acc.daily.questClaimed = true;
    const qReward = acc.daily.questReward || 100;
    earned += qReward;
    breakdown.push(`Ежедневное задание: +${qReward}`);
  }

  acc.coins += earned;
  scheduleSaveDB();
  return { alreadyClaimed: false, earned, breakdown, account: publicAccountPayload(acc) };
}

function finishMatch(room, roomId) {
  if (room.loop) clearInterval(room.loop);
  room.loop = null;
  room.loopRunning = false;
  room.started = false;
  let winner = 'draw';
  if (room.score.red > room.score.blue) winner = 'red';
  else if (room.score.blue > room.score.red) winner = 'blue';

  const rewardsBySocket = {};
  for (const [sid, p] of Object.entries(room.players)) {
    p.ready = false;
    if (p.accountId && db.accounts[p.accountId]) {
      const acc = getOrCreateAccount(p.accountId, p.name);
      const outcome = p.team === 'spec' ? 'draw' : (winner === 'draw' ? 'draw' : (winner === p.team ? 'win' : 'loss'));
      rewardsBySocket[sid] = awardMatchRewards(acc, {
        outcome,
        goals: p.stats?.goals || 0,
        assists: p.stats?.assists || 0,
        shots: p.stats?.shots || 0,
        passes: p.stats?.passes || 0,
        matchId: room.matchUid || `${roomId}_${Date.now()}`
      });
    }
  }

  io.to(roomId).emit('matchEnd', {
    matchUid: room.matchUid,
    winner,
    red: room.score.red,
    blue: room.score.blue,
    stats: room.stats,
    players: getPlayersPublic(room),
    rewardsBySocket
  });
}

// ==== AUTO MATCHMAKING (NO ROOM CODES) ====
function findOpenRoom() {
  for (const [id, room] of Object.entries(rooms)) {
    const activeCount = Object.values(room.players).filter(p => p.team !== 'spec').length;
    if (!room.started && !room.countingDown && activeCount < 4 && Object.keys(room.players).length < MAX_PLAYERS) {
      return room;
    }
  }
  return null;
}

// ==== SOCKET EVENTS ====
io.on('connection', (socket) => {
  socket.on('pingCheck', (ts, cb) => { if (typeof cb === 'function') cb(ts); });

  socket.on('authAccount', ({ accountId, nick }, cb) => {
    const acc = getOrCreateAccount(accountId, nick);
    socket.accountId = acc.id;
    let dailyBonus = 0;
    if (!acc.daily.loginClaimed) {
      acc.daily.loginClaimed = true;
      dailyBonus = 30 + Math.floor(Math.random() * 71); // 30 to 100 coins
      acc.daily.loginReward = dailyBonus;
      acc.coins += dailyBonus;
      scheduleSaveDB();
    }
    if (typeof cb === 'function') {
      cb({ ok: true, account: publicAccountPayload(acc), dailyBonus });
    }
  });

  // Automatic online matchmaking: joins an available match or creates a new one automatically
  socket.on('findMatch', ({ accountId, name, color, number, skin, ballSkin, celebration, isLandscape }, cb) => {
    const acc = getOrCreateAccount(accountId, name);
    socket.accountId = acc.id;

    // Validate owned skins server-side
    const safeSkin = acc.ownedSkins.includes(skin) ? skin : 'plain';
    const safeBallSkin = acc.ownedBallSkins.includes(ballSkin) ? ballSkin : 'classic';

    let room = findOpenRoom();
    let isNew = false;
    if (!room) {
      const id = genRoomId();
      room = {
        id,
        players: {}, inputs: {}, lastSeq: {}, teamHistory: {},
        lastToucher: null, prevToucher: null,
        loop: null, loopRunning: false, host: socket.id,
        started: false, countingDown: false, countdownTimer: null,
        settings: {
          arena: 'classic', mode: 'classic', matchDuration: 120,
          weather: 'clear', ballSkin: safeBallSkin,
          arenaColor: '#24662c'
        }
      };
      rooms[id] = room;
      isNew = true;
    }

    const cleanName = sanitize(name || acc.nick);
    const team = isNew ? 'red' : assignTeams(room);
    room.teamHistory[cleanName] = team;
    room.players[socket.id] = createPlayerState({
      accountId: acc.id,
      name: cleanName,
      color: sanitizeColor(color),
      number: sanitizeNum(number),
      skin: safeSkin,
      celebration: CELEBRATIONS.includes(celebration) ? celebration : 'jump',
      team
    });
    room.players[socket.id].ready = Boolean(isLandscape);
    room.inputs[socket.id] = { x: 0, y: 0 };
    socket.join(room.id);
    socket.roomId = room.id;

    io.to(room.id).emit('lobbyUpdate', { players: getPlayersPublic(room), host: room.host, settings: room.settings });
    if (typeof cb === 'function') {
      cb({ ok: true, players: getPlayersPublic(room), host: room.host, settings: room.settings });
    }
    triggerMatchStartSequence(room);
  });

  socket.on('setOrientationReady', ({ ready }) => {
    const roomId = socket.roomId;
    if (!roomId || !rooms[roomId]) return;
    const room = rooms[roomId];
    const p = room.players[socket.id];
    if (!p) return;

    const newReady = Boolean(ready);
    if (p.ready === newReady) return;
    p.ready = newReady;

    // Reset readiness / cancel countdown if player rotates out of landscape before match starts
    if (!newReady && room.countingDown && !room.started) {
      room.countingDown = false;
      if (room.countdownTimer) {
        clearTimeout(room.countdownTimer);
        room.countdownTimer = null;
      }
      io.to(roomId).emit('countdownCancelled', { reason: `${p.name} повернул экран вертикально` });
    }

    io.to(roomId).emit('lobbyUpdate', { players: getPlayersPublic(room), host: room.host, settings: room.settings });
    if (newReady && !room.started) {
      triggerMatchStartSequence(room);
    }
  });

  socket.on('switchTeam', (targetTeam) => {
    const roomId = socket.roomId;
    if (!roomId || !rooms[roomId] || rooms[roomId].started || rooms[roomId].countingDown) return;
    const room = rooms[roomId];
    const p = room.players[socket.id];
    if (!p || !['red', 'blue', 'spec'].includes(targetTeam)) return;
    if (targetTeam !== 'spec') {
      const count = Object.values(room.players).filter(x => x.team === targetTeam).length;
      if (count >= 2) return;
      room.teamHistory[p.name] = targetTeam;
    }
    p.team = targetTeam;
    io.to(roomId).emit('lobbyUpdate', { players: getPlayersPublic(room), host: room.host, settings: room.settings });
    triggerMatchStartSequence(room);
  });

  socket.on('updateSettings', (settings) => {
    const roomId = socket.roomId;
    if (!roomId || !rooms[roomId] || rooms[roomId].started) return;
    const room = rooms[roomId];
    if (room.host !== socket.id) return;
    if (settings.arena && ARENAS[settings.arena]) room.settings.arena = settings.arena;
    if (settings.mode && MODES[settings.mode]) room.settings.mode = settings.mode;
    if (settings.matchDuration) {
      const dur = parseInt(settings.matchDuration, 10);
      if ([60, 120, 180, 300].includes(dur)) room.settings.matchDuration = dur;
    }
    if (settings.weather && WEATHERS[settings.weather]) room.settings.weather = settings.weather;
    if (settings.ballSkin && BALL_SKIN_CATALOG[settings.ballSkin]) room.settings.ballSkin = settings.ballSkin;
    if (settings.arenaColor && /^#[0-9a-fA-F]{6}$/.test(settings.arenaColor)) room.settings.arenaColor = settings.arenaColor;
    io.to(roomId).emit('lobbyUpdate', { players: getPlayersPublic(room), host: room.host, settings: room.settings });
  });

  socket.on('input', (data) => {
    const roomId = socket.roomId;
    if (!roomId || !rooms[roomId]) return;
    const inp = rooms[roomId].inputs[socket.id];
    if (!inp) return;
    let x = Number(data.x) || 0, y = Number(data.y) || 0;
    const l = Math.hypot(x, y);
    if (l < 0.05) { x = 0; y = 0; }
    else if (l > 1) { x /= l; y /= l; }
    inp.x = x; inp.y = y;
    if (data.seq) rooms[roomId].lastSeq[socket.id] = Number(data.seq);
  });

  socket.on('action', ({ type, dirX, dirY, power, curveSign }) => {
    const roomId = socket.roomId;
    if (!roomId || !rooms[roomId]) return;
    const room = rooms[roomId];
    const p = room.players[socket.id];
    if (!p || p.team === 'spec') return;

    if (type === 'dash') {
      if (p.dashCd > 0 || (p.stamina ?? 100) < 20) return;
      p.stamina = Math.max(0, (p.stamina ?? 100) - 24);
      p.dashCd = DASH_CD;
      p.dashTimer = 0.28;
      const inp = room.inputs[socket.id] || { x: 0, y: 0 };
      const l = Math.hypot(inp.x, inp.y);
      const nx = l > 0.05 ? inp.x / l : Math.cos(p.facing || 0);
      const ny = l > 0.05 ? inp.y / l : Math.sin(p.facing || 0);
      p.vx = nx * DASH_IMPULSE;
      p.vy = ny * DASH_IMPULSE;
    } else if (type === 'tackle') {
      if (p.tackleCd > 0) return;
      p.tackleCd = TACKLE_CD;
      if (p.stats) p.stats.tackles++;
      const fx = Math.cos(p.facing || 0), fy = Math.sin(p.facing || 0);
      p.vx += fx * 340; p.vy += fy * 340;

      for (const b of room.balls) {
        const d = Math.hypot(b.x - p.x, b.y - p.y);
        if (d < PLAYER_R + BALL_R + 62) {
          if (b.ownerId && b.ownerId !== socket.id && room.players[b.ownerId]) {
            room.players[b.ownerId].pickupLock = 0.6;
            room.players[b.ownerId].vx *= 0.35;
            room.players[b.ownerId].vy *= 0.35;
          }
          b.ownerId = socket.id;
          b.lastTeam = p.team;
          recordTouch(room, socket.id);
        }
      }
    } else if (type === 'kick' || type === 'pass' || type === 'lob' || type === 'finesse') {
      let bestB = null, bestD = 9999;
      for (const b of room.balls) {
        if (b.ownerId === socket.id) { bestB = b; break; }
        const d = Math.hypot(b.x - p.x, b.y - p.y);
        const range = (type === 'kick' || type === 'finesse' ? 92 : 106) + PLAYER_R + BALL_R;
        if (d < range && d < bestD && !b.ownerId) { bestD = d; bestB = b; }
      }
      if (!bestB) return;
      const powerLevel = Math.max(0.25, Math.min(1, power || 1));
      applyShot(room, p, socket.id, bestB, type, dirX || 0, dirY || 0, powerLevel, Number(curveSign) || 0);
    }
  });

  socket.on('emote', (em) => {
    const roomId = socket.roomId;
    if (!roomId || !rooms[roomId] || !rooms[roomId].players[socket.id]) return;
    io.to(roomId).emit('emote', { id: socket.id, em: String(em).slice(0, 4) });
  });

  socket.on('chat', (msg) => {
    const roomId = socket.roomId;
    if (!roomId || !rooms[roomId]) return;
    const p = rooms[roomId].players[socket.id];
    if (!p) return;
    io.to(roomId).emit('chat', { name: p.name, msg: String(msg).slice(0, 100) });
  });

  socket.on('rematch', () => {
    const roomId = socket.roomId;
    if (!roomId || !rooms[roomId]) return;
    const room = rooms[roomId];
    io.to(roomId).emit('lobbyUpdate', { players: getPlayersPublic(room), host: room.host, settings: room.settings });
    triggerMatchStartSequence(room);
  });

  // ==== ECONOMY, SHOP & PROMOCODES (SERVER-AUTHORITATIVE) ====
  socket.on('buySkin', ({ accountId, category, skinId }, cb) => {
    const acc = getOrCreateAccount(accountId || socket.accountId);
    if (category === 'player') {
      const item = PLAYER_SKIN_CATALOG[skinId];
      if (!item) return cb && cb({ ok: false, error: 'Скин не найден' });
      if (acc.ownedSkins.includes(skinId)) return cb && cb({ ok: false, error: 'Уже куплено' });
      if (acc.coins < item.price) return cb && cb({ ok: false, error: 'Недостаточно монет' });
      acc.coins -= item.price;
      acc.ownedSkins.push(skinId);
      scheduleSaveDB();
      return cb && cb({ ok: true, account: publicAccountPayload(acc) });
    } else if (category === 'ball') {
      const item = BALL_SKIN_CATALOG[skinId];
      if (!item) return cb && cb({ ok: false, error: 'Скин мяча не найден' });
      if (acc.ownedBallSkins.includes(skinId)) return cb && cb({ ok: false, error: 'Уже куплено' });
      if (acc.coins < item.price) return cb && cb({ ok: false, error: 'Недостаточно монет' });
      acc.coins -= item.price;
      acc.ownedBallSkins.push(skinId);
      scheduleSaveDB();
      return cb && cb({ ok: true, account: publicAccountPayload(acc) });
    }
    if (cb) cb({ ok: false, error: 'Неверная категория' });
  });

  socket.on('claimOfflineMatch', ({ accountId, matchId, outcome, goals, assists, shots, passes }, cb) => {
    const acc = getOrCreateAccount(accountId || socket.accountId);
    const safeMatchId = String(matchId || '').replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 48);
    if (!safeMatchId) return cb && cb({ ok: false, error: 'Неверный ID матча' });
    const res = awardMatchRewards(acc, { outcome, goals, assists, shots, passes, matchId: safeMatchId });
    if (cb) cb({ ok: true, ...res });
  });

  socket.on('redeemPromo', ({ accountId, code }, cb) => {
    const acc = getOrCreateAccount(accountId || socket.accountId);
    const rawCode = String(code || '').trim();
    if (!rawCode) return cb && cb({ ok: false, error: 'Введите промокод' });

    // Check hidden admin promo code ("Srm7vAd") via SHA-256 hash
    const hash = crypto.createHash('sha256').update(rawCode).digest('hex');
    if (hash === ADMIN_SECRET_HASH) {
      adminSessions.add(socket.id);
      logAdminAction(acc.id, 'ADMIN_LOGIN', { nick: acc.nick, socketId: socket.id });
      return cb && cb({
        ok: true,
        isAdmin: true,
        message: 'Доступ к панели администратора открыт',
        account: publicAccountPayload(acc)
      });
    }

    const upperCode = rawCode.toUpperCase();
    const promo = db.promos[upperCode];
    if (!promo || !promo.active) {
      return cb && cb({ ok: false, error: 'Промокод не существует или неактивен' });
    }
    if (acc.usedPromos.includes(upperCode)) {
      return cb && cb({ ok: false, error: 'Вы уже активировали этот промокод' });
    }
    if (promo.usedCount >= promo.maxUses) {
      return cb && cb({ ok: false, error: 'Лимит активаций промокода исчерпан' });
    }

    acc.usedPromos.push(upperCode);
    promo.usedCount += 1;

    let rewardText = '';
    if (promo.type === 'coins') {
      const amount = Math.max(1, parseInt(promo.value, 10) || 0);
      acc.coins += amount;
      rewardText = `+${amount} монет`;
    } else if (promo.type === 'common_skin') {
      const lockedPlayerCommon = COMMON_PLAYER_SKINS.filter(s => !acc.ownedSkins.includes(s));
      const lockedBallCommon = COMMON_BALL_SKINS.filter(s => !acc.ownedBallSkins.includes(s));
      if (lockedPlayerCommon.length > 0) {
        const chosen = lockedPlayerCommon[0];
        acc.ownedSkins.push(chosen);
        rewardText = `Обычный скин игрока (${chosen})`;
      } else if (lockedBallCommon.length > 0) {
        const chosen = lockedBallCommon[0];
        acc.ownedBallSkins.push(chosen);
        rewardText = `Обычный скин мяча (${chosen})`;
      } else {
        acc.coins += 500;
        rewardText = '+500 монет (все обычные скины уже открыты)';
      }
    } else if (promo.type === 'skin') {
      const targetSkin = String(promo.value || 'star');
      if (PLAYER_SKIN_CATALOG[targetSkin]) {
        if (!acc.ownedSkins.includes(targetSkin)) acc.ownedSkins.push(targetSkin);
        rewardText = `Скин игрока: ${targetSkin}`;
      } else if (BALL_SKIN_CATALOG[targetSkin]) {
        if (!acc.ownedBallSkins.includes(targetSkin)) acc.ownedBallSkins.push(targetSkin);
        rewardText = `Скин мяча: ${targetSkin}`;
      } else {
        acc.coins += 500;
        rewardText = '+500 монет';
      }
    }

    scheduleSaveDB();
    if (cb) cb({ ok: true, isAdmin: false, rewardText, account: publicAccountPayload(acc) });
  });

  // ==== ADMIN PANEL ENDPOINTS (PROTECTED BY SERVER SESSION) ====
  function requireAdmin(cb) {
    if (!adminSessions.has(socket.id)) {
      if (typeof cb === 'function') cb({ ok: false, error: 'Доступ запрещён' });
      return false;
    }
    return true;
  }

  socket.on('adminGetDashboard', (_, cb) => {
    if (!requireAdmin(cb)) return;
    const playersList = Object.values(db.accounts).map(a => publicAccountPayload(a));
    if (typeof cb === 'function') {
      cb({
        ok: true,
        players: playersList,
        promos: db.promos,
        logs: db.adminLogs.slice(-50).reverse()
      });
    }
  });

  socket.on('adminUpdatePlayer', ({ targetId, action, amount, skinCategory, skinId }, cb) => {
    if (!requireAdmin(cb)) return;
    const acc = db.accounts[targetId];
    if (!acc) return cb && cb({ ok: false, error: 'Игрок не найден' });
    const val = parseInt(amount, 10) || 0;

    if (action === 'addCoins') {
      acc.coins = Math.max(0, acc.coins + val);
    } else if (action === 'subCoins') {
      acc.coins = Math.max(0, acc.coins - Math.abs(val));
    } else if (action === 'setCoins') {
      acc.coins = Math.max(0, val);
    } else if (action === 'addWins') {
      acc.wins = Math.max(0, acc.wins + val);
    } else if (action === 'setWins') {
      acc.wins = Math.max(0, val);
    } else if (action === 'addGoals') {
      acc.goals = Math.max(0, acc.goals + val);
    } else if (action === 'setGoals') {
      acc.goals = Math.max(0, val);
    } else if (action === 'setMatches') {
      acc.matches = Math.max(0, val);
    } else if (action === 'grantSkin') {
      if (skinCategory === 'ball' && BALL_SKIN_CATALOG[skinId]) {
        if (!acc.ownedBallSkins.includes(skinId)) acc.ownedBallSkins.push(skinId);
      } else if (PLAYER_SKIN_CATALOG[skinId]) {
        if (!acc.ownedSkins.includes(skinId)) acc.ownedSkins.push(skinId);
      }
    } else {
      return cb && cb({ ok: false, error: 'Неизвестное действие' });
    }

    logAdminAction(socket.accountId, `PLAYER_${action.toUpperCase()}`, { targetId, nick: acc.nick, amount: val, skinCategory, skinId });
    scheduleSaveDB();

    // Push live update to target player if online
    for (const [sid, s] of io.sockets.sockets) {
      if (s.accountId === targetId) {
        s.emit('accountSynced', publicAccountPayload(acc));
      }
    }

    if (typeof cb === 'function') cb({ ok: true, player: publicAccountPayload(acc), logs: db.adminLogs.slice(-50).reverse() });
  });

  socket.on('adminCreatePromo', ({ code, type, value, maxUses }, cb) => {
    if (!requireAdmin(cb)) return;
    const cleanCode = String(code || '').trim().toUpperCase().replace(/[^A-Z0-9_-]/g, '').slice(0, 20);
    if (!cleanCode) return cb && cb({ ok: false, error: 'Некорректный код' });
    const hash = crypto.createHash('sha256').update(cleanCode).digest('hex');
    if (hash === ADMIN_SECRET_HASH) return cb && cb({ ok: false, error: 'Зарезервированный код' });

    const limit = Math.max(1, parseInt(maxUses, 10) || 100);
    const promoType = ['coins', 'common_skin', 'skin'].includes(type) ? type : 'coins';
    const promoVal = promoType === 'coins' ? Math.max(1, parseInt(value, 10) || 50) : String(value || 'star');

    db.promos[cleanCode] = {
      type: promoType,
      value: promoVal,
      maxUses: limit,
      usedCount: 0,
      active: true
    };
    logAdminAction(socket.accountId, 'PROMO_CREATE', { code: cleanCode, type: promoType, value: promoVal, maxUses: limit });
    scheduleSaveDB();

    if (typeof cb === 'function') cb({ ok: true, promos: db.promos, logs: db.adminLogs.slice(-50).reverse() });
  });

  socket.on('adminTogglePromo', ({ code }, cb) => {
    if (!requireAdmin(cb)) return;
    const promo = db.promos[code];
    if (!promo) return cb && cb({ ok: false, error: 'Промокод не найден' });
    promo.active = !promo.active;
    logAdminAction(socket.accountId, 'PROMO_TOGGLE', { code, active: promo.active });
    scheduleSaveDB();
    if (typeof cb === 'function') cb({ ok: true, promos: db.promos, logs: db.adminLogs.slice(-50).reverse() });
  });

  socket.on('disconnect', () => {
    adminSessions.delete(socket.id);
    const roomId = socket.roomId;
    if (!roomId || !rooms[roomId]) return;
    const room = rooms[roomId];
    for (const b of (room.balls || [])) { if (b.ownerId === socket.id) b.ownerId = null; }
    delete room.players[socket.id];
    delete room.inputs[socket.id];
    delete room.lastSeq[socket.id];
    if (Object.keys(room.players).length === 0) {
      if (room.loop) clearInterval(room.loop);
      if (room.countdownTimer) clearTimeout(room.countdownTimer);
      delete rooms[roomId];
      return;
    }
    if (room.host === socket.id) room.host = Object.keys(room.players)[0];
    io.to(roomId).emit('lobbyUpdate', { players: getPlayersPublic(room), host: room.host, settings: room.settings });
    io.to(roomId).emit('playerLeft', socket.id);
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log('Ball Brawl Pro v9 on port ' + PORT));
