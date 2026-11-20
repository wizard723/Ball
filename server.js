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

// ================== ARENA CONFIG ==================
const ARENA = { radius: 500, cx: 0, cy: 0 };  // круглая арена
const PLAYER_RADIUS = 30;
const BALL_RADIUS = 22;
const FRICTION = 0.985;          // трение каждого кадра
const PLAYER_MAX_SPEED = 380;    // px/s
const PLAYER_ACCEL = 900;
const KICK_IMPULSE = 500;        // сила удара по мячу
const BOUNCE = 0.7;              // упругость столкновений
const GOAL_WIDTH = 200;          // ширина ворот по дуге (в градусах)
const SERVER_TICK = 60;          // Hz
const SYNC_RATE = 20;            // Hz (сколько раз в секунду рассылка)

const rooms = {};
const START_SPOTS = [
  { x: -250, y: 0 }, { x: 250, y: 0 },
  { x: 0, y: -250 }, { x: 0, y: 250 },
  { x: -180, y: -180 }, { x: 180, y: 180 }
];

function genCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code = '';
  for (let i = 0; i < 5; i++) code += chars[Math.floor(Math.random() * chars.length)];
  return rooms[code] ? genCode() : code;
}
function sanitize(s) { return String(s || 'Игрок').replace(/[<>]/g, '').slice(0, 14); }
function sanitizeColor(c) { return /^#[0-9a-fA-F]{6}$/.test(c) ? c : '#ff3366'; }

// ================== GAME LOOP per room ==================
function startRoomLoop(code) {
  const room = rooms[code];
  if (!room || room.loopRunning) return;
  room.loopRunning = true;
  room.lastTick = Date.now();
  room.lastSync = 0;

  room.ball = {
    x: 0, y: 0, vx: 0, vy: 0,
    r: BALL_RADIUS
  };

  // Раздаём стартовые позиции
  const ids = Object.keys(room.players);
  ids.forEach((id, i) => {
    const spot = START_SPOTS[i % START_SPOTS.length];
    const p = room.players[id];
    p.x = spot.x; p.y = spot.y;
    p.vx = 0; p.vy = 0;
    p.r = PLAYER_RADIUS;
    p.score = 0;
  });

  let syncedThisTick = 0;
  const syncEvery = Math.round(SERVER_TICK / SYNC_RATE);

  room.interval = setInterval(() => {
    const now = Date.now();
    let dt = (now - room.lastTick) / 1000;
    room.lastTick = now;
    if (dt > 0.05) dt = 0.05;  // защита от лагов
    if (dt <= 0) return;

    // --- Интеграция игроков ---
    for (const id in room.players) {
      const p = room.players[id];
      // Применяем ввод (dirX, dirY ∈ [-1..1])
      const in_ = room.inputs[id] || { x: 0, y: 0 };
      p.vx += in_.x * PLAYER_ACCEL * dt;
      p.vy += in_.y * PLAYER_ACCEL * dt;

      // Ограничение скорости
      const sp = Math.hypot(p.vx, p.vy);
      const maxV = PLAYER_MAX_SPEED;
      if (sp > maxV) {
        p.vx = (p.vx / sp) * maxV;
        p.vy = (p.vy / sp) * maxV;
      }

      // Трение (только если нет ввода)
      if (Math.hypot(in_.x, in_.y) < 0.01) {
        const f = Math.pow(FRICTION, dt * 60);
        p.vx *= f;
        p.vy *= f;
      }

      p.x += p.vx * dt;
      p.y += p.vy * dt;
    }

    // --- Интеграция мяча ---
    const b = room.ball;
    const bf = Math.pow(0.99, dt * 60);
    b.vx *= bf;
    b.vy *= bf;
    b.x += b.vx * dt;
    b.y += b.vy * dt;

    // --- Столкновения игрок-игрок ---
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
          const overlap = minD - d;
          a.x -= nx * overlap * 0.5;
          a.y -= ny * overlap * 0.5;
          c.x += nx * overlap * 0.5;
          c.y += ny * overlap * 0.5;
          const rvx = c.vx - a.vx;
          const rvy = c.vy - a.vy;
          const vn = rvx * nx + rvy * ny;
          if (vn < 0) {
            const jImp = -(1 + BOUNCE) * vn / 2;
            a.vx -= jImp * nx; a.vy -= jImp * ny;
            c.vx += jImp * nx; c.vy += jImp * ny;
          }
        }
      }
    }

    // --- Столкновения игрок-мяч ---
    for (const id in room.players) {
      const p = room.players[id];
      const dx = b.x - p.x, dy = b.y - p.y;
      const d = Math.hypot(dx, dy);
      const minD = p.r + b.r;
      if (d < minD && d > 0.001) {
        const nx = dx / d, ny = dy / d;
        const overlap = minD - d;
        // Мяч отталкивается
        b.x += nx * overlap;
        b.y += ny * overlap;
        p.x -= nx * overlap * 0.3;
        p.y -= ny * overlap * 0.3;

        // Импульс мячу (сила зависит от скорости игрока + базовый kick)
        const pSpeed = Math.hypot(p.vx, p.vy);
        const kick = Math.max(KICK_IMPULSE, pSpeed * 1.4);
        b.vx += nx * kick * dt * 60 * 0.35;
        b.vy += ny * kick * dt * 60 * 0.35;

        // Ограничим скорость мяча
        const bSp = Math.hypot(b.vx, b.vy);
        const maxB = 900;
        if (bSp > maxB) {
          b.vx = (b.vx / bSp) * maxB;
          b.vy = (b.vy / bSp) * maxB;
        }
      }
    }

    // --- Границы арены (круговые) ---
    function handleBoundary(o, isBall) {
      const dx = o.x - ARENA.cx;
      const dy = o.y - ARENA.cy;
      const dist = Math.hypot(dx, dy);
      const maxDist = ARENA.radius - o.r;
      if (dist > maxDist && dist > 0.001) {
        const nx = dx / dist, ny = dy / dist;
        o.x = ARENA.cx + nx * maxDist;
        o.y = ARENA.cy + ny * maxDist;
        const vn = o.vx * nx + o.vy * ny;
        if (vn > 0) {
          o.vx -= (1 + BOUNCE) * vn * nx;
          o.vy -= (1 + BOUNCE) * vn * ny;
        }
      }
    }
    for (const id in room.players) handleBoundary(room.players[id], false);
    handleBoundary(b, true);

    // --- Проверка гола: мяч за границей (пролетел сквозь) ---
    const bDist = Math.hypot(b.x - ARENA.cx, b.y - ARENA.cy);
    if (bDist > ARENA.radius + BALL_RADIUS) {
      // Гол! Определяем, кто забил (последний, кто коснулся)
      const scorer = room.lastToucher || null;
      if (scorer && room.players[scorer]) {
        room.players[scorer].score++;
        io.to(code).emit('goal', { scorer, score: room.players[scorer].score, name: room.players[scorer].name });
      }
      // Респавн мяча
      room.ball.x = 0; room.ball.y = 0;
      room.ball.vx = 0; room.ball.vy = 0;
      // Респавн игроков по слотам
      Object.keys(room.players).forEach((id, i) => {
        const spot = START_SPOTS[i % START_SPOTS.length];
        const p = room.players[id];
        p.x = spot.x; p.y = spot.y;
        p.vx = 0; p.vy = 0;
      });
      room.lastToucher = null;
    }

    // --- Рассылка (20 Hz) ---
    syncedThisTick++;
    if (syncedThisTick >= syncEvery) {
      syncedThisTick = 0;
      const snap = {
        ball: { x: b.x, y: b.y, vx: b.vx, vy: b.vy },
        players: {}
      };
      for (const id in room.players) {
        const p = room.players[id];
        snap.players[id] = {
          x: p.x, y: p.y, vx: p.vx, vy: p.vy,
          score: p.score, name: p.name, color: p.color
        };
      }
      io.to(code).volatile.emit('state', snap);
    }
  }, 1000 / SERVER_TICK);
}

// ================== SOCKET.IO ==================
io.on('connection', (socket) => {
  socket.on('createRoom', ({ name, color }, cb) => {
    const code = genCode();
    rooms[code] = { players: {}, inputs: {}, lastToucher: null, loopRunning: false };
    rooms[code].players[socket.id] = {
      name: sanitize(name), color: sanitizeColor(color),
      x: 0, y: 0, vx: 0, vy: 0, r: PLAYER_RADIUS, score: 0
    };
    rooms[code].inputs[socket.id] = { x: 0, y: 0 };
    socket.join(code);
    socket.roomCode = code;
    cb({ ok: true, code, players: getPlayers(code) });
  });

  socket.on('joinRoom', ({ code, name, color }, cb) => {
    code = (code || '').toUpperCase().trim();
    if (!rooms[code]) return cb({ ok: false, error: 'Комната не найдена' });
    if (Object.keys(rooms[code].players).length >= 6) return cb({ ok: false, error: 'Комната заполнена (макс 6)' });
    rooms[code].players[socket.id] = {
      name: sanitize(name), color: sanitizeColor(color),
      x: 0, y: 0, vx: 0, vy: 0, r: PLAYER_RADIUS, score: 0
    };
    rooms[code].inputs[socket.id] = { x: 0, y: 0 };
    socket.join(code);
    socket.roomCode = code;
    io.to(code).emit('playerJoined', {
      id: socket.id, name: rooms[code].players[socket.id].name,
      color: rooms[code].players[socket.id].color
    });
    cb({ ok: true, code, players: getPlayers(code) });
  });

  socket.on('startGame', () => {
    const code = socket.roomCode;
    if (!code || !rooms[code]) return;
    io.to(code).emit('gameStarted');
    startRoomLoop(code);
  });

  socket.on('input', (data) => {
    const code = socket.roomCode;
    if (!code || !rooms[code]) return;
    const inp = rooms[code].inputs[socket.id];
    if (!inp) return;
    // Нормализуем [-1..1]
    let x = Number(data.x) || 0;
    let y = Number(data.y) || 0;
    const len = Math.hypot(x, y);
    if (len > 1) { x /= len; y /= len; }
    inp.x = x; inp.y = y;
  });

  socket.on('disconnect', () => {
    const code = socket.roomCode;
    if (!code || !rooms[code]) return;
    delete rooms[code].players[socket.id];
    delete rooms[code].inputs[socket.id];
    io.to(code).emit('playerLeft', socket.id);
    if (Object.keys(rooms[code].players).length === 0) {
      if (rooms[code].interval) clearInterval(rooms[code].interval);
      delete rooms[code];
    }
  });
});

function getPlayers(code) {
  return Object.entries(rooms[code].players).map(([id, p]) => ({
    id, name: p.name, color: p.color
  }));
}

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log('Ball Brawl server on port ' + PORT));
