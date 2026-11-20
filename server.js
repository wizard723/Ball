const express = require('express');
const http = require('http');
const path = require('path');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: '*' },
  pingTimeout: 20000,
  pingInterval: 10000
});

app.use(express.static(path.join(__dirname, 'public')));

// ================== CONSTANTS ==================
const ARENA_R = 520;
const PLAYER_R = 32;
const BALL_R = 22;
const PLAYER_MAX = 380;
const PLAYER_ACCEL = 950;
const FRICTION = 0.985;
const BOUNCE = 0.72;
const KICK_IMPULSE = 620;
const PASS_IMPULSE = 420;
const DASH_IMPULSE = 700;
const DASH_CD = 2.0;
const SERVER_TICK = 60;
const SYNC_RATE = 20;
const MAX_GOALS = 5;
const MAX_PLAYERS = 4;

const TEAM_COLORS = { red: '#ff3366', blue: '#33aaff' };

const rooms = {};

// ================== HELPERS ==================
function genCode() {
  const c = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let s = '';
  for (let i = 0; i < 5; i++) s += c[Math.floor(Math.random() * c.length)];
  return rooms[s] ? genCode() : s;
}
function sanitize(s, def = 'Игрок') {
  return String(s || def).replace(/[<>]/g, '').slice(0, 14);
}
function sanitizeNum(n) {
  const v = parseInt(n);
  return isNaN(v) ? 0 : Math.max(0, Math.min(99, v));
}

function assignTeams(room) {
  // Первые 2 — красные, следующие 2 — синие
  const ids = Object.keys(room.players);
  const redCount = ids.filter(id => room.players[id].team === 'red').length;
  const blueCount = ids.filter(id => room.players[id].team === 'blue').length;
  if (redCount <= blueCount) return 'red';
  return 'blue';
}

function resetPositions(room) {
  const ids = Object.keys(room.players);
  const reds = ids.filter(id => room.players[id].team === 'red');
  const blues = ids.filter(id => room.players[id].team === 'blue');

  // Красные — слева, синие — справа
  reds.forEach((id, i) => {
    const p = room.players[id];
    const spread = reds.length === 1 ? 0 : (i - (reds.length - 1) / 2) * 90;
    p.x = -320;
    p.y = spread;
    p.vx = 0; p.vy = 0;
  });
  blues.forEach((id, i) => {
    const p = room.players[id];
    const spread = blues.length === 1 ? 0 : (i - (blues.length - 1) / 2) * 90;
    p.x = 320;
    p.y = spread;
    p.vx = 0; p.vy = 0;
  });

  room.ball = { x: 0, y: 0, vx: 0, vy: 0 };
  room.lastToucher = null;
}

function getPlayersPublic(room) {
  return Object.entries(room.players).map(([id, p]) => ({
    id, name: p.name, color: p.color, team: p.team, number: p.number
  }));
}

// ================== GAME LOOP ==================
function startRoomLoop(code) {
  const room = rooms[code];
  if (!room || room.loop) return;
  room.loopRunning = true;
  room.lastTick = Date.now();
  room.syncTick = 0;

  resetPositions(room);
  room.score = { red: 0, blue: 0 };

  room.loop = setInterval(() => {
    const now = Date.now();
    let dt = (now - room.lastTick) / 1000;
    room.lastTick = now;
    if (dt > 0.05) dt = 0.05;
    if (dt <= 0) return;

    // ---- Integrate players ----
    for (const id in room.players) {
      const p = room.players[id];
      const inp = room.inputs[id] || { x: 0, y: 0 };

      p.vx += inp.x * PLAYER_ACCEL * dt;
      p.vy += inp.y * PLAYER_ACCEL * dt;

      const sp = Math.hypot(p.vx, p.vy);
      if (sp > PLAYER_MAX) {
        p.vx = (p.vx / sp) * PLAYER_MAX;
        p.vy = (p.vy / sp) * PLAYER_MAX;
      }
      if (Math.hypot(inp.x, inp.y) < 0.01) {
        const f = Math.pow(FRICTION, dt * 60);
        p.vx *= f; p.vy *= f;
      }

      p.x += p.vx * dt;
      p.y += p.vy * dt;

      if (p.dashCd > 0) p.dashCd -= dt;
    }

    // ---- Integrate ball ----
    const b = room.ball;
    const bf = Math.pow(0.99, dt * 60);
    b.vx *= bf; b.vy *= bf;
    b.x += b.vx * dt;
    b.y += b.vy * dt;

    // ---- Player-player collisions ----
    const ids = Object.keys(room.players);
    for (let i = 0; i < ids.length; i++) {
      for (let j = i + 1; j < ids.length; j++) {
        const a = room.players[ids[i]];
        const c = room.players[ids[j]];
        const dx = c.x - a.x, dy = c.y - a.y;
        const d = Math.hypot(dx, dy);
        const minD = a.r + c.r;
        if (d < minD && d > 0.001) {
          const nx = dx / d, ny = dy / d;
          const ov = minD - d;
          a.x -= nx * ov * 0.5; a.y -= ny * ov * 0.5;
          c.x += nx * ov * 0.5; c.y += ny * ov * 0.5;
          const rvx = c.vx - a.vx, rvy = c.vy - a.vy;
          const vn = rvx * nx + rvy * ny;
          if (vn < 0) {
            const jImp = -(1 + BOUNCE) * vn / 2;
            a.vx -= jImp * nx; a.vy -= jImp * ny;
            c.vx += jImp * nx; c.vy += jImp * ny;
          }
        }
      }
    }

    // ---- Player-ball collision ----
    for (const id in room.players) {
      const p = room.players[id];
      const dx = b.x - p.x, dy = b.y - p.y;
      const d = Math.hypot(dx, dy);
      const minD = p.r + BALL_R;
      if (d < minD && d > 0.001) {
        const nx = dx / d, ny = dy / d;
        const ov = minD - d;
        b.x += nx * ov; b.y += ny * ov;
        p.x -= nx * ov * 0.3; p.y -= ny * ov * 0.3;

        const pSpeed = Math.hypot(p.vx, p.vy);
        const kick = Math.max(180, pSpeed * 1.2);
        b.vx += nx * kick;
        b.vy += ny * kick;

        const bSp = Math.hypot(b.vx, b.vy);
        const maxB = 950;
        if (bSp > maxB) { b.vx = (b.vx / bSp) * maxB; b.vy = (b.vy / bSp) * maxB; }

        room.lastToucher = id;
      }
    }

    // ---- Arena bounds ----
    function bound(o, isBall) {
      const dx = o.x, dy = o.y;
      const dist = Math.hypot(dx, dy);
      const maxD = ARENA_R - o.r;
      if (dist > maxD && dist > 0.001) {
        const nx = dx / dist, ny = dy / dist;
        o.x = nx * maxD; o.y = ny * maxD;
        const vn = o.vx * nx + o.vy * ny;
        if (vn > 0) {
          o.vx -= (1 + BOUNCE) * vn * nx;
          o.vy -= (1 + BOUNCE) * vn * ny;
        }
      }
    }
    for (const id in room.players) bound(room.players[id], false);
    bound(b, true);

    // ---- Goal detection: ball escapes arena ----
    const bDist = Math.hypot(b.x, b.y);
    if (bDist > ARENA_R + BALL_R) {
      // Determine scoring team (opposite of last toucher's team)
      let scoringTeam = null;
      if (room.lastToucher && room.players[room.lastToucher]) {
        const lt = room.players[room.lastToucher];
        scoringTeam = lt.team === 'red' ? 'blue' : 'red';
        // Actually: goal counts for toucher's TEAM (ball goes into opposite goal)
        scoringTeam = lt.team;
      } else {
        scoringTeam = b.y > 0 ? 'red' : 'blue';
      }

      room.score[scoringTeam]++;
      const scorer = room.lastToucher ? room.players[room.lastToucher]?.name : '?';

      io.to(code).emit('goal', {
        team: scoringTeam,
        scorer,
        red: room.score.red,
        blue: room.score.blue
      });

      if (room.score[scoringTeam] >= MAX_GOALS) {
        io.to(code).emit('matchEnd', {
          winner: scoringTeam,
          red: room.score.red,
          blue: room.score.blue
        });
        // Keep loop running but frozen? — просто остановим
        clearInterval(room.loop);
        room.loop = null;
        room.loopRunning = false;
        return;
      }

      resetPositions(room);
    }

    // ---- Sync ----
    room.syncTick++;
    const syncEvery = Math.round(SERVER_TICK / SYNC_RATE);
    if (room.syncTick >= syncEvery) {
      room.syncTick = 0;
      const snap = { ball: { x: b.x, y: b.y, vx: b.vx, vy: b.vy }, players: {} };
      for (const id in room.players) {
        const p = room.players[id];
        snap.players[id] = {
          x: p.x, y: p.y, vx: p.vx, vy: p.vy, dashCd: p.dashCd
        };
      }
      io.to(code).volatile.emit('state', snap);
    }
  }, 1000 / SERVER_TICK);
}

// ================== SOCKET ==================
io.on('connection', (socket) => {
  socket.on('createRoom', ({ name, color, number }, cb) => {
    const code = genCode();
    rooms[code] = {
      players: {}, inputs: {}, lastToucher: null,
      loop: null, loopRunning: false, host: socket.id, started: false
    };
    const room = rooms[code];
    room.players[socket.id] = {
      name: sanitize(name), color: color || '#ff3366', number: sanitizeNum(number),
      team: 'red', x: -320, y: 0, vx: 0, vy: 0, r: PLAYER_R, dashCd: 0
    };
    room.inputs[socket.id] = { x: 0, y: 0 };
    socket.join(code);
    socket.roomCode = code;
    cb({ ok: true, code, players: getPlayersPublic(room), host: socket.id });
  });

  socket.on('joinRoom', ({ code, name, color, number }, cb) => {
    code = (code || '').toUpperCase().trim();
    if (!rooms[code]) return cb({ ok: false, error: 'Комната не найдена' });
    if (Object.keys(rooms[code].players).length >= MAX_PLAYERS)
      return cb({ ok: false, error: 'Комната заполнена (макс 4)' });
    if (rooms[code].started) return cb({ ok: false, error: 'Матч уже идёт' });

    const room = rooms[code];
    const team = assignTeams(room);
    room.players[socket.id] = {
      name: sanitize(name), color: color || '#33aaff', number: sanitizeNum(number),
      team, x: 0, y: 0, vx: 0, vy: 0, r: PLAYER_R, dashCd: 0
    };
    room.inputs[socket.id] = { x: 0, y: 0 };
    socket.join(code);
    socket.roomCode = code;

    io.to(code).emit('lobbyUpdate', { players: getPlayersPublic(room), host: room.host });
    cb({ ok: true, code, players: getPlayersPublic(room), host: room.host });
  });

  socket.on('startGame', () => {
    const code = socket.roomCode;
    if (!code || !rooms[code]) return;
    const room = rooms[code];
    if (room.host !== socket.id) return;
    if (Object.keys(room.players).length < 2) return;
    room.started = true;
    io.to(code).emit('countdown');
    setTimeout(() => {
      io.to(code).emit('gameStarted', { players: getPlayersPublic(room) });
      startRoomLoop(code);
    }, 3200);
  });

  socket.on('input', (data) => {
    const code = socket.roomCode;
    if (!code || !rooms[code]) return;
    const inp = rooms[code].inputs[socket.id];
    if (!inp) return;
    let x = Number(data.x) || 0;
    let y = Number(data.y) || 0;
    const len = Math.hypot(x, y);
    if (len > 1) { x /= len; y /= len; }
    inp.x = x; inp.y = y;
  });

  socket.on('action', (type) => {
    const code = socket.roomCode;
    if (!code || !rooms[code]) return;
    const room = rooms[code];
    const p = room.players[socket.id];
    const b = room.ball;
    if (!p || !b) return;

    if (type === 'dash') {
      if (p.dashCd > 0) return;
      p.dashCd = DASH_CD;
      const inp = room.inputs[socket.id];
      const dirLen = Math.hypot(inp.x, inp.y);
      if (dirLen > 0.1) {
        p.vx += (inp.x / dirLen) * DASH_IMPULSE;
        p.vy += (inp.y / dirLen) * DASH_IMPULSE;
      }
    } else if (type === 'kick' || type === 'pass') {
      const dx = b.x - p.x, dy = b.y - p.y;
      const d = Math.hypot(dx, dy);
      const range = type === 'kick' ? (p.r + b.r + 30) : (p.r + b.r + 40);
      if (d < range && d > 0.001) {
        const nx = dx / d, ny = dy / d;
        const impulse = type === 'kick' ? KICK_IMPULSE : PASS_IMPULSE;
        b.vx += nx * impulse;
        b.vy += ny * impulse;
        room.lastToucher = socket.id;
      }
    }
  });

  socket.on('rematch', () => {
    const code = socket.roomCode;
    if (!code || !rooms[code]) return;
    const room = rooms[code];
    if (room.host !== socket.id) return;
    room.score = { red: 0, blue: 0 };
    room.started = true;
    io.to(code).emit('countdown');
    setTimeout(() => {
      io.to(code).emit('gameStarted', { players: getPlayersPublic(room) });
      startRoomLoop(code);
    }, 3200);
  });

  socket.on('disconnect', () => {
    const code = socket.roomCode;
    if (!code || !rooms[code]) return;
    const room = rooms[code];
    delete room.players[socket.id];
    delete room.inputs[socket.id];

    if (Object.keys(room.players).length === 0) {
      if (room.loop) clearInterval(room.loop);
      delete rooms[code];
      return;
    }
    // Host reassignment
    if (room.host === socket.id) {
      room.host = Object.keys(room.players)[0];
    }
    io.to(code).emit('lobbyUpdate', { players: getPlayersPublic(room), host: room.host });
    io.to(code).emit('playerLeft', socket.id);
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log('Ball Brawl v2 on port ' + PORT));
