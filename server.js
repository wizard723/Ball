const express = require('express');
const http = require('http');
const path = require('path');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' }, pingTimeout: 20000, pingInterval: 10000 });
app.use(express.static(path.join(__dirname, 'public')));

const PLAYER_R = 30;
const BALL_R = 20;
const PLAYER_MAX = 260;
const PLAYER_ACCEL = 700;
const FRICTION = 0.982;
const BOUNCE = 0.72;
const KICK_MAX = 480;
const PASS_MAX = 320;
const DASH_IMPULSE = 480;
const DASH_CD = 2.5;
const TACKLE_CD = 3;
const AUTO_MAGNET_RANGE = 240;
const AUTO_MAGNET_FORCE = 200;
const SERVER_TICK = 60;
const SYNC_RATE = 20;
const MAX_PLAYERS = 4;

const ARENAS = {
  classic:   { w: 1800, h: 1100 },
  ice:       { w: 1800, h: 1100 },
  obstacles: { w: 1900, h: 1200 },
  narrow:    { w: 2400, h: 800 }
};
const MODES = { classic: {goals: 5}, time: {duration: 120}, golden: {goals: 1}, chaos: {goals: 5} };

const rooms = {};

function genCode() {
  const c = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let s = '';
  for (let i = 0; i < 5; i++) s += c[Math.floor(Math.random() * c.length)];
  return rooms[s] ? genCode() : s;
}
function sanitize(s, d='Игрок') { return String(s || d).replace(/[<>]/g, '').slice(0, 14); }
function sanitizeNum(n) { const v = parseInt(n); return isNaN(v) ? 0 : Math.max(0, Math.min(99, v)); }
function sanitizeColor(c) { return /^#[0-9a-fA-F]{6}$/.test(c) ? c : '#ff3366'; }

function assignTeams(room) {
  const ids = Object.keys(room.players);
  const r = ids.filter(id => room.players[id].team === 'red').length;
  const b = ids.filter(id => room.players[id].team === 'blue').length;
  return r <= b ? 'red' : 'blue';
}

function arenaBounds(room) {
  const a = ARENAS[room.settings.arena] || ARENAS.classic;
  return { minX: -a.w/2, maxX: a.w/2, minY: -a.h/2, maxY: a.h/2, w: a.w, h: a.h };
}

function resetPositions(room) {
  const ids = Object.keys(room.players);
  const reds = ids.filter(id => room.players[id].team === 'red');
  const blues = ids.filter(id => room.players[id].team === 'blue');
  const bd = arenaBounds(room);
  reds.forEach((id, i) => {
    const p = room.players[id];
    const spread = reds.length === 1 ? 0 : (i - (reds.length - 1) / 2) * 80;
    p.x = bd.minX + 150;
    p.y = spread;
    p.vx = 0; p.vy = 0;
  });
  blues.forEach((id, i) => {
    const p = room.players[id];
    const spread = blues.length === 1 ? 0 : (i - (blues.length - 1) / 2) * 80;
    p.x = bd.maxX - 150;
    p.y = spread;
    p.vx = 0; p.vy = 0;
  });

  room.balls = [{ x: 0, y: 0, vx: 0, vy: 0 }];
  if (room.settings.mode === 'chaos') {
    room.balls.push({ x: 0, y: -200, vx: 0, vy: 0 });
    room.balls.push({ x: 0, y: 200, vx: 0, vy: 0 });
  }
  room.lastToucher = null;
}

function getPlayersPublic(room) {
  return Object.entries(room.players).map(([id, p]) => ({
    id, name: p.name, color: p.color, team: p.team, number: p.number, skin: p.skin
  }));
}

function startRoomLoop(code) {
  const room = rooms[code];
  if (!room || room.loop) return;
  room.loopRunning = true;
  room.lastTick = Date.now();
  room.syncTick = 0;
  room.score = { red: 0, blue: 0 };
  room.startTime = Date.now();
  room.mode = room.settings.mode || 'classic';
  room.timeLeft = MODES[room.mode]?.duration || 0;
  resetPositions(room);

  room.loop = setInterval(() => {
    const now = Date.now();
    let dt = (now - room.lastTick) / 1000;
    room.lastTick = now;
    if (dt > 0.05) dt = 0.05;
    if (dt <= 0) return;

    const bd = arenaBounds(room);
    const iceFriction = room.settings.arena === 'ice' ? 0.998 : FRICTION;

    if (room.mode === 'time') {
      room.timeLeft -= dt;
      if (room.timeLeft <= 0) { finishMatch(room, code); return; }
    }

    // Players
    for (const id in room.players) {
      const p = room.players[id];
      const inp = room.inputs[id] || { x: 0, y: 0 };
      p.vx += inp.x * PLAYER_ACCEL * dt;
      p.vy += inp.y * PLAYER_ACCEL * dt;
      const sp = Math.hypot(p.vx, p.vy);
      if (sp > PLAYER_MAX) { p.vx = p.vx/sp*PLAYER_MAX; p.vy = p.vy/sp*PLAYER_MAX; }
      if (Math.hypot(inp.x, inp.y) < 0.01) {
        const f = Math.pow(iceFriction, dt * 60);
        p.vx *= f; p.vy *= f;
      }
      p.x += p.vx * dt;
      p.y += p.vy * dt;
      if (p.dashCd > 0) p.dashCd -= dt;
      if (p.tackleCd > 0) p.tackleCd -= dt;

      // Auto-magnet для всех игроков
      for (const b of room.balls) {
        const dx = p.x - b.x, dy = p.y - b.y;
        const d = Math.hypot(dx, dy);
        if (d < AUTO_MAGNET_RANGE && d > 1) {
          const f = AUTO_MAGNET_FORCE * (1 - d / AUTO_MAGNET_RANGE);
          b.vx += (dx/d) * f * dt;
          b.vy += (dy/d) * f * dt;
        }
      }
    }

    // Balls
    for (const b of room.balls) {
      const bf = Math.pow(0.99, dt * 60);
      b.vx *= bf; b.vy *= bf;
      b.x += b.vx * dt;
      b.y += b.vy * dt;
      const bSp = Math.hypot(b.vx, b.vy);
      if (bSp > 700) { b.vx = b.vx/bSp*700; b.vy = b.vy/bSp*700; }
    }

    // Player-player collisions
    const ids = Object.keys(room.players);
    for (let i = 0; i < ids.length; i++) {
      for (let j = i+1; j < ids.length; j++) {
        const a = room.players[ids[i]], c = room.players[ids[j]];
        const dx = c.x - a.x, dy = c.y - a.y;
        const d = Math.hypot(dx, dy);
        const md = PLAYER_R * 2;
        if (d < md && d > 0.001) {
          const nx = dx/d, ny = dy/d, ov = md - d;
          a.x -= nx*ov*0.5; a.y -= ny*ov*0.5;
          c.x += nx*ov*0.5; c.y += ny*ov*0.5;
          const rvx = c.vx - a.vx, rvy = c.vy - a.vy;
          const vn = rvx*nx + rvy*ny;
          if (vn < 0) {
            const j2 = -(1+BOUNCE)*vn/2;
            a.vx -= j2*nx; a.vy -= j2*ny;
            c.vx += j2*nx; c.vy += j2*ny;
          }
        }
      }
    }

    // Player-ball collisions
    for (const id in room.players) {
      const p = room.players[id];
      for (const b of room.balls) {
        const dx = b.x - p.x, dy = b.y - p.y;
        const d = Math.hypot(dx, dy);
        const md = PLAYER_R + BALL_R;
        if (d < md && d > 0.001) {
          const nx = dx/d, ny = dy/d, ov = md - d;
          b.x += nx*ov; b.y += ny*ov;
          p.x -= nx*ov*0.3; p.y -= ny*ov*0.3;
          const pSp = Math.hypot(p.vx, p.vy);
          const kick = Math.max(100, pSp * 1.1);
          b.vx += nx*kick; b.vy += ny*kick;
          room.lastToucher = id;
        }
      }
    }

    // Boundaries
    function boundRect(o, r) {
      if (o.x < bd.minX + r) { o.x = bd.minX + r; o.vx = Math.abs(o.vx) * BOUNCE; }
      if (o.x > bd.maxX - r) { o.x = bd.maxX - r; o.vx = -Math.abs(o.vx) * BOUNCE; }
      if (o.y < bd.minY + r) { o.y = bd.minY + r; o.vy = Math.abs(o.vy) * BOUNCE; }
      if (o.y > bd.maxY - r) { o.y = bd.maxY - r; o.vy = -Math.abs(o.vy) * BOUNCE; }
    }
    for (const id in room.players) boundRect(room.players[id], PLAYER_R);

    // Goals
    for (let bi = 0; bi < room.balls.length; bi++) {
      const b = room.balls[bi];
      const escapedLeft = b.x < bd.minX - BALL_R;
      const escapedRight = b.x > bd.maxX + BALL_R;

      if (!escapedLeft && !escapedRight) {
        if (b.y < bd.minY + BALL_R) { b.y = bd.minY + BALL_R; b.vy = Math.abs(b.vy)*BOUNCE; }
        if (b.y > bd.maxY - BALL_R) { b.y = bd.maxY - BALL_R; b.vy = -Math.abs(b.vy)*BOUNCE; }
        continue;
      }

      let scoringTeam = 'red';
      if (room.lastToucher && room.players[room.lastToucher]) {
        scoringTeam = room.players[room.lastToucher].team;
      } else {
        scoringTeam = escapedLeft ? 'blue' : 'red';
      }
      room.score[scoringTeam]++;
      io.to(code).emit('goal', {
        team: scoringTeam, red: room.score.red, blue: room.score.blue,
        scorerName: room.lastToucher ? room.players[room.lastToucher]?.name : ''
      });

      const goalLimit = MODES[room.mode]?.goals || 5;
      if (room.score[scoringTeam] >= goalLimit) { finishMatch(room, code); return; }
      resetPositions(room);
    }

    // Sync
    room.syncTick++;
    const every = Math.round(SERVER_TICK / SYNC_RATE);
    if (room.syncTick >= every) {
      room.syncTick = 0;
      const snap = {
        balls: room.balls.map(b => ({x:b.x, y:b.y, vx:b.vx, vy:b.vy})),
        players: {},
        timeLeft: room.timeLeft
      };
      for (const id in room.players) {
        const p = room.players[id];
        snap.players[id] = {
          x: p.x, y: p.y, vx: p.vx, vy: p.vy,
          dashCd: p.dashCd, tackleCd: p.tackleCd
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
  let winner = 'draw';
  if (room.score.red > room.score.blue) winner = 'red';
  else if (room.score.blue > room.score.red) winner = 'blue';
  io.to(code).emit('matchEnd', {
    winner, red: room.score.red, blue: room.score.blue
  });
}

io.on('connection', (socket) => {
  socket.on('createRoom', ({ name, color, number, skin }, cb) => {
    const code = genCode();
    rooms[code] = {
      players: {}, inputs: {}, lastToucher: null, loop: null, loopRunning: false,
      host: socket.id, started: false,
      settings: { arena: 'classic', mode: 'classic' }
    };
    const room = rooms[code];
    room.players[socket.id] = {
      name: sanitize(name), color: sanitizeColor(color), number: sanitizeNum(number),
      skin: sanitize(skin||'plain').slice(0,10),
      team: 'red', x: 0, y: 0, vx: 0, vy: 0, dashCd: 0, tackleCd: 0
    };
    room.inputs[socket.id] = { x: 0, y: 0 };
    socket.join(code);
    socket.roomCode = code;
    cb({ ok: true, code, players: getPlayersPublic(room), host: socket.id, settings: room.settings });
  });

  socket.on('joinRoom', ({ code, name, color, number, skin }, cb) => {
    code = (code || '').toUpperCase().trim();
    if (!rooms[code]) return cb({ ok: false, error: 'Комната не найдена' });
    const room = rooms[code];
    if (Object.keys(room.players).length >= MAX_PLAYERS) return cb({ ok: false, error: 'Комната заполнена' });
    if (room.started) return cb({ ok: false, error: 'Матч уже идёт' });
    const team = assignTeams(room);
    room.players[socket.id] = {
      name: sanitize(name), color: sanitizeColor(color), number: sanitizeNum(number),
      skin: sanitize(skin||'plain').slice(0,10),
      team, x: 0, y: 0, vx: 0, vy: 0, dashCd: 0, tackleCd: 0
    };
    room.inputs[socket.id] = { x: 0, y: 0 };
    socket.join(code);
    socket.roomCode = code;
    io.to(code).emit('lobbyUpdate', { players: getPlayersPublic(room), host: room.host, settings: room.settings });
    cb({ ok: true, code, players: getPlayersPublic(room), host: room.host, settings: room.settings });
  });

  socket.on('updateSettings', (settings) => {
    const code = socket.roomCode;
    if (!code || !rooms[code]) return;
    const room = rooms[code];
    if (room.host !== socket.id) return;
    if (settings.arena && ARENAS[settings.arena]) room.settings.arena = settings.arena;
    if (settings.mode && MODES[settings.mode]) room.settings.mode = settings.mode;
    io.to(code).emit('lobbyUpdate', { players: getPlayersPublic(room), host: room.host, settings: room.settings });
  });

  socket.on('swapTeam', (targetId) => {
    const code = socket.roomCode;
    if (!code || !rooms[code]) return;
    const room = rooms[code];
    if (room.host !== socket.id) return;
    const p = room.players[targetId];
    if (p) {
      p.team = p.team === 'red' ? 'blue' : 'red';
      io.to(code).emit('lobbyUpdate', { players: getPlayersPublic(room), host: room.host, settings: room.settings });
    }
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
    if (l > 1) { x /= l; y /= l; }
    inp.x = x; inp.y = y;
  });

  socket.on('action', ({ type, dirX, dirY, power }) => {
    const code = socket.roomCode;
    if (!code || !rooms[code]) return;
    const room = rooms[code];
    const p = room.players[socket.id];
    if (!p) return;

    if (type === 'dash') {
      if (p.dashCd > 0) return;
      p.dashCd = DASH_CD;
      const inp = room.inputs[socket.id];
      const l = Math.hypot(inp.x, inp.y);
      if (l > 0.1) { p.vx += (inp.x/l)*DASH_IMPULSE; p.vy += (inp.y/l)*DASH_IMPULSE; }
    } else if (type === 'tackle') {
      if (p.tackleCd > 0) return;
      p.tackleCd = TACKLE_CD;
      for (const b of room.balls) {
        const dx = b.x - p.x, dy = b.y - p.y;
        const d = Math.hypot(dx, dy);
        if (d < PLAYER_R + BALL_R + 60 && d > 1) {
          const nx = dx/d, ny = dy/d;
          b.vx += nx * 300; b.vy += ny * 300;
          room.lastToucher = socket.id;
          for (const id in room.players) {
            if (id === socket.id) continue;
            const o = room.players[id];
            if (o.team !== p.team && Math.hypot(o.x - p.x, o.y - p.y) < 120) {
              o.vx *= 0.3; o.vy *= 0.3;
            }
          }
        }
      }
    } else if (type === 'magnet_on' || type === 'magnet_off') {
      // Игнор — магнит автоматический
    } else if (type === 'kick' || type === 'pass') {
      let bestB = null, bestD = 9999;
      for (const b of room.balls) {
        const dx = b.x - p.x, dy = b.y - p.y;
        const d = Math.hypot(dx, dy);
        const range = (type === 'kick' ? 55 : 65) + PLAYER_R + BALL_R;
        if (d < range && d < bestD) { bestD = d; bestB = b; }
      }
      if (!bestB) return;
      const powerLevel = Math.max(0.2, Math.min(1, power || 1));
      const maxImp = type === 'kick' ? KICK_MAX : PASS_MAX;
      const imp = maxImp * powerLevel;
      let dx = dirX, dy = dirY;
      if (Math.hypot(dx, dy) < 0.1) { dx = bestB.x - p.x; dy = bestB.y - p.y; }
      const l = Math.hypot(dx, dy) || 1;
      bestB.vx += (dx/l) * imp;
      bestB.vy += (dy/l) * imp;
      room.lastToucher = socket.id;
    }
  });

  socket.on('emote', (em) => {
    const code = socket.roomCode;
    if (!code || !rooms[code]) return;
    const p = rooms[code].players[socket.id];
    if (!p) return;
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
      io.to(code).emit('gameStarted', { players: getPlayersPublic(room), settings: room.settings });
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
    if (room.host === socket.id) room.host = Object.keys(room.players)[0];
    io.to(code).emit('lobbyUpdate', { players: getPlayersPublic(room), host: room.host, settings: room.settings });
    io.to(code).emit('playerLeft', socket.id);
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log('Ball Brawl v4 on port ' + PORT));
