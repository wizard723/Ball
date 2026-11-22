const express = require('express');
const http = require('http');
const path = require('path');
const fs = require('fs');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' }, pingTimeout: 20000, pingInterval: 10000 });

const publicDir = path.join(__dirname, 'public');
if (fs.existsSync(publicDir)) {
  app.use(express.static(publicDir));
}
app.use(express.static(__dirname));
app.get('/', (req, res) => {
  const pubIndex = path.join(publicDir, 'index.html');
  res.sendFile(fs.existsSync(pubIndex) ? pubIndex : path.join(__dirname, 'index.html'));
});

const PLAYER_R = 30, BALL_R = 20;
const PLAYER_MAX = 390, DASH_IMPULSE = 670, PLAYER_ACCEL = 1420;
const FRICTION = 0.965, BOUNCE = 0.80;
const KICK_MAX = 1020, PASS_MAX = 690, LOB_MAX = 780;
const DASH_CD = 1.65, TACKLE_CD = 1.75;
const DRIBBLE_DIST = PLAYER_R + BALL_R + 4;
const SERVER_TICK = 60, SYNC_RATE = 30, MAX_PLAYERS = 6;

const ARENAS = {
  classic:   { w: 1800, h: 1100, obstacles: [] },
  ice:       { w: 1800, h: 1100, obstacles: [] },
  obstacles: {
    w: 1900, h: 1200,
    obstacles: [
      { x: -300, y: -200, w: 100, h: 60 },
      { x: 300, y: 200, w: 100, h: 60 },
      { x: 0, y: 0, w: 80, h: 80 }
    ]
  },
  narrow:    { w: 2400, h: 800, obstacles: [] }
};
const MODES = {
  classic: { goals: 5 },
  time: { duration: 120 },
  golden: { goals: 1 },
  chaos: { goals: 5 },
  penalty: { goals: 5 }
};
const WEATHERS = { clear: 1, rain: 0.94, night: 1, fog: 1 };

const rooms = {};

function genCode() {
  const c = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let s = '';
  for (let i = 0; i < 5; i++) s += c[Math.floor(Math.random() * c.length)];
  return rooms[s] ? genCode() : s;
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
  return { minX: -a.w / 2, maxX: a.w / 2, minY: -a.h / 2, maxY: a.h / 2, w: a.w, h: a.h, obstacles: a.obstacles || [] };
}

function createBall(x = 0, y = 0) {
  return {
    x, y, prevX: x, prevY: y, z: 0, vz: 0,
    vx: 0, vy: 0, curve: 0, powerGlow: 0,
    ownerId: null, lastTeam: null,
    touchHistory: [], goalScored: false
  };
}

function recordTouch(room, b, playerId) {
  const p = room.players[playerId];
  if (!p) return;
  b.lastTeam = p.team;
  room.lastToucher = playerId;
  const hist = b.touchHistory;
  const last = hist[hist.length - 1];
  const now = Date.now();
  if (!last || last.id !== playerId) {
    hist.push({ id: playerId, name: p.name, team: p.team, time: now });
    if (hist.length > 4) hist.shift();
  } else {
    last.time = now;
  }
}

function ensurePlayerStats(room, id) {
  const p = room.players[id];
  if (!p) return null;
  if (!room.playerStats[id]) {
    room.playerStats[id] = {
      id, name: p.name, team: p.team, color: p.color, number: p.number,
      goals: 0, assists: 0, ownGoals: 0, shots: 0, passes: 0, tackles: 0, saves: 0, touches: 0
    };
  }
  return room.playerStats[id];
}

function resetPositions(room) {
  const ids = Object.keys(room.players);
  const reds = ids.filter(id => room.players[id].team === 'red');
  const blues = ids.filter(id => room.players[id].team === 'blue');
  const bd = arenaBounds(room);

  reds.forEach((id, i) => {
    const p = room.players[id];
    const spread = reds.length === 1 ? 0 : (i - (reds.length - 1) / 2) * 95;
    p.x = bd.minX + 160; p.y = spread; p.vx = 0; p.vy = 0; p.facing = 0;
    p.pickupLock = 0; p.dashTimer = 0; p.stamina = 100;
  });
  blues.forEach((id, i) => {
    const p = room.players[id];
    const spread = blues.length === 1 ? 0 : (i - (blues.length - 1) / 2) * 95;
    p.x = bd.maxX - 160; p.y = spread; p.vx = 0; p.vy = 0; p.facing = Math.PI;
    p.pickupLock = 0; p.dashTimer = 0; p.stamina = 100;
  });

  room.balls = [createBall(0, 0)];
  if (room.settings.mode === 'chaos') {
    room.balls.push(createBall(0, -210));
    room.balls.push(createBall(0, 210));
  }
  if (room.settings.mode === 'penalty') {
    room.balls = [createBall(-bd.w / 2 + 320, 0)];
  }
  room.lastToucher = null;
  room.goalLock = false;
}

function getPlayersPublic(room) {
  return Object.entries(room.players).map(([id, p]) => ({
    id, name: p.name, color: p.color, team: p.team, number: p.number, skin: p.skin
  }));
}

function resolveCircleObstacle(obj, r, obs, bounce) {
  const halfW = obs.w / 2, halfH = obs.h / 2;
  const closestX = Math.max(obs.x - halfW, Math.min(obj.x, obs.x + halfW));
  const closestY = Math.max(obs.y - halfH, Math.min(obj.y, obs.y + halfH));
  const dx = obj.x - closestX, dy = obj.y - closestY;
  const distSq = dx * dx + dy * dy;
  if (distSq < r * r) {
    const dist = Math.sqrt(distSq) || 0.001;
    const nx = dx / dist, ny = dy / dist;
    const overlap = r - dist;
    obj.x += nx * overlap;
    obj.y += ny * overlap;
    const vn = obj.vx * nx + obj.vy * ny;
    if (vn < 0) {
      obj.vx -= (1 + bounce) * vn * nx;
      obj.vy -= (1 + bounce) * vn * ny;
    }
    return true;
  }
  return false;
}

function segmentIntersectsGoal(x1, y1, x2, y2, goalX, goalHalfH) {
  if ((x1 <= goalX && x2 > goalX) || (x1 >= goalX && x2 < goalX)) {
    const t = Math.abs(x2 - x1) < 1e-6 ? 1 : (goalX - x1) / (x2 - x1);
    const hitY = y1 + (y2 - y1) * Math.max(0, Math.min(1, t));
    if (Math.abs(hitY) <= goalHalfH) return { hit: true, y: hitY };
  }
  return { hit: false, y: y2 };
}

function applyShot(room, p, playerId, b, kind, dirX, dirY, powerLevel, curveHint = 0) {
  b.ownerId = null;
  p.pickupLock = 0.22;
  const pst = ensurePlayerStats(room, playerId);
  if (pst) pst.touches++;

  const speedBonus = 1 + Math.min(0.28, Math.hypot(p.vx, p.vy) / 800);
  const maxImp = kind === 'kick' ? KICK_MAX : (kind === 'lob' ? LOB_MAX : PASS_MAX);
  const imp = maxImp * powerLevel * speedBonus;

  let dx = dirX, dy = dirY;
  const inp = room.inputs[playerId] || { x: 0, y: 0 };
  if (Math.hypot(dx, dy) < 0.1) {
    if (Math.hypot(inp.x, inp.y) > 0.1) { dx = inp.x; dy = inp.y; }
    else { dx = Math.cos(p.facing || 0); dy = Math.sin(p.facing || 0); }
  }
  const l = Math.hypot(dx, dy) || 1;
  const nx = dx / l, ny = dy / l;

  b.prevX = b.x;
  b.prevY = b.y;
  b.x = p.x + nx * (PLAYER_R + BALL_R + 6);
  b.y = p.y + ny * (PLAYER_R + BALL_R + 6);
  b.vx = nx * imp;
  b.vy = ny * imp;

  if (kind === 'lob') {
    b.z = Math.max(b.z, 4);
    b.vz = 360 + 220 * powerLevel;
  } else if (kind === 'kick' && powerLevel > 0.72) {
    b.z = Math.max(b.z, 2);
    b.vz = 140 * powerLevel;
  } else {
    b.vz = Math.max(b.vz, 0);
  }

  const moveCross = (p.vx * ny - p.vy * nx) / 420;
  const rawSpin = Math.abs(curveHint) > 0.05 ? curveHint : moveCross;
  const spin = kind === 'kick' ? rawSpin * 280 * powerLevel : (kind === 'pass' ? rawSpin * 95 * powerLevel : 0);
  b.curve = Math.max(-340, Math.min(340, spin));
  b.powerGlow = Math.min(1, powerLevel * speedBonus);
  recordTouch(room, b, playerId);

  if (p.team === 'red' || p.team === 'blue') {
    if (kind === 'kick' || kind === 'lob') {
      room.stats.shots[p.team]++;
      if (pst) pst.shots++;
    }
    if (kind === 'pass') {
      room.stats.passes[p.team]++;
      if (pst) pst.passes++;
    }
  }

  io.to(room.code).emit('ballImpact', { x: b.x, y: b.y, power: powerLevel, kind });
  if (imp > 660) {
    io.to(room.code).emit('screenShake', { intensity: Math.min(13, (imp - 600) / 36) });
  }
}

function startRoomLoop(code) {
  const room = rooms[code];
  if (!room || room.loop) return;
  room.code = code;
  room.loopRunning = true;
  room.lastTick = Date.now();
  room.syncTick = 0;
  room.score = { red: 0, blue: 0 };
  room.combo = { red: 0, blue: 0 };
  room.playerStats = {};
  for (const id in room.players) {
    if (room.players[id].team !== 'spec') ensurePlayerStats(room, id);
  }
  room.stats = { shots: { red: 0, blue: 0 }, passes: { red: 0, blue: 0 }, possTicks: { red: 0, blue: 0 }, totalTicks: 0 };
  room.startTime = Date.now();
  room.mode = room.settings.mode || 'classic';
  const customDur = Number(room.settings.duration) || MODES[room.mode]?.duration || 120;
  room.timeLeft = room.mode === 'time' ? customDur : 0;
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
      if (room.timeLeft <= 0) { finishMatch(room, code); return; }
    }

    for (const id in room.players) {
      const p = room.players[id];
      if (p.team === 'spec') continue;
      if (p.stamina === undefined) p.stamina = 100;

      const inp = room.inputs[id] || { x: 0, y: 0 };
      const moving = Math.hypot(inp.x, inp.y) > 0.06;
      if (moving) p.facing = Math.atan2(inp.y, inp.x);

      const staminaFactor = p.stamina < 18 ? 0.80 : (p.stamina < 40 ? 0.91 : 1.0);
      const maxSpd = PLAYER_MAX * staminaFactor;

      if ((p.dashTimer || 0) <= 0) {
        p.vx += inp.x * PLAYER_ACCEL * dt;
        p.vy += inp.y * PLAYER_ACCEL * dt;
      }

      if (!moving && (p.dashTimer || 0) <= 0) {
        const f = Math.pow(iceFriction * weatherFriction, dt * 60);
        p.vx *= f; p.vy *= f;
        if (Math.hypot(p.vx, p.vy) < 6) { p.vx = 0; p.vy = 0; }
        p.stamina = Math.min(100, p.stamina + 26 * dt);
      } else if ((p.dashTimer || 0) <= 0) {
        const sp = Math.hypot(p.vx, p.vy);
        if (sp > maxSpd) {
          p.vx = p.vx / sp * maxSpd;
          p.vy = p.vy / sp * maxSpd;
        }
        p.stamina = Math.min(100, p.stamina + 11 * dt);
      }

      p.x += p.vx * dt; p.y += p.vy * dt;
      for (const obs of bd.obstacles) resolveCircleObstacle(p, PLAYER_R, obs, 0.5);

      if (p.dashCd > 0) p.dashCd = Math.max(0, p.dashCd - dt);
      if (p.dashTimer > 0) p.dashTimer = Math.max(0, p.dashTimer - dt);
      if (p.tackleCd > 0) p.tackleCd = Math.max(0, p.tackleCd - dt);
      if (p.pickupLock > 0) p.pickupLock = Math.max(0, p.pickupLock - dt);
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
            const imp = -sepVel * 0.68;
            a.vx -= nx * imp; a.vy -= ny * imp;
            c.vx += nx * imp; c.vy += ny * imp;
          }
        }
      }
    }

    room.stats.totalTicks++;
    for (const b of room.balls) {
      b.prevX = b.x;
      b.prevY = b.y;

      if (b.z > 0 || b.vz !== 0) {
        b.vz -= 980 * dt;
        b.z += b.vz * dt;
        if (b.z <= 0) {
          b.z = 0;
          if (Math.abs(b.vz) > 95) {
            b.vz = -b.vz * 0.55;
            b.vx *= 0.92;
            b.vy *= 0.92;
          } else {
            b.vz = 0;
          }
        }
      }

      if (b.ownerId && room.players[b.ownerId] && room.players[b.ownerId].team !== 'spec') {
        const owner = room.players[b.ownerId];
        const ang = owner.facing || 0;
        b.x = owner.x + Math.cos(ang) * DRIBBLE_DIST;
        b.y = owner.y + Math.sin(ang) * DRIBBLE_DIST;
        b.vx = owner.vx;
        b.vy = owner.vy;
        b.z = 0;
        b.vz = 0;
        b.curve = 0;
        b.powerGlow = 0;
        recordTouch(room, b, b.ownerId);
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

        const airDrag = b.z > 8 ? 0.993 : 0.986;
        const bf = Math.pow(airDrag, dt * 60);
        b.vx *= bf; b.vy *= bf;
        b.x += b.vx * dt; b.y += b.vy * dt;

        if (b.z < 36) {
          for (const obs of bd.obstacles) resolveCircleObstacle(b, BALL_R, obs, BOUNCE);
        }

        for (const id of activeIds) {
          const p = room.players[id];
          if (p.pickupLock > 0 || b.z > 34) continue;
          const d = Math.hypot(b.x - p.x, b.y - p.y);
          if (d <= PLAYER_R + BALL_R + 5) {
            const ballSpd = Math.hypot(b.vx, b.vy);
            const pst = ensurePlayerStats(room, id);
            if (ballSpd > 380 && b.lastTeam && b.lastTeam !== p.team) {
              const nx = (b.x - p.x) / (d || 1), ny = (b.y - p.y) / (d || 1);
              b.x = p.x + nx * (PLAYER_R + BALL_R + 3);
              b.y = p.y + ny * (PLAYER_R + BALL_R + 3);
              b.vx = nx * ballSpd * 0.52 + p.vx * 0.45;
              b.vy = ny * ballSpd * 0.52 + p.vy * 0.45;
              p.pickupLock = 0.14;
              recordTouch(room, b, id);
              if (pst) { pst.touches++; if (Math.abs(p.x) > bd.w * 0.34) pst.saves++; }
              io.to(room.code).emit('ballImpact', { x: b.x, y: b.y, power: 0.6, kind: 'deflect' });
            } else {
              b.ownerId = id;
              recordTouch(room, b, id);
              if (pst) pst.touches++;
            }
            break;
          }
        }
      }
    }

    function boundRect(o, r) {
      if (o.x < bd.minX + r) { o.x = bd.minX + r; o.vx = Math.abs(o.vx) * BOUNCE; }
      if (o.x > bd.maxX - r) { o.x = bd.maxX - r; o.vx = -Math.abs(o.vx) * BOUNCE; }
      if (o.y < bd.minY + r) { o.y = bd.minY + r; o.vy = Math.abs(o.vy) * BOUNCE; }
      if (o.y > bd.maxY - r) { o.y = bd.maxY - r; o.vy = -Math.abs(o.vy) * BOUNCE; }
    }
    for (const id of activeIds) boundRect(room.players[id], PLAYER_R);

    const goalHalfH = (bd.h * 0.3) / 2;
    for (let bi = 0; bi < room.balls.length; bi++) {
      const b = room.balls[bi];
      if (b.goalScored || room.goalLock) continue;

      if (b.y < bd.minY + BALL_R) { b.y = bd.minY + BALL_R; b.vy = Math.abs(b.vy) * BOUNCE; }
      if (b.y > bd.maxY - BALL_R) { b.y = bd.maxY - BALL_R; b.vy = -Math.abs(b.vy) * BOUNCE; }

      const leftLine = bd.minX - BALL_R * 0.35;
      const rightLine = bd.maxX + BALL_R * 0.35;
      const crossL = segmentIntersectsGoal(b.prevX, b.prevY, b.x, b.y, leftLine, goalHalfH);
      const crossR = segmentIntersectsGoal(b.prevX, b.prevY, b.x, b.y, rightLine, goalHalfH);
      const inGoalY = Math.abs(b.y) <= goalHalfH;
      const validHeight = (b.z || 0) <= 68;

      const escapedLeft = validHeight && ((b.x < leftLine && inGoalY) || crossL.hit);
      const escapedRight = validHeight && ((b.x > rightLine && inGoalY) || crossR.hit);

      if (!escapedLeft && !escapedRight) {
        if (b.x < bd.minX + BALL_R) { b.x = bd.minX + BALL_R; b.vx = Math.abs(b.vx) * BOUNCE; }
        if (b.x > bd.maxX - BALL_R) { b.x = bd.maxX - BALL_R; b.vx = -Math.abs(b.vx) * BOUNCE; }
        continue;
      }

      b.goalScored = true;
      room.goalLock = true;

      const scoringTeam = escapedLeft ? 'blue' : 'red';
      const hist = b.touchHistory || [];
      const lastTouch = hist[hist.length - 1] || (room.lastToucher && room.players[room.lastToucher]
        ? { id: room.lastToucher, name: room.players[room.lastToucher].name, team: room.players[room.lastToucher].team }
        : null);

      const isOwnGoal = Boolean(lastTouch && lastTouch.team !== scoringTeam);
      let assistTouch = null;
      if (!isOwnGoal && lastTouch) {
        for (let hi = hist.length - 2; hi >= 0; hi--) {
          if (hist[hi].team === scoringTeam && hist[hi].id !== lastTouch.id) {
            assistTouch = hist[hi];
            break;
          }
        }
      }

      if (lastTouch) {
        const scorerSt = ensurePlayerStats(room, lastTouch.id);
        if (scorerSt) {
          if (isOwnGoal) scorerSt.ownGoals++;
          else scorerSt.goals++;
        }
      }
      if (assistTouch) {
        const assistSt = ensurePlayerStats(room, assistTouch.id);
        if (assistSt) assistSt.assists++;
      }

      const scorerName = lastTouch ? (isOwnGoal ? `${lastTouch.name} (Автогол)` : lastTouch.name) : 'Гол';
      const assistName = assistTouch ? assistTouch.name : '';

      room.score[scoringTeam]++;
      room.combo[scoringTeam]++;

      const comboLbl = room.combo[scoringTeam] >= 4 ? 'ОГОНЬ!' :
                       room.combo[scoringTeam] === 3 ? 'ХЕТ-ТРИК!' :
                       room.combo[scoringTeam] === 2 ? 'ДУБЛЬ!' : '';

      io.to(code).emit('goal', {
        team: scoringTeam,
        red: room.score.red,
        blue: room.score.blue,
        scorerId: lastTouch ? lastTouch.id : null,
        scorerName,
        assistId: assistTouch ? assistTouch.id : null,
        assistName,
        isOwnGoal,
        combo: comboLbl,
        playerStats: Object.values(room.playerStats)
      });

      const otherTeam = scoringTeam === 'red' ? 'blue' : 'red';
      room.combo[otherTeam] = 0;

      const goalLimit = MODES[room.mode]?.goals || 5;
      if (room.score[scoringTeam] >= goalLimit) { finishMatch(room, code); return; }
      resetPositions(room);
      break;
    }

    room.syncTick++;
    const every = Math.max(1, Math.round(SERVER_TICK / SYNC_RATE));
    if (room.syncTick >= every) {
      room.syncTick = 0;
      const snap = {
        balls: room.balls.map(b => ({
          x: b.x, y: b.y, z: b.z || 0, vx: b.vx, vy: b.vy,
          curve: b.curve, powerGlow: b.powerGlow, ownerId: b.ownerId
        })),
        players: {},
        timeLeft: room.timeLeft,
        stats: room.stats
      };
      for (const id of activeIds) {
        const p = room.players[id];
        snap.players[id] = {
          x: p.x, y: p.y, vx: p.vx, vy: p.vy, facing: p.facing,
          stamina: Math.round(p.stamina ?? 100),
          dashCd: p.dashCd, tackleCd: p.tackleCd, dashTimer: p.dashTimer,
          lastSeq: room.lastSeq[id] || 0
        };
      }
      io.to(code).volatile.emit('state', snap);
    }
  }, 1000 / SERVER_TICK);
}

function finishMatch(room, code) {
  if (room.loop) clearInterval(room.loop);
  room.loop = null;
  room.loopRunning = false;
  room.started = false;
  let winner = 'draw';
  if (room.score.red > room.score.blue) winner = 'red';
  else if (room.score.blue > room.score.red) winner = 'blue';
  io.to(code).emit('matchEnd', {
    winner,
    red: room.score.red,
    blue: room.score.blue,
    stats: room.stats,
    playerStats: Object.values(room.playerStats || {})
  });
}

io.on('connection', (socket) => {
  socket.on('pingCheck', (ts, cb) => { if (typeof cb === 'function') cb(ts); });

  socket.on('createRoom', ({ name, color, number, skin, ballSkin, arenaColor }, cb) => {
    const code = genCode();
    rooms[code] = {
      players: {}, inputs: {}, lastSeq: {}, teamHistory: {}, lastToucher: null,
      loop: null, loopRunning: false, host: socket.id, started: false,
      settings: { arena: 'classic', mode: 'classic', duration: 120, weather: 'clear', ballSkin: ballSkin || 'classic', arenaColor: arenaColor || '#2a6d2a' }
    };
    const room = rooms[code];
    const cleanName = sanitize(name);
    room.teamHistory[cleanName] = 'red';
    room.players[socket.id] = {
      name: cleanName, color: sanitizeColor(color), number: sanitizeNum(number),
      skin: sanitize(skin || 'plain').slice(0, 10),
      team: 'red', x: 0, y: 0, vx: 0, vy: 0, facing: 0, stamina: 100,
      dashCd: 0, tackleCd: 0, dashTimer: 0, pickupLock: 0
    };
    room.inputs[socket.id] = { x: 0, y: 0 };
    socket.join(code);
    socket.roomCode = code;
    cb({ ok: true, code, players: getPlayersPublic(room), host: socket.id, settings: room.settings });
  });

  socket.on('joinRoom', ({ code, name, color, number, skin, spectator }, cb) => {
    code = (code || '').toUpperCase().trim();
    if (!rooms[code]) return cb({ ok: false, error: 'Комната не найдена' });
    const room = rooms[code];
    if (Object.keys(room.players).length >= MAX_PLAYERS) return cb({ ok: false, error: 'Комната заполнена' });

    const cleanName = sanitize(name);
    let team = spectator ? 'spec' : (room.teamHistory[cleanName] || assignTeams(room));
    if (room.started && team !== 'spec') team = 'spec';
    if (team !== 'spec') room.teamHistory[cleanName] = team;

    room.players[socket.id] = {
      name: cleanName, color: sanitizeColor(color), number: sanitizeNum(number),
      skin: sanitize(skin || 'plain').slice(0, 10),
      team, x: 0, y: 0, vx: 0, vy: 0, facing: 0, stamina: 100,
      dashCd: 0, tackleCd: 0, dashTimer: 0, pickupLock: 0
    };
    room.inputs[socket.id] = { x: 0, y: 0 };
    socket.join(code);
    socket.roomCode = code;

    io.to(code).emit('lobbyUpdate', { players: getPlayersPublic(room), host: room.host, settings: room.settings });
    cb({ ok: true, code, players: getPlayersPublic(room), host: room.host, settings: room.settings, started: room.started });
  });

  socket.on('switchTeam', (targetTeam) => {
    const code = socket.roomCode;
    if (!code || !rooms[code] || rooms[code].started) return;
    const room = rooms[code];
    const p = room.players[socket.id];
    if (!p || !['red', 'blue', 'spec'].includes(targetTeam)) return;
    if (targetTeam !== 'spec') {
      const count = Object.values(room.players).filter(x => x.team === targetTeam).length;
      if (count >= 2) return;
      room.teamHistory[p.name] = targetTeam;
    }
    p.team = targetTeam;
    io.to(code).emit('lobbyUpdate', { players: getPlayersPublic(room), host: room.host, settings: room.settings });
  });

  socket.on('updateSettings', (settings) => {
    const code = socket.roomCode;
    if (!code || !rooms[code]) return;
    const room = rooms[code];
    if (room.host !== socket.id) return;
    if (settings.arena && ARENAS[settings.arena]) room.settings.arena = settings.arena;
    if (settings.mode && MODES[settings.mode]) room.settings.mode = settings.mode;
    if (settings.duration) room.settings.duration = Math.max(60, Math.min(600, parseInt(settings.duration, 10) || 120));
    if (settings.weather && WEATHERS[settings.weather]) room.settings.weather = settings.weather;
    if (settings.ballSkin) room.settings.ballSkin = sanitize(settings.ballSkin).slice(0, 10);
    if (settings.arenaColor && /^#[0-9a-fA-F]{6}$/.test(settings.arenaColor)) room.settings.arenaColor = settings.arenaColor;
    io.to(code).emit('lobbyUpdate', { players: getPlayersPublic(room), host: room.host, settings: room.settings });
  });

  socket.on('startGame', () => {
    const code = socket.roomCode;
    if (!code || !rooms[code]) return;
    const room = rooms[code];
    if (room.host !== socket.id) return;
    const activeCount = Object.values(room.players).filter(p => p.team !== 'spec').length;
    if (activeCount < 2) return;
    room.started = true;
    io.to(code).emit('countdown');
    setTimeout(() => {
      if (!rooms[code]) return;
      io.to(code).emit('gameStarted', { players: getPlayersPublic(room), settings: room.settings });
      startRoomLoop(code);
    }, 3200);
  });

  socket.on('input', (data) => {
    const code = socket.roomCode;
    if (!code || !rooms[code]) return;
    const inp = rooms[code].inputs[socket.id];
    if (!inp) return;
    let x = Number(data.x) || 0, y = Number(data.y) || 0;
    const l = Math.hypot(x, y);
    if (l < 0.05) { x = 0; y = 0; }
    else if (l > 1) { x /= l; y /= l; }
    inp.x = x; inp.y = y;
    if (data.seq) rooms[code].lastSeq[socket.id] = Number(data.seq);
  });

  socket.on('action', ({ type, dirX, dirY, power, curve }) => {
    const code = socket.roomCode;
    if (!code || !rooms[code]) return;
    const room = rooms[code];
    const p = room.players[socket.id];
    if (!p || p.team === 'spec') return;

    if (type === 'dash') {
      if (p.dashCd > 0 || (p.stamina !== undefined && p.stamina < 24)) return;
      p.dashCd = DASH_CD;
      p.dashTimer = 0.28;
      if (p.stamina !== undefined) p.stamina = Math.max(0, p.stamina - 28);
      const inp = room.inputs[socket.id];
      const l = Math.hypot(inp.x, inp.y);
      const nx = l > 0.1 ? inp.x / l : Math.cos(p.facing || 0);
      const ny = l > 0.1 ? inp.y / l : Math.sin(p.facing || 0);
      p.vx = nx * DASH_IMPULSE;
      p.vy = ny * DASH_IMPULSE;
    } else if (type === 'tackle') {
      if (p.tackleCd > 0 || (p.stamina !== undefined && p.stamina < 16)) return;
      p.tackleCd = TACKLE_CD;
      if (p.stamina !== undefined) p.stamina = Math.max(0, p.stamina - 18);
      const pst = ensurePlayerStats(room, socket.id);
      const fx = Math.cos(p.facing || 0), fy = Math.sin(p.facing || 0);
      p.vx += fx * 350; p.vy += fy * 350;

      for (const b of room.balls) {
        if ((b.z || 0) > 36) continue;
        const d = Math.hypot(b.x - p.x, b.y - p.y);
        if (d < PLAYER_R + BALL_R + 66) {
          if (b.ownerId && b.ownerId !== socket.id && room.players[b.ownerId]) {
            room.players[b.ownerId].pickupLock = 0.65;
            room.players[b.ownerId].vx *= 0.35;
            room.players[b.ownerId].vy *= 0.35;
          }
          b.ownerId = socket.id;
          recordTouch(room, b, socket.id);
          if (pst) { pst.tackles++; pst.touches++; }
        }
      }
    } else if (type === 'kick' || type === 'pass' || type === 'lob') {
      let bestB = null, bestD = 9999;
      for (const b of room.balls) {
        if (b.ownerId === socket.id) { bestB = b; break; }
        if ((b.z || 0) > 42) continue;
        const d = Math.hypot(b.x - p.x, b.y - p.y);
        const range = (type === 'kick' ? 95 : 106) + PLAYER_R + BALL_R;
        if (d < range && d < bestD && !b.ownerId) { bestD = d; bestB = b; }
      }
      if (!bestB) return;
      const powerLevel = Math.max(0.25, Math.min(1, power || 1));
      applyShot(room, p, socket.id, bestB, type, dirX || 0, dirY || 0, powerLevel, Number(curve) || 0);
    }
  });

  socket.on('emote', (em) => {
    const code = socket.roomCode;
    if (!code || !rooms[code]) return;
    if (!rooms[code].players[socket.id]) return;
    io.to(code).emit('emote', { id: socket.id, em: String(em).slice(0, 4) });
  });

  socket.on('chat', (msg) => {
    const code = socket.roomCode;
    if (!code || !rooms[code]) return;
    const p = rooms[code].players[socket.id];
    if (!p) return;
    io.to(code).emit('chat', { name: p.name, msg: String(msg).slice(0, 100) });
  });

  socket.on('rematch', () => {
    const code = socket.roomCode;
    if (!code || !rooms[code]) return;
    const room = rooms[code];
    if (room.host !== socket.id) return;
    room.started = true;
    io.to(code).emit('countdown');
    setTimeout(() => {
      if (!rooms[code]) return;
      io.to(code).emit('gameStarted', { players: getPlayersPublic(room), settings: room.settings });
      startRoomLoop(code);
    }, 3200);
  });

  socket.on('disconnect', () => {
    const code = socket.roomCode;
    if (!code || !rooms[code]) return;
    const room = rooms[code];
    for (const b of room.balls) { if (b.ownerId === socket.id) b.ownerId = null; }
    delete room.players[socket.id];
    delete room.inputs[socket.id];
    delete room.lastSeq[socket.id];
    if (Object.keys(room.players).length === 0) {
      if (room.loop) clearInterval(room.loop);
      delete rooms[code];
      return;
    }
    if (room.host === socket.id) room.host = Object.keys(room.players)[0];
    io.to(code).emit('lobbyUpdate', { players: getPlayersPublic(room), host: room.host, settings: room.settings });
    io.to(code).emit('playerLeft', socket.id);
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log('Ball Brawl Pro v9 on port ' + PORT));
