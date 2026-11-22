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
const GOAL_DEPTH = 78;

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

// ==== PERSISTENT DATA STORE ====
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

function todayStr() {
  const d = new Date();
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`;
}

function sanitize(s, d = 'Игрок') { return String(s || d).replace(/[<>]/g, '').trim().slice(0, 14) || d; }
function sanitizeNum(n) { const v = parseInt(n, 10); return isNaN(v) ? 0 : Math.max(0, Math.min(99, v)); }
function sanitizeColor(c) { return /^#[0-9a-fA-F]{6}$/.test(c) ? c : '#ff3366'; }

function normalizeAccount(acc, cleanId, nick) {
  acc.id = cleanId;
  if (nick) acc.nick = sanitize(nick, acc.nick);
  if (!acc.nick) acc.nick = 'Игрок';
  acc.coins = Math.max(0, Number(acc.coins) || 0);
  acc.wins = Math.max(0, Number(acc.wins) || 0);
  acc.goals = Math.max(0, Number(acc.goals) || 0);
  acc.assists = Math.max(0, Number(acc.assists) || 0);
  acc.matches = Math.max(0, Number(acc.matches) || 0);
  acc.shots = Math.max(0, Number(acc.shots) || 0);
  acc.passes = Math.max(0, Number(acc.passes) || 0);
  acc.penaltyRecord = Math.max(0, Number(acc.penaltyRecord) || 0);
  if (!Array.isArray(acc.ownedSkins) || !acc.ownedSkins.includes('plain')) acc.ownedSkins = ['plain', ...(acc.ownedSkins || [])];
  if (!Array.isArray(acc.ownedBallSkins) || !acc.ownedBallSkins.includes('classic')) acc.ownedBallSkins = ['classic', ...(acc.ownedBallSkins || [])];
  if (!Array.isArray(acc.usedPromos)) acc.usedPromos = [];
  if (!Array.isArray(acc.friends)) acc.friends = [];
  if (!Array.isArray(acc.friendRequestsIn)) acc.friendRequestsIn = [];
  if (!Array.isArray(acc.friendRequestsOut)) acc.friendRequestsOut = [];
  if (!Array.isArray(acc.blocked)) acc.blocked = [];
  if (!Array.isArray(acc.recentOpponents)) acc.recentOpponents = [];
  if (!acc.season || typeof acc.season !== 'object') {
    acc.season = { xp: 0, claimedTiers: [], quests: { goals: 0, passes: 0, wins: 0, claimed: {} } };
  }
  if (!acc.season.quests) acc.season.quests = { goals: 0, passes: 0, wins: 0, claimed: {} };
  if (!acc.season.quests.claimed) acc.season.quests.claimed = {};
  if (!Array.isArray(acc.season.claimedTiers)) acc.season.claimedTiers = [];
  acc.season.xp = Math.max(0, Number(acc.season.xp) || 0);

  const t = todayStr();
  if (!acc.daily || acc.daily.date !== t) {
    acc.daily = {
      date: t,
      loginClaimed: false,
      loginReward: 0,
      firstMatchDone: false,
      goals: 0,
      wins: 0,
      questReward: 75 + Math.floor(Math.random() * 76),
      questClaimed: false
    };
  }
  if (!acc.daily.questReward || acc.daily.questReward < 75 || acc.daily.questReward > 150) {
    acc.daily.questReward = 75 + Math.floor(Math.random() * 76);
  }
  acc.lastSeen = Date.now();
  return acc;
}

function loadDB() {
  try {
    if (fs.existsSync(DATA_FILE)) {
      const parsed = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
      db.accounts = parsed.accounts || {};
      db.promos = Object.assign(JSON.parse(JSON.stringify(DEFAULT_PROMOS)), parsed.promos || {});
      db.adminLogs = Array.isArray(parsed.adminLogs) ? parsed.adminLogs.slice(-500) : [];
      db.claimedMatchAwards = parsed.claimedMatchAwards || {};
      for (const [id, acc] of Object.entries(db.accounts)) {
        normalizeAccount(acc, id);
      }
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
      if (keys.length > 2500) {
        keys.slice(0, keys.length - 1800).forEach(k => delete db.claimedMatchAwards[k]);
      }
      fs.writeFileSync(DATA_FILE, JSON.stringify(db, null, 2), 'utf8');
    } catch (e) {
      console.error('DB save error:', e.message);
    }
  }, 350);
}
loadDB();

function getOrCreateAccount(accountId, nick) {
  let cleanId = String(accountId || '').replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 40);
  if (!cleanId) cleanId = 'acc_' + crypto.randomBytes(6).toString('hex');
  if (!db.accounts[cleanId]) {
    db.accounts[cleanId] = normalizeAccount({
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
      friends: [],
      friendRequestsIn: [],
      friendRequestsOut: [],
      blocked: [],
      recentOpponents: [],
      season: { xp: 0, claimedTiers: [], quests: { goals: 0, passes: 0, wins: 0, claimed: {} } },
      createdAt: Date.now(),
      lastSeen: Date.now()
    }, cleanId, nick);
    scheduleSaveDB();
    return db.accounts[cleanId];
  }
  const acc = normalizeAccount(db.accounts[cleanId], cleanId, nick);
  scheduleSaveDB();
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
    blocked: acc.blocked || [],
    recentOpponents: acc.recentOpponents || [],
    season: acc.season,
    daily: acc.daily
  };
}

// ==== RUNTIME STATE, FRIENDS, INVITES & PRIVATE ROOMS ====
const rooms = {};
const privateRooms = {}; // code -> roomId
const matchInvites = {}; // inviteId -> { id, fromAccountId, fromNick, fromSocketId, toAccountId, roomId, createdAt }
const disconnectedSessions = {}; // `${accountId}:${roomId}` -> { roomId, accountId, playerSnapshot, team, disconnectedAt, timeout }
const adminSessions = new Set();

function genRoomId(prefix = 'M_') {
  const id = prefix + crypto.randomBytes(4).toString('hex').toUpperCase();
  return rooms[id] ? genRoomId(prefix) : id;
}

function genInviteCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code = '';
  for (let i = 0; i < 6; i++) code += chars[crypto.randomInt(0, chars.length)];
  return privateRooms[code] ? genInviteCode() : code;
}

function getSocketsByAccountId(accountId) {
  const res = [];
  if (!accountId) return res;
  for (const [, s] of io.sockets.sockets) {
    if (s.accountId === accountId && s.connected) res.push(s);
  }
  return res;
}

function getUserStatus(accountId) {
  const onlineSockets = getSocketsByAccountId(accountId);
  if (!onlineSockets.length) return 'offline';
  for (const s of onlineSockets) {
    if (s.roomId && rooms[s.roomId]) {
      return rooms[s.roomId].started ? 'in_match' : 'in_lobby';
    }
  }
  return 'online';
}

function buildFriendsPayload(acc) {
  const friends = (acc.friends || []).map(fid => {
    const facc = db.accounts[fid];
    if (!facc) return null;
    const status = getUserStatus(fid);
    const activeSocket = getSocketsByAccountId(fid).find(s => s.roomId && rooms[s.roomId]);
    const r = activeSocket ? rooms[activeSocket.roomId] : null;
    return {
      id: facc.id,
      nick: facc.nick,
      wins: facc.wins,
      goals: facc.goals,
      status,
      roomId: r ? r.id : null,
      roomCode: r && r.isPrivate ? r.inviteCode : null
    };
  }).filter(Boolean);

  const incoming = (acc.friendRequestsIn || []).map(fromId => {
    const facc = db.accounts[fromId];
    return facc ? { id: facc.id, nick: facc.nick, wins: facc.wins } : null;
  }).filter(Boolean);

  const outgoing = (acc.friendRequestsOut || []).map(toId => {
    const facc = db.accounts[toId];
    return facc ? { id: facc.id, nick: facc.nick, status: getUserStatus(toId) } : null;
  }).filter(Boolean);

  return { friends, incoming, outgoing };
}

function pushFriendsUpdate(accountId) {
  const acc = db.accounts[accountId];
  if (!acc) return;
  const payload = buildFriendsPayload(acc);
  for (const s of getSocketsByAccountId(accountId)) {
    s.emit('friendsUpdate', payload);
  }
}

// ==== ANTI-SPAM & RATE LIMITING ====
const rateBuckets = new Map();
function allowRate(key, limitPerSec, burst = limitPerSec * 2) {
  const now = Date.now();
  let b = rateBuckets.get(key);
  if (!b) {
    b = { tokens: burst, last: now };
    rateBuckets.set(key, b);
  }
  const elapsed = (now - b.last) / 1000;
  b.last = now;
  b.tokens = Math.min(burst, b.tokens + elapsed * limitPerSec);
  if (b.tokens < 1) return false;
  b.tokens -= 1;
  return true;
}

function assignTeams(room, preferredTeam = null) {
  const maxPerTeam = room.settings.teamSize || 2;
  const players = Object.values(room.players);
  const r = players.filter(p => p.team === 'red').length;
  const b = players.filter(p => p.team === 'blue').length;

  if (preferredTeam === 'red' && r < maxPerTeam) return 'red';
  if (preferredTeam === 'blue' && b < maxPerTeam) return 'blue';
  if (preferredTeam === 'spec') return 'spec';

  if (r + b >= maxPerTeam * 2) return 'spec';
  return r <= b ? 'red' : 'blue';
}

function autoBalanceRoom(room) {
  const maxPerTeam = room.settings.teamSize || 2;
  const active = Object.values(room.players).filter(p => p.team !== 'spec');
  if (active.length < 2) return;
  const reds = active.filter(p => p.team === 'red');
  const blues = active.filter(p => p.team === 'blue');
  while (reds.length > blues.length + 1 && blues.length < maxPerTeam) {
    const moved = reds.pop();
    moved.team = 'blue';
    blues.push(moved);
  }
  while (blues.length > reds.length + 1 && reds.length < maxPerTeam) {
    const moved = blues.pop();
    moved.team = 'red';
    reds.push(moved);
  }
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
    const spread = reds.length === 1 ? 0 : (i - (reds.length - 1) / 2) * 95;
    p.x = bd.minX + 170; p.y = spread; p.vx = 0; p.vy = 0; p.facing = 0;
    p.pickupLock = 0; p.dashTimer = 0; p.stamina = Math.max(p.stamina || 100, 65);
  });
  blues.forEach((id, i) => {
    const p = room.players[id];
    const spread = blues.length === 1 ? 0 : (i - (blues.length - 1) / 2) * 95;
    p.x = bd.maxX - 170; p.y = spread; p.vx = 0; p.vy = 0; p.facing = Math.PI;
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

function emitRoomState(room) {
  io.to(room.id).emit('lobbyUpdate', {
    roomId: room.id,
    isPrivate: Boolean(room.isPrivate),
    inviteCode: room.inviteCode || null,
    players: getPlayersPublic(room),
    host: room.host,
    settings: room.settings
  });
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

  let dx = Number(dirX) || 0, dy = Number(dirY) || 0;
  if (!Number.isFinite(dx)) dx = 0;
  if (!Number.isFinite(dy)) dy = 0;
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
  const safeCurveSign = Math.max(-1, Math.min(1, Number(curveSign) || 0));
  const effectiveCurve = safeCurveSign !== 0 ? safeCurveSign : moveCross;
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

// Goal registration strictly checks crossing goal line plane BEFORE boundary wall bounce
function checkGoalSegment(b, minX, maxX, goalHalfH) {
  const inZ = (b.z || 0) <= 72;
  if (!inZ) return null;

  const yTol = goalHalfH + BALL_R * 0.35;
  const leftLine = minX;
  const rightLine = maxX;

  if (b.x <= leftLine + BALL_R * 0.25) {
    if (b.prevX > leftLine) {
      const t = (leftLine - b.prevX) / ((b.x - b.prevX) || -1e-6);
      const crossY = b.prevY + (b.y - b.prevY) * Math.max(0, Math.min(1, t));
      if (Math.abs(crossY) <= yTol) return 'blue';
    } else if (Math.abs(b.y) <= yTol && b.x < leftLine) {
      return 'blue';
    }
  }

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
  const minRequired = room.isPrivate ? 2 : 2;
  if (active.length < minRequired) return false;
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
      emitRoomState(room);
      return;
    }
    room.started = true;
    room.matchUid = 'OM_' + crypto.randomBytes(6).toString('hex');
    io.to(room.id).emit('gameStarted', {
      roomId: room.id,
      players: getPlayersPublic(room),
      settings: room.settings,
      matchUid: room.matchUid
    });
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
      if (!Number.isFinite(p.x)) p.x = 0;
      if (!Number.isFinite(p.y)) p.y = 0;
      if (p.dashCd > 0) p.dashCd -= dt;
      if (p.dashTimer > 0) p.dashTimer -= dt;
      if (p.tackleCd > 0) p.tackleCd -= dt;
      if (p.pickupLock > 0) p.pickupLock -= dt;
    }

    const activeIds = Object.keys(room.players).filter(id => room.players[id].team !== 'spec');

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

        // Guard against NaN / out-of-arena escape
        if (!Number.isFinite(b.x) || !Number.isFinite(b.y)) {
          b.x = 0; b.y = 0; b.vx = 0; b.vy = 0; b.z = 0; b.vz = 0;
        }
        const maxSpeed = 1650;
        const bsp = Math.hypot(b.vx, b.vy);
        if (bsp > maxSpeed) { b.vx = (b.vx / bsp) * maxSpeed; b.vy = (b.vy / bsp) * maxSpeed; }

        for (const [ox, oy, ow, oh] of bd.obstacles) {
          resolveCircleRect(b, BALL_R, ox, oy, ow, oh, BOUNCE);
        }

        const canPickup = (b.z || 0) < 22;
        if (canPickup) {
          for (const id of activeIds) {
            const p = room.players[id];
            const d = Math.hypot(b.x - p.x, b.y - p.y);
            if (d <= PLAYER_R + BALL_R + 5) {
              if (p.pickupLock > 0) {
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

      // Check goal BEFORE boundary clamp on X
      const scoringTeam = now >= (room.goalLockUntil || 0) ? checkGoalSegment(b, bd.minX, bd.maxX, goalHalfH) : null;

      if (!scoringTeam) {
        if (b.x < bd.minX + BALL_R) { b.x = bd.minX + BALL_R; b.vx = Math.abs(b.vx) * BOUNCE; }
        if (b.x > bd.maxX - BALL_R) { b.x = bd.maxX - BALL_R; b.vx = -Math.abs(b.vx) * BOUNCE; }
        continue;
      }

      // Clamp ball inside goal net visually for replay/effect without escaping arena
      if (scoringTeam === 'blue') b.x = Math.max(bd.minX - GOAL_DEPTH + BALL_R, b.x);
      if (scoringTeam === 'red') b.x = Math.min(bd.maxX + GOAL_DEPTH - BALL_R, b.x);

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
    acc.season.quests.wins = (acc.season.quests.wins || 0) + 1;
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
  const s = Math.max(0, Math.min(100, parseInt(shots, 10) || 0));
  const ps = Math.max(0, Math.min(100, parseInt(passes, 10) || 0));

  if (g > 0) {
    const gCoins = g * 20;
    earned += gCoins;
    acc.goals += g;
    acc.daily.goals = (acc.daily.goals || 0) + g;
    acc.season.quests.goals = (acc.season.quests.goals || 0) + g;
    breakdown.push(`Голы (${g}): +${gCoins}`);
  }
  if (a > 0) {
    const aCoins = a * 15;
    earned += aCoins;
    acc.assists += a;
    breakdown.push(`Ассисты (${a}): +${aCoins}`);
  }

  acc.matches += 1;
  acc.shots += s;
  acc.passes += ps;
  acc.season.quests.passes = (acc.season.quests.passes || 0) + ps;

  // Season XP progression
  const xpGain = (outcome === 'win' ? 120 : (outcome === 'draw' ? 70 : 45)) + g * 25 + ps * 3;
  acc.season.xp = (acc.season.xp || 0) + xpGain;

  if (!acc.daily.firstMatchDone) {
    acc.daily.firstMatchDone = true;
    earned += 50;
    breakdown.push('Первый матч дня: +50');
  }

  if (!acc.daily.questClaimed && (acc.daily.goals || 0) >= 3 && (acc.daily.wins || 0) >= 1) {
    acc.daily.questClaimed = true;
    const qReward = acc.daily.questReward || 100;
    earned += qReward;
    breakdown.push(`Ежедневное задание: +${qReward}`);
  }

  acc.coins += earned;
  scheduleSaveDB();
  return { alreadyClaimed: false, earned, xpGain, breakdown, account: publicAccountPayload(acc) };
}

function finishMatch(room, roomId) {
  if (room.loop) clearInterval(room.loop);
  room.loop = null;
  room.loopRunning = false;
  room.started = false;
  let winner = 'draw';
  if (room.score.red > room.score.blue) winner = 'red';
  else if (room.score.blue > room.score.red) winner = 'blue';

  const allPlayers = Object.values(room.players);

  // Record recent opponents & award rewards
  const rewardsBySocket = {};
  for (const [sid, p] of Object.entries(room.players)) {
    p.ready = false;
    if (p.accountId && db.accounts[p.accountId]) {
      const acc = getOrCreateAccount(p.accountId, p.name);
      const others = allPlayers.filter(op => op.accountId && op.accountId !== p.accountId && op.team !== 'spec');
      for (const op of others) {
        acc.recentOpponents = (acc.recentOpponents || []).filter(item => item.id !== op.accountId);
        acc.recentOpponents.unshift({
          id: op.accountId,
          nick: op.name,
          team: op.team,
          ts: Date.now()
        });
      }
      acc.recentOpponents = (acc.recentOpponents || []).slice(0, 12);

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

// ==== MATCHMAKING (PUBLIC AUTO-MATCH ONLY, NEVER PULLS PRIVATE ROOMS) ====
function findOpenPublicRoom(teamSize = 2) {
  for (const [, room] of Object.entries(rooms)) {
    if (room.isPrivate) continue;
    if ((room.settings.teamSize || 2) !== teamSize) continue;
    const activeCount = Object.values(room.players).filter(p => p.team !== 'spec').length;
    if (!room.started && !room.countingDown && activeCount < teamSize * 2 && Object.keys(room.players).length < MAX_PLAYERS) {
      return room;
    }
  }
  return null;
}

function attachPlayerToRoom(socket, room, { acc, name, color, number, skin, ballSkin, celebration, isLandscape, preferredTeam = null }) {
  const safeSkin = acc.ownedSkins.includes(skin) ? skin : 'plain';
  const safeBallSkin = acc.ownedBallSkins.includes(ballSkin) ? ballSkin : 'classic';
  if (room.isPrivate && !room.settings.ballSkin) room.settings.ballSkin = safeBallSkin;

  const cleanName = sanitize(name || acc.nick, acc.nick);
  acc.nick = cleanName;
  const isFirst = Object.keys(room.players).length === 0;
  const team = preferredTeam || (isFirst ? 'red' : assignTeams(room));

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

  if (room.isPrivate) {
    autoBalanceRoom(room);
  }
  emitRoomState(room);
  pushFriendsUpdate(acc.id);
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
      dailyBonus = 30 + Math.floor(Math.random() * 71);
      acc.daily.loginReward = dailyBonus;
      acc.coins += dailyBonus;
      scheduleSaveDB();
    }

    // Check if player can automatically rejoin an active match after disconnect
    let rejoinInfo = null;
    for (const [key, sess] of Object.entries(disconnectedSessions)) {
      if (sess.accountId === acc.id && rooms[sess.roomId] && rooms[sess.roomId].started) {
        rejoinInfo = { roomId: sess.roomId, key };
        break;
      }
    }

    if (typeof cb === 'function') {
      cb({
        ok: true,
        account: publicAccountPayload(acc),
        friendsData: buildFriendsPayload(acc),
        dailyBonus,
        rejoinInfo
      });
    }
    for (const fid of (acc.friends || [])) {
      pushFriendsUpdate(fid);
    }
  });

  // Automatic reconnect into active match
  socket.on('rejoinMatch', ({ accountId, isLandscape }, cb) => {
    const acc = getOrCreateAccount(accountId || socket.accountId);
    socket.accountId = acc.id;
    let foundKey = null;
    let sess = null;
    for (const [k, s] of Object.entries(disconnectedSessions)) {
      if (s.accountId === acc.id && rooms[s.roomId]) {
        foundKey = k;
        sess = s;
        break;
      }
    }
    if (!sess || !rooms[sess.roomId]) {
      return cb && cb({ ok: false, error: 'Активный матч не найден или уже завершён' });
    }
    clearTimeout(sess.timeout);
    delete disconnectedSessions[foundKey];

    const room = rooms[sess.roomId];
    const snap = sess.playerSnapshot;
    room.players[socket.id] = createPlayerState({
      accountId: acc.id,
      name: acc.nick,
      color: snap.color || '#ff3366',
      number: snap.number || 7,
      skin: acc.ownedSkins.includes(snap.skin) ? snap.skin : 'plain',
      celebration: snap.celebration || 'jump',
      team: snap.team || assignTeams(room)
    });
    room.players[socket.id].x = snap.x || 0;
    room.players[socket.id].y = snap.y || 0;
    room.players[socket.id].stamina = snap.stamina ?? 100;
    room.players[socket.id].stats = snap.stats || { goals: 0, assists: 0, shots: 0, passes: 0, tackles: 0, saves: 0 };
    room.players[socket.id].ready = isLandscape !== undefined ? Boolean(isLandscape) : true;
    room.inputs[socket.id] = { x: 0, y: 0 };
    socket.join(room.id);
    socket.roomId = room.id;

    emitRoomState(room);
    pushFriendsUpdate(acc.id);
    if (typeof cb === 'function') {
      cb({
        ok: true,
        started: Boolean(room.started),
        roomId: room.id,
        players: getPlayersPublic(room),
        settings: room.settings
      });
    }
  });

  // Public auto-matchmaking (no code needed)
  socket.on('findMatch', ({ accountId, name, color, number, skin, ballSkin, celebration, isLandscape, teamSize }, cb) => {
    if (!allowRate('find_' + socket.id, 3, 5)) return cb && cb({ ok: false, error: 'Слишком частые запросы' });
    const acc = getOrCreateAccount(accountId, name);
    socket.accountId = acc.id;
    const safeBallSkin = acc.ownedBallSkins.includes(ballSkin) ? ballSkin : 'classic';
    const sz = [1, 2].includes(parseInt(teamSize, 10)) ? parseInt(teamSize, 10) : 2;

    let room = findOpenPublicRoom(sz);
    if (!room) {
      const id = genRoomId('PUB_');
      room = {
        id,
        isPrivate: false,
        inviteCode: null,
        players: {}, inputs: {}, lastSeq: {},
        lastToucher: null, prevToucher: null,
        loop: null, loopRunning: false, host: socket.id,
        started: false, countingDown: false, countdownTimer: null,
        settings: {
          arena: 'classic', mode: 'classic', matchDuration: 120,
          weather: 'clear', ballSkin: safeBallSkin, teamSize: sz,
          arenaColor: '#24662c'
        }
      };
      rooms[id] = room;
    }

    attachPlayerToRoom(socket, room, { acc, name, color, number, skin, ballSkin: safeBallSkin, celebration, isLandscape });
    if (typeof cb === 'function') {
      cb({ ok: true, roomId: room.id, isPrivate: false, inviteCode: null, players: getPlayersPublic(room), host: room.host, settings: room.settings });
    }
    triggerMatchStartSequence(room);
  });

  // Create private room with unique code & invite link
  socket.on('createPrivateRoom', ({ accountId, name, color, number, skin, ballSkin, celebration, isLandscape, teamSize }, cb) => {
    if (!allowRate('priv_' + socket.id, 3, 5)) return cb && cb({ ok: false, error: 'Слишком частые запросы' });
    const acc = getOrCreateAccount(accountId, name);
    socket.accountId = acc.id;
    const safeBallSkin = acc.ownedBallSkins.includes(ballSkin) ? ballSkin : 'classic';
    const sz = [1, 2].includes(parseInt(teamSize, 10)) ? parseInt(teamSize, 10) : 2;

    const id = genRoomId('PRV_');
    const code = genInviteCode();
    const room = {
      id,
      isPrivate: true,
      inviteCode: code,
      allowedAccounts: new Set([acc.id]),
      players: {}, inputs: {}, lastSeq: {},
      lastToucher: null, prevToucher: null,
      loop: null, loopRunning: false, host: socket.id,
      started: false, countingDown: false, countdownTimer: null,
      settings: {
        arena: 'classic', mode: 'classic', matchDuration: 120,
        weather: 'clear', ballSkin: safeBallSkin, teamSize: sz,
        arenaColor: '#24662c'
      }
    };
    rooms[id] = room;
    privateRooms[code] = id;

    attachPlayerToRoom(socket, room, { acc, name, color, number, skin, ballSkin: safeBallSkin, celebration, isLandscape, preferredTeam: 'red' });
    if (typeof cb === 'function') {
      cb({
        ok: true,
        roomId: room.id,
        isPrivate: true,
        inviteCode: code,
        players: getPlayersPublic(room),
        host: room.host,
        settings: room.settings
      });
    }
  });

  // Join private room by code or roomId (with authorization / friend / invite check)
  socket.on('joinPrivateRoom', ({ accountId, codeOrRoomId, name, color, number, skin, ballSkin, celebration, isLandscape }, cb) => {
    if (!allowRate('join_priv_' + socket.id, 4, 6)) return cb && cb({ ok: false, error: 'Слишком частые запросы' });
    const acc = getOrCreateAccount(accountId, name);
    socket.accountId = acc.id;

    const raw = String(codeOrRoomId || '').trim().toUpperCase();
    const targetRoomId = privateRooms[raw] || (rooms[raw] && rooms[raw].isPrivate ? raw : null);
    if (!targetRoomId || !rooms[targetRoomId]) {
      return cb && cb({ ok: false, error: 'Приватная комната не найдена или код недействителен' });
    }
    const room = rooms[targetRoomId];
    if (room.started) {
      return cb && cb({ ok: false, error: 'Матч уже идёт' });
    }
    if (Object.keys(room.players).length >= MAX_PLAYERS) {
      return cb && cb({ ok: false, error: 'Комната заполнена' });
    }

    // Verify access: host/allowed account, friend of host, or invited user
    const hostPlayer = room.players[room.host];
    const hostAccId = hostPlayer ? hostPlayer.accountId : null;
    const hostAcc = hostAccId ? db.accounts[hostAccId] : null;
    const isAllowed = room.allowedAccounts?.has(acc.id) ||
                      acc.id === hostAccId ||
                      (hostAcc && Array.isArray(hostAcc.friends) && hostAcc.friends.includes(acc.id));

    if (!isAllowed) {
      return cb && cb({ ok: false, error: 'Доступ запрещён: требуется приглашение или дружба с создателем комнаты' });
    }
    if (hostAcc && Array.isArray(hostAcc.blocked) && hostAcc.blocked.includes(acc.id)) {
      return cb && cb({ ok: false, error: 'Вы заблокированы создателем комнаты' });
    }

    room.allowedAccounts.add(acc.id);
    attachPlayerToRoom(socket, room, { acc, name, color, number, skin, ballSkin, celebration, isLandscape });
    if (typeof cb === 'function') {
      cb({
        ok: true,
        roomId: room.id,
        isPrivate: true,
        inviteCode: room.inviteCode,
        players: getPlayersPublic(room),
        host: room.host,
        settings: room.settings
      });
    }
    triggerMatchStartSequence(room);
  });

  // ==== FRIENDS, SEARCH, BLOCKS, REPORTS & INVITES ====
  socket.on('searchPlayers', ({ accountId, query }, cb) => {
    const acc = getOrCreateAccount(accountId || socket.accountId);
    const q = String(query || '').trim().toLowerCase();
    const list = Object.values(db.accounts)
      .filter(u => u.id !== acc.id && !(acc.blocked || []).includes(u.id))
      .filter(u => !q || u.id.toLowerCase().includes(q) || (u.nick || '').toLowerCase().includes(q))
      .slice(0, 15)
      .map(u => ({
        id: u.id,
        nick: u.nick,
        wins: u.wins,
        goals: u.goals,
        status: getUserStatus(u.id),
        isFriend: (acc.friends || []).includes(u.id),
        outgoing: (acc.friendRequestsOut || []).includes(u.id),
        incoming: (acc.friendRequestsIn || []).includes(u.id)
      }));
    if (typeof cb === 'function') cb({ ok: true, results: list });
  });

  socket.on('sendFriendRequest', ({ accountId, targetId }, cb) => {
    if (!allowRate('fr_' + socket.id, 5, 8)) return cb && cb({ ok: false, error: 'Слишком много запросов' });
    const acc = getOrCreateAccount(accountId || socket.accountId);
    const cleanTarget = String(targetId || '').trim();
    if (!cleanTarget || cleanTarget === acc.id) return cb && cb({ ok: false, error: 'Некорректный ID игрока' });
    const targetAcc = db.accounts[cleanTarget];
    if (!targetAcc) return cb && cb({ ok: false, error: 'Игрок не найден' });
    if ((acc.blocked || []).includes(cleanTarget) || (targetAcc.blocked || []).includes(acc.id)) {
      return cb && cb({ ok: false, error: 'Добавление недоступно' });
    }
    if ((acc.friends || []).includes(cleanTarget)) {
      return cb && cb({ ok: false, error: 'Уже в списке друзей' });
    }
    if ((acc.friendRequestsOut || []).includes(cleanTarget)) {
      return cb && cb({ ok: false, error: 'Запрос уже отправлен' });
    }

    // If target already sent request to us, accept automatically
    if ((acc.friendRequestsIn || []).includes(cleanTarget)) {
      acc.friendRequestsIn = acc.friendRequestsIn.filter(x => x !== cleanTarget);
      targetAcc.friendRequestsOut = (targetAcc.friendRequestsOut || []).filter(x => x !== acc.id);
      if (!acc.friends.includes(cleanTarget)) acc.friends.push(cleanTarget);
      if (!targetAcc.friends.includes(acc.id)) targetAcc.friends.push(acc.id);
      scheduleSaveDB();
      pushFriendsUpdate(acc.id);
      pushFriendsUpdate(cleanTarget);
      return cb && cb({ ok: true, accepted: true, friendsData: buildFriendsPayload(acc) });
    }

    acc.friendRequestsOut.push(cleanTarget);
    if (!targetAcc.friendRequestsIn.includes(acc.id)) targetAcc.friendRequestsIn.push(acc.id);
    scheduleSaveDB();
    pushFriendsUpdate(acc.id);
    pushFriendsUpdate(cleanTarget);
    for (const s of getSocketsByAccountId(cleanTarget)) {
      s.emit('friendRequestReceived', { fromId: acc.id, fromNick: acc.nick });
    }
    if (typeof cb === 'function') cb({ ok: true, friendsData: buildFriendsPayload(acc) });
  });

  socket.on('respondFriendRequest', ({ accountId, fromId, accept }, cb) => {
    const acc = getOrCreateAccount(accountId || socket.accountId);
    const cleanFrom = String(fromId || '').trim();
    const otherAcc = db.accounts[cleanFrom];
    acc.friendRequestsIn = (acc.friendRequestsIn || []).filter(x => x !== cleanFrom);
    if (otherAcc) {
      otherAcc.friendRequestsOut = (otherAcc.friendRequestsOut || []).filter(x => x !== acc.id);
    }
    if (accept && otherAcc) {
      if (!acc.friends.includes(cleanFrom)) acc.friends.push(cleanFrom);
      if (!otherAcc.friends.includes(acc.id)) otherAcc.friends.push(acc.id);
    }
    scheduleSaveDB();
    pushFriendsUpdate(acc.id);
    if (otherAcc) pushFriendsUpdate(cleanFrom);
    if (typeof cb === 'function') cb({ ok: true, friendsData: buildFriendsPayload(acc) });
  });

  socket.on('removeFriend', ({ accountId, friendId }, cb) => {
    const acc = getOrCreateAccount(accountId || socket.accountId);
    const cleanFriend = String(friendId || '').trim();
    acc.friends = (acc.friends || []).filter(x => x !== cleanFriend);
    const otherAcc = db.accounts[cleanFriend];
    if (otherAcc) {
      otherAcc.friends = (otherAcc.friends || []).filter(x => x !== acc.id);
    }
    scheduleSaveDB();
    pushFriendsUpdate(acc.id);
    if (otherAcc) pushFriendsUpdate(cleanFriend);
    if (typeof cb === 'function') cb({ ok: true, friendsData: buildFriendsPayload(acc) });
  });

  socket.on('blockPlayer', ({ accountId, targetId }, cb) => {
    const acc = getOrCreateAccount(accountId || socket.accountId);
    const cleanTarget = String(targetId || '').trim();
    if (!cleanTarget || cleanTarget === acc.id) return cb && cb({ ok: false, error: 'Некорректный ID' });
    if (!(acc.blocked || []).includes(cleanTarget)) acc.blocked.push(cleanTarget);
    acc.friends = (acc.friends || []).filter(x => x !== cleanTarget);
    acc.friendRequestsIn = (acc.friendRequestsIn || []).filter(x => x !== cleanTarget);
    acc.friendRequestsOut = (acc.friendRequestsOut || []).filter(x => x !== cleanTarget);
    const otherAcc = db.accounts[cleanTarget];
    if (otherAcc) otherAcc.friends = (otherAcc.friends || []).filter(x => x !== acc.id);
    scheduleSaveDB();
    pushFriendsUpdate(acc.id);
    if (otherAcc) pushFriendsUpdate(cleanTarget);
    if (typeof cb === 'function') cb({ ok: true, account: publicAccountPayload(acc), friendsData: buildFriendsPayload(acc) });
  });

  socket.on('unblockPlayer', ({ accountId, targetId }, cb) => {
    const acc = getOrCreateAccount(accountId || socket.accountId);
    const cleanTarget = String(targetId || '').trim();
    acc.blocked = (acc.blocked || []).filter(x => x !== cleanTarget);
    scheduleSaveDB();
    if (typeof cb === 'function') cb({ ok: true, account: publicAccountPayload(acc) });
  });

  socket.on('reportPlayer', ({ accountId, targetId, reason }, cb) => {
    if (!allowRate('rep_' + socket.id, 3, 5)) return cb && cb({ ok: false, error: 'Слишком много жалоб' });
    const acc = getOrCreateAccount(accountId || socket.accountId);
    const cleanTarget = String(targetId || '').trim();
    const cleanReason = sanitize(reason || 'Неспортивное поведение', 'Жалоба').slice(0, 80);
    if (!cleanTarget || cleanTarget === acc.id) return cb && cb({ ok: false, error: 'Некорректный игрок' });
    logAdminAction(acc.id, 'PLAYER_REPORT', { reporter: acc.nick, targetId: cleanTarget, reason: cleanReason });
    if (typeof cb === 'function') cb({ ok: true });
  });

  // Invite friend to private room (creates room automatically if not in one)
  socket.on('inviteFriendToMatch', ({ accountId, friendId, name, color, number, skin, ballSkin, celebration, isLandscape }, cb) => {
    if (!allowRate('inv_' + socket.id, 4, 6)) return cb && cb({ ok: false, error: 'Слишком много приглашений' });
    const acc = getOrCreateAccount(accountId || socket.accountId, name);
    socket.accountId = acc.id;
    const cleanFriend = String(friendId || '').trim();
    if (!(acc.friends || []).includes(cleanFriend)) {
      return cb && cb({ ok: false, error: 'Игрок не в вашем списке друзей' });
    }
    const targetSockets = getSocketsByAccountId(cleanFriend);
    if (!targetSockets.length) {
      return cb && cb({ ok: false, error: 'Друг сейчас не в сети' });
    }

    let room = (socket.roomId && rooms[socket.roomId]) ? rooms[socket.roomId] : null;
    if (!room || !room.isPrivate) {
      const id = genRoomId('PRV_');
      const code = genInviteCode();
      room = {
        id,
        isPrivate: true,
        inviteCode: code,
        allowedAccounts: new Set([acc.id, cleanFriend]),
        players: {}, inputs: {}, lastSeq: {},
        lastToucher: null, prevToucher: null,
        loop: null, loopRunning: false, host: socket.id,
        started: false, countingDown: false, countdownTimer: null,
        settings: {
          arena: 'classic', mode: 'classic', matchDuration: 120,
          weather: 'clear', ballSkin: acc.ownedBallSkins.includes(ballSkin) ? ballSkin : 'classic',
          teamSize: 2, arenaColor: '#24662c'
        }
      };
      rooms[id] = room;
      privateRooms[code] = id;
      attachPlayerToRoom(socket, room, { acc, name, color, number, skin, ballSkin, celebration, isLandscape, preferredTeam: 'red' });
    } else {
      room.allowedAccounts = room.allowedAccounts || new Set([acc.id]);
      room.allowedAccounts.add(cleanFriend);
    }

    const inviteId = 'INV_' + crypto.randomBytes(5).toString('hex');
    matchInvites[inviteId] = {
      id: inviteId,
      fromAccountId: acc.id,
      fromNick: acc.nick,
      toAccountId: cleanFriend,
      roomId: room.id,
      inviteCode: room.inviteCode,
      createdAt: Date.now()
    };

    for (const ts of targetSockets) {
      ts.emit('matchInviteReceived', {
        inviteId,
        fromId: acc.id,
        fromNick: acc.nick,
        roomId: room.id,
        inviteCode: room.inviteCode
      });
    }

    if (typeof cb === 'function') {
      cb({
        ok: true,
        roomId: room.id,
        inviteCode: room.inviteCode,
        players: getPlayersPublic(room),
        host: room.host,
        settings: room.settings
      });
    }
  });

  socket.on('respondMatchInvite', ({ inviteId, accept }, cb) => {
    const inv = matchInvites[inviteId];
    if (!inv) return cb && cb({ ok: false, error: 'Приглашение устарело' });
    delete matchInvites[inviteId];
    const fromSockets = getSocketsByAccountId(inv.fromAccountId);
    for (const fs of fromSockets) {
      fs.emit('matchInviteResponse', { inviteId, accepted: Boolean(accept), byAccountId: socket.accountId });
    }
    if (typeof cb === 'function') cb({ ok: true, invite: inv });
  });

  // Season pass & quests
  socket.on('claimSeasonReward', ({ accountId, kind, key }, cb) => {
    const acc = getOrCreateAccount(accountId || socket.accountId);
    if (kind === 'tier') {
      const tier = parseInt(key, 10);
      const reqXp = tier * 200;
      if (!tier || tier < 1 || tier > 10 || (acc.season.xp || 0) < reqXp) {
        return cb && cb({ ok: false, error: 'Недостаточно сезонного опыта' });
      }
      if (acc.season.claimedTiers.includes(tier)) {
        return cb && cb({ ok: false, error: 'Награда уже получена' });
      }
      acc.season.claimedTiers.push(tier);
      const rewardCoins = tier * 100;
      acc.coins += rewardCoins;
      scheduleSaveDB();
      return cb && cb({ ok: true, rewardCoins, account: publicAccountPayload(acc) });
    } else if (kind === 'quest') {
      const qKey = String(key || '');
      const targets = { goals: 5, passes: 15, wins: 2 };
      const rewards = { goals: 120, passes: 90, wins: 150 };
      if (!targets[qKey]) return cb && cb({ ok: false, error: 'Задание не найдено' });
      if (acc.season.quests.claimed[qKey]) return cb && cb({ ok: false, error: 'Задание уже выполнено' });
      if ((acc.season.quests[qKey] || 0) < targets[qKey]) {
        return cb && cb({ ok: false, error: 'Задание ещё не выполнено' });
      }
      acc.season.quests.claimed[qKey] = true;
      const rewardCoins = rewards[qKey];
      acc.coins += rewardCoins;
      scheduleSaveDB();
      return cb && cb({ ok: true, rewardCoins, account: publicAccountPayload(acc) });
    }
    if (cb) cb({ ok: false, error: 'Неверный запрос' });
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

    if (!newReady && room.countingDown && !room.started) {
      room.countingDown = false;
      if (room.countdownTimer) {
        clearTimeout(room.countdownTimer);
        room.countdownTimer = null;
      }
      io.to(roomId).emit('countdownCancelled', { reason: `${p.name} повернул экран вертикально` });
    }

    emitRoomState(room);
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
    const maxPerTeam = room.settings.teamSize || 2;
    if (targetTeam !== 'spec') {
      const count = Object.values(room.players).filter(x => x.team === targetTeam && x !== p).length;
      if (count >= maxPerTeam) return;
    }
    p.team = targetTeam;
    emitRoomState(room);
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
    if (settings.teamSize) {
      const sz = parseInt(settings.teamSize, 10);
      if ([1, 2].includes(sz)) {
        room.settings.teamSize = sz;
        autoBalanceRoom(room);
      }
    }
    if (settings.weather && WEATHERS[settings.weather]) room.settings.weather = settings.weather;
    if (settings.ballSkin && BALL_SKIN_CATALOG[settings.ballSkin]) room.settings.ballSkin = settings.ballSkin;
    if (settings.arenaColor && /^#[0-9a-fA-F]{6}$/.test(settings.arenaColor)) room.settings.arenaColor = settings.arenaColor;
    emitRoomState(room);
  });

  socket.on('input', (data) => {
    if (!data || typeof data !== 'object') return;
    const roomId = socket.roomId;
    if (!roomId || !rooms[roomId]) return;
    const inp = rooms[roomId].inputs[socket.id];
    if (!inp) return;
    let x = Number(data.x), y = Number(data.y);
    if (!Number.isFinite(x)) x = 0;
    if (!Number.isFinite(y)) y = 0;
    const l = Math.hypot(x, y);
    if (l < 0.05) { x = 0; y = 0; }
    else if (l > 1) { x /= l; y /= l; }
    inp.x = x; inp.y = y;
    if (data.seq !== undefined && Number.isFinite(Number(data.seq))) {
      rooms[roomId].lastSeq[socket.id] = Number(data.seq);
    }
  });

  socket.on('action', (payload) => {
    if (!payload || typeof payload !== 'object') return;
    if (!allowRate('act_' + socket.id, 14, 20)) return;
    const { type, dirX, dirY, power, curveSign } = payload;
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
      const rawP = Number(power);
      const powerLevel = Number.isFinite(rawP) ? Math.max(0.25, Math.min(1, rawP)) : 1;
      applyShot(room, p, socket.id, bestB, type, dirX || 0, dirY || 0, powerLevel, Number(curveSign) || 0);
    }
  });

  socket.on('emote', (em) => {
    if (!allowRate('em_' + socket.id, 3, 5)) return;
    const roomId = socket.roomId;
    if (!roomId || !rooms[roomId] || !rooms[roomId].players[socket.id]) return;
    io.to(roomId).emit('emote', { id: socket.id, em: String(em || '').slice(0, 4) });
  });

  socket.on('chat', (msg) => {
    if (!allowRate('ch_' + socket.id, 4, 6)) return;
    const roomId = socket.roomId;
    if (!roomId || !rooms[roomId]) return;
    const p = rooms[roomId].players[socket.id];
    if (!p) return;
    const cleanMsg = String(msg || '').replace(/[<>]/g, '').trim().slice(0, 100);
    if (!cleanMsg) return;
    io.to(roomId).emit('chat', { name: p.name, msg: cleanMsg });
  });

  socket.on('rematch', () => {
    const roomId = socket.roomId;
    if (!roomId || !rooms[roomId]) return;
    const room = rooms[roomId];
    emitRoomState(room);
    triggerMatchStartSequence(room);
  });

  // ==== ECONOMY, SHOP & PROMOCODES ====
  socket.on('buySkin', ({ accountId, category, skinId }, cb) => {
    if (!allowRate('shop_' + socket.id, 5, 8)) return cb && cb({ ok: false, error: 'Слишком много запросов' });
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
    const safeOutcome = ['win', 'draw', 'loss'].includes(outcome) ? outcome : 'loss';
    const res = awardMatchRewards(acc, { outcome: safeOutcome, goals, assists, shots, passes, matchId: safeMatchId });
    if (cb) cb({ ok: true, ...res });
  });

  socket.on('redeemPromo', ({ accountId, code }, cb) => {
    if (!allowRate('promo_' + socket.id, 4, 6)) return cb && cb({ ok: false, error: 'Подождите перед следующей попыткой' });
    const acc = getOrCreateAccount(accountId || socket.accountId);
    const rawCode = String(code || '').trim();
    if (!rawCode) return cb && cb({ ok: false, error: 'Введите промокод' });

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

  // ==== ADMIN ENDPOINTS ====
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
      cb({ ok: true, players: playersList, promos: db.promos, logs: db.adminLogs.slice(-50).reverse() });
    }
  });

  socket.on('adminUpdatePlayer', ({ targetId, action, amount, skinCategory, skinId }, cb) => {
    if (!requireAdmin(cb)) return;
    const acc = db.accounts[targetId];
    if (!acc) return cb && cb({ ok: false, error: 'Игрок не найден' });
    const val = parseInt(amount, 10) || 0;

    if (action === 'addCoins') acc.coins = Math.max(0, acc.coins + val);
    else if (action === 'subCoins') acc.coins = Math.max(0, acc.coins - Math.abs(val));
    else if (action === 'setCoins') acc.coins = Math.max(0, val);
    else if (action === 'addWins') acc.wins = Math.max(0, acc.wins + val);
    else if (action === 'setWins') acc.wins = Math.max(0, val);
    else if (action === 'addGoals') acc.goals = Math.max(0, acc.goals + val);
    else if (action === 'setGoals') acc.goals = Math.max(0, val);
    else if (action === 'setMatches') acc.matches = Math.max(0, val);
    else if (action === 'grantSkin') {
      if (skinCategory === 'ball' && BALL_SKIN_CATALOG[skinId]) {
        if (!acc.ownedBallSkins.includes(skinId)) acc.ownedBallSkins.push(skinId);
      } else if (PLAYER_SKIN_CATALOG[skinId]) {
        if (!acc.ownedSkins.includes(skinId)) acc.ownedSkins.push(skinId);
      }
    } else return cb && cb({ ok: false, error: 'Неизвестное действие' });

    logAdminAction(socket.accountId, `PLAYER_${action.toUpperCase()}`, { targetId, nick: acc.nick, amount: val, skinCategory, skinId });
    scheduleSaveDB();

    for (const s of getSocketsByAccountId(targetId)) {
      s.emit('accountSynced', publicAccountPayload(acc));
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

    db.promos[cleanCode] = { type: promoType, value: promoVal, maxUses: limit, usedCount: 0, active: true };
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
    rateBuckets.delete('find_' + socket.id);
    rateBuckets.delete('priv_' + socket.id);
    rateBuckets.delete('join_priv_' + socket.id);
    rateBuckets.delete('fr_' + socket.id);
    rateBuckets.delete('rep_' + socket.id);
    rateBuckets.delete('inv_' + socket.id);
    rateBuckets.delete('act_' + socket.id);
    rateBuckets.delete('em_' + socket.id);
    rateBuckets.delete('ch_' + socket.id);
    rateBuckets.delete('shop_' + socket.id);
    rateBuckets.delete('promo_' + socket.id);

    const accId = socket.accountId;
    const roomId = socket.roomId;

    if (roomId && rooms[roomId]) {
      const room = rooms[roomId];
      const departingPlayer = room.players[socket.id];

      // Save reconnect snapshot if match is active
      if (departingPlayer && accId && room.started && departingPlayer.team !== 'spec') {
        const key = `${accId}:${roomId}`;
        if (disconnectedSessions[key]) clearTimeout(disconnectedSessions[key].timeout);
        const timer = setTimeout(() => {
          delete disconnectedSessions[key];
        }, 60000);
        disconnectedSessions[key] = {
          roomId,
          accountId: accId,
          playerSnapshot: { ...departingPlayer },
          disconnectedAt: Date.now(),
          timeout: timer
        };
      }

      for (const b of (room.balls || [])) { if (b.ownerId === socket.id) b.ownerId = null; }
      delete room.players[socket.id];
      delete room.inputs[socket.id];
      delete room.lastSeq[socket.id];

      if (Object.keys(room.players).length === 0) {
        if (room.loop) clearInterval(room.loop);
        if (room.countdownTimer) clearTimeout(room.countdownTimer);
        if (room.inviteCode && privateRooms[room.inviteCode] === roomId) {
          delete privateRooms[room.inviteCode];
        }
        delete rooms[roomId];
      } else {
        if (room.host === socket.id) room.host = Object.keys(room.players)[0];
        if (room.isPrivate) autoBalanceRoom(room);
        emitRoomState(room);
        io.to(roomId).emit('playerLeft', socket.id);
      }
    }

    if (accId && db.accounts[accId]) {
      const acc = db.accounts[accId];
      acc.lastSeen = Date.now();
      for (const fid of (acc.friends || [])) {
        pushFriendsUpdate(fid);
      }
    }
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log('Ball Brawl Pro v10 on port ' + PORT));
