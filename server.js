const express = require('express');
const http = require('http');
const path = require('path');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' }, pingTimeout: 20000, pingInterval: 10000 });
app.use(express.static(path.join(__dirname, 'public')));

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
  room.combo = { red: 0, blue: 0 };
}

function getPlayersPublic(room) {
  return Object.entries(room.players).map(([id, p]) => ({
    id, name: p.name, color: p.color, team: p.team, number: p.number, skin: p.skin,
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
  if (Math.hypot(dx, dy) < 0.1) {
    if (Math.hypot(inp.x, inp.y) > 0.1) { dx = inp.x; dy = inp.y; }
    else { dx = Math.cos(p.facing || 0); dy = Math.sin(p.facing || 0); }
  }
  let l = Math.hypot(dx, dy) || 1;
  let nx = dx / l, ny = dy / l;

  // Smart pass assist toward best open teammate in aim cone
  if (kind === 'pass' || kind === 'lob') {
    let bestMate = null, bestScore = 0.55;
    for (const [tid, tp] of Object.entries(room.players)) {
      if (tid === playerId || !tp || tp.team !== p.team || tp.team === 'spec') continue;
      const mdx = tp.x - b.x, mdy = tp.y - b.y, mdist = Math.hypot(mdx, mdy);
      if (mdist > 80 && mdist < 950) {
        const dot = (mdx / mdist) * nx + (mdy / mdist) * ny;
        if (dot > bestScore) { bestScore = dot; bestMate = { dx: mdx, dy: mdy, dist: mdist }; }
      }
    }
    if (bestMate) {
      const lead = Math.min(0.22, bestMate.dist / 3600);
      const tx = bestMate.dx + (room.inputs[Object.keys(room.players).find(k => room.players[k].x === bestMate.dx + b.x)]?.x || 0) * 180 * lead;
      const ty = bestMate.dy;
      const tl = Math.hypot(tx, ty) || 1;
      nx = tx / tl; ny = ty / tl;
    }
  }

  // Distance-aware accuracy & power dispersion
  const bd = arenaBounds(room);
  const targetGoalX = p.team === 'red' ? bd.maxX : bd.minX;
  const distToGoal = Math.abs(targetGoalX - b.x);
  const distFactor = Math.min(1, distToGoal / (bd.w * 0.85));
  const spreadBase = kind === 'kick' ? (0.012 + distFactor * 0.048) * (1 - powerLevel * 0.35) :
                     kind === 'finesse' ? (0.008 + distFactor * 0.025) :
                     kind === 'lob' ? (0.02 + distFactor * 0.04) : 0.015;
  const jitterAngle = (Math.random() - 0.5) * 2 * spreadBase;
  const cosJ = Math.cos(jitterAngle), sinJ = Math.sin(jitterAngle);
  const jx = nx * cosJ - ny * sinJ;
  const jy = nx * sinJ + ny * cosJ;
  nx = jx; ny = jy;

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
  io.to(room.code).emit('ballImpact', { x: b.x, y: b.y, power: powerLevel, kind, overcharged: isOvercharged });
  if (imp > 660) {
    io.to(room.code).emit('screenShake', { intensity: Math.min(13, (imp - 600) / 36) });
  }
}


function segmentCrossesGoalLine(x1, y1, x2, y2, lineX, goalHalfH) {
  const dx = x2 - x1;
  if (Math.abs(dx) < 1e-6) {
    return Math.abs(x2 - lineX) <= BALL_R * 0.4 && Math.abs(y2) <= goalHalfH + BALL_R * 0.25;
  }
  const t = (lineX - x1) / dx;
  if (t >= 0 && t <= 1) {
    const yAtLine = y1 + (y2 - y1) * t;
    if (Math.abs(yAtLine) <= goalHalfH + BALL_R * 0.25) return true;
  }
  return false;
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

function startRoomLoop(code) {
  const room = rooms[code];
  if (!room || room.loop) return;
  room.code = code;
  room.loopRunning = true;
  room.lastTick = Date.now();
  room.syncTick = 0;
  room.score = { red: 0, blue: 0 };
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
      if (room.timeLeft <= 0) { finishMatch(room, code); return; }
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

        const canPickup = (b.z || 0) < 22;
        if (canPickup) {
          for (const id of activeIds) {
            const p = room.players[id];
            if (p.pickupLock > 0) continue;
            const d = Math.hypot(b.x - p.x, b.y - p.y);
            if (d <= PLAYER_R + BALL_R + 5) {
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

      const inGoalZ = (b.z || 0) <= 72;
      const crossedLeft = inGoalZ && (
        segmentCrossesGoalLine(b.prevX, b.prevY, b.x, b.y, bd.minX, goalHalfH) ||
        (b.x < bd.minX - BALL_R * 0.35 && Math.abs(b.y) <= goalHalfH + BALL_R * 0.25)
      );
      const crossedRight = inGoalZ && (
        segmentCrossesGoalLine(b.prevX, b.prevY, b.x, b.y, bd.maxX, goalHalfH) ||
        (b.x > bd.maxX + BALL_R * 0.35 && Math.abs(b.y) <= goalHalfH + BALL_R * 0.25)
      );
      const inGoalY = true;

      const isGoalLeft = crossedLeft && inGoalY && inGoalZ;
      const isGoalRight = crossedRight && inGoalY && inGoalZ;

      if (!isGoalLeft && !isGoalRight) {
        if (b.x < bd.minX + BALL_R) { b.x = bd.minX + BALL_R; b.vx = Math.abs(b.vx) * BOUNCE; }
        if (b.x > bd.maxX - BALL_R) { b.x = bd.maxX - BALL_R; b.vx = -Math.abs(b.vx) * BOUNCE; }
        continue;
      }

      b.scored = true;
      const toucherId = room.lastToucher;
      const toucher = toucherId ? room.players[toucherId] : null;
      const scoringTeam = isGoalLeft ? 'blue' : 'red';
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

      io.to(code).emit('goal', {
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
    players: getPlayersPublic(room)
  });
}

io.on('connection', (socket) => {
  socket.on('pingCheck', (ts, cb) => { if (typeof cb === 'function') cb(ts); });

  socket.on('createRoom', ({ name, color, number, skin, ballSkin, celebration, arenaColor }, cb) => {
    const code = genCode();
    rooms[code] = {
      players: {}, inputs: {}, lastSeq: {}, teamHistory: {},
      lastToucher: null, prevToucher: null,
      loop: null, loopRunning: false, host: socket.id, started: false,
      settings: {
        arena: 'classic', mode: 'classic', matchDuration: 120,
        weather: 'clear', ballSkin: ballSkin || 'classic',
        arenaColor: arenaColor || '#2a6d2a'
      }
    };
    const room = rooms[code];
    const cleanName = sanitize(name);
    room.teamHistory[cleanName] = 'red';
    room.players[socket.id] = createPlayerState({
      name: cleanName, color: sanitizeColor(color), number: sanitizeNum(number),
      skin: sanitize(skin || 'plain').slice(0, 10),
      celebration: CELEBRATIONS.includes(celebration) ? celebration : 'jump',
      team: 'red'
    });
    room.inputs[socket.id] = { x: 0, y: 0 };
    socket.join(code);
    socket.roomCode = code;
    cb({ ok: true, code, players: getPlayersPublic(room), host: socket.id, settings: room.settings });
  });

  socket.on('joinRoom', ({ code, name, color, number, skin, celebration, spectator }, cb) => {
    code = (code || '').toUpperCase().trim();
    if (!rooms[code]) return cb({ ok: false, error: 'Комната не найдена' });
    const room = rooms[code];
    if (Object.keys(room.players).length >= MAX_PLAYERS) return cb({ ok: false, error: 'Комната заполнена' });

    const cleanName = sanitize(name);
    let team = spectator ? 'spec' : (room.teamHistory[cleanName] || assignTeams(room));
    if (room.started && team !== 'spec') team = 'spec';
    if (team !== 'spec') room.teamHistory[cleanName] = team;

    room.players[socket.id] = createPlayerState({
      name: cleanName, color: sanitizeColor(color), number: sanitizeNum(number),
      skin: sanitize(skin || 'plain').slice(0, 10),
      celebration: CELEBRATIONS.includes(celebration) ? celebration : 'jump',
      team
    });
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
    if (settings.matchDuration) {
      const dur = parseInt(settings.matchDuration, 10);
      if ([60, 120, 180, 300].includes(dur)) room.settings.matchDuration = dur;
    }
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

  socket.on('action', ({ type, dirX, dirY, power, curveSign }) => {
    const code = socket.roomCode;
    if (!code || !rooms[code]) return;
    const room = rooms[code];
    const p = room.players[socket.id];
    if (!p || p.team === 'spec') return;

    if (type === 'dash') {
      if (p.dashCd > 0 || (p.stamina ?? 100) < 20) return;
      p.stamina = Math.max(0, (p.stamina ?? 100) - 24);
      p.dashCd = DASH_CD;
      p.dashTimer = 0.28;
      const inp = room.inputs[socket.id] || { x: 0, y: 0 };
      const l = Math.hypot(inp.x, inp.y);
      const nx = l > 0.1 ? inp.x / l : Math.cos(p.facing || 0);
      const ny = l > 0.1 ? inp.y / l : Math.sin(p.facing || 0);
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
server.listen(PORT, () => console.log('Ball Brawl v8 on port ' + PORT));
