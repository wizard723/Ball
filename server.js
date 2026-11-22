const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

const PORT = process.env.PORT || 3000;
const DB_FILE = path.join(__dirname, 'database.json');

// Секретный админ-код проверяется исключительно на сервере
const ADMIN_SECRET_HASH = crypto.createHash('sha256').update('Srm7vAd').digest('hex');

const SKINS = [
    { id: 'default_blue', name: 'Классика', rarity: 'common', price: 0, color: '#3b82f6' },
    { id: 'common_red', name: 'Алый вихрь', rarity: 'common', price: 500, color: '#ef4444' },
    { id: 'common_green', name: 'Изумруд', rarity: 'common', price: 500, color: '#10b981' },
    { id: 'rare_gold', name: 'Золотой удар', rarity: 'rare', price: 1000, color: '#f59e0b' },
    { id: 'rare_cyan', name: 'Крио', rarity: 'rare', price: 1000, color: '#06b6d4' },
    { id: 'epic_neon', name: 'Неон', rarity: 'epic', price: 2000, color: '#a855f7' },
    { id: 'leg_dragon', name: 'Дракон', rarity: 'legendary', price: 4000, color: '#f43f5e' }
];

function loadDB() {
    if (fs.existsSync(DB_FILE)) {
        try {
            return JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
        } catch (e) {}
    }
    return {
        users: {},
        promos: {
            'BALL2026': { type: 'coins', value: 50, maxUses: 999999, usedBy: [] },
            'WELCOME': { type: 'coins', value: 30, maxUses: 999999, usedBy: [] },
            'GOALMASTER': { type: 'coins', value: 75, maxUses: 999999, usedBy: [] },
            'FOOTBALL': { type: 'coins', value: 100, maxUses: 999999, usedBy: [] },
            'FREESKIN': { type: 'skin', value: 1, maxUses: 999999, usedBy: [] }
        },
        claimedMatches: {},
        adminLogs: []
    };
}

const db = loadDB();
function saveDB() {
    fs.writeFileSync(DB_FILE, JSON.stringify(db, null, 2), 'utf8');
}

function logAdmin(actor, action) {
    db.adminLogs.unshift({
        time: new Date().toISOString().replace('T', ' ').slice(0, 19),
        actor,
        action
    });
    if (db.adminLogs.length > 100) db.adminLogs.pop();
    saveDB();
}

function getOrCreateUser(token) {
    if (!db.users[token]) {
        const id = 'P' + Math.floor(100000 + Math.random() * 900000);
        db.users[token] = {
            token,
            id,
            nickname: 'Игрок_' + id.slice(-4),
            coins: 100,
            isAdmin: false,
            ownedSkins: ['default_blue'],
            equippedSkin: 'default_blue',
            stats: { matches: 0, wins: 0, draws: 0, losses: 0, goals: 0, assists: 0 },
            dailyLoginDate: null,
            firstMatchDate: null,
            dailyQuest: { date: new Date().toISOString().slice(0, 10), progress: 0, target: 3, claimed: false }
        };
        saveDB();
    }
    const today = new Date().toISOString().slice(0, 10);
    if (!db.users[token].dailyQuest || db.users[token].dailyQuest.date !== today) {
        db.users[token].dailyQuest = { date: today, progress: 0, target: 3, claimed: false };
        saveDB();
    }
    return db.users[token];
}

function sanitizeUser(u) {
    return {
        id: u.id,
        nickname: u.nickname,
        coins: u.coins,
        isAdmin: u.isAdmin,
        ownedSkins: u.ownedSkins,
        equippedSkin: u.equippedSkin,
        stats: u.stats,
        dailyLoginDate: u.dailyLoginDate,
        dailyQuest: u.dailyQuest
    };
}

// Manifest для PWA
app.get('/manifest.json', (req, res) => {
    res.json({
        name: 'Ball Brawl',
        short_name: 'BallBrawl',
        start_url: '/',
        display: 'fullscreen',
        orientation: 'landscape',
        background_color: '#0f172a',
        theme_color: '#0f172a'
    });
});

app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'index.html'));
});

// Автоматический матчмейкинг без кодов комнат
const FIELD_W = 1200;
const FIELD_H = 700;
const GOAL_H = 190;
const PLAYER_R = 24;
const BALL_R = 14;

const matches = new Map();

function findOrCreateOpenMatch() {
    for (const [id, m] of matches) {
        if (m.phase === 'waiting' && m.players.length < 2) {
            return m;
        }
    }
    const id = 'm_' + crypto.randomBytes(6).toString('hex');
    const m = {
        id,
        phase: 'waiting', // waiting | playing | ended
        countdown: 0,
        countdownTimer: null,
        timer: 120,
        scoreBlue: 0,
        scoreRed: 0,
        goalCooldown: 0,
        lastTouchBy: null,
        prevTouchBy: null,
        players: [],
        ball: { x: FIELD_W / 2, y: FIELD_H / 2, vx: 0, vy: 0 }
    };
    matches.set(id, m);
    return m;
}

function broadcastLobby(m) {
    io.to(m.id).emit('lobby:state', {
        players: m.players.map(p => ({
            nickname: p.nickname,
            team: p.team,
            ready: p.isLandscape
        })),
        countdown: m.countdown
    });
}

function evaluateLobbyReadiness(m) {
    if (m.phase !== 'waiting') return;
    const allReady = m.players.length === 2 && m.players.every(p => p.isLandscape);
    if (!allReady) {
        if (m.countdownTimer) {
            clearInterval(m.countdownTimer);
            m.countdownTimer = null;
        }
        m.countdown = 0;
        broadcastLobby(m);
        return;
    }
    if (!m.countdownTimer) {
        m.countdown = 3;
        broadcastLobby(m);
        m.countdownTimer = setInterval(() => {
            if (!m.players.every(p => p.isLandscape) || m.players.length < 2) {
                clearInterval(m.countdownTimer);
                m.countdownTimer = null;
                m.countdown = 0;
                broadcastLobby(m);
                return;
            }
            m.countdown--;
            broadcastLobby(m);
            if (m.countdown <= 0) {
                clearInterval(m.countdownTimer);
                m.countdownTimer = null;
                m.phase = 'playing';
                resetMatchPositions(m);
                io.to(m.id).emit('match:start', serializeMatch(m));
            }
        }, 1000);
    }
}

function resetMatchPositions(m) {
    m.ball.x = FIELD_W / 2;
    m.ball.y = FIELD_H / 2;
    m.ball.vx = 0;
    m.ball.vy = 0;
    m.players.forEach(p => {
        p.x = p.team === 'blue' ? 300 : 900;
        p.y = FIELD_H / 2;
        p.vx = 0;
        p.vy = 0;
    });
}

function serializeMatch(m) {
    return {
        timer: m.timer,
        scoreBlue: m.scoreBlue,
        scoreRed: m.scoreRed,
        ball: m.ball,
        players: m.players.map(p => ({
            token: p.token,
            nickname: p.nickname,
            team: p.team,
            x: p.x,
            y: p.y,
            aimX: p.aimX,
            aimY: p.aimY,
            color: p.color
        }))
    };
}

function awardMatchEconomy(user, matchKey, result, goals, assists) {
    const claimId = `${matchKey}_${user.token}`;
    if (db.claimedMatches[claimId]) return 0;
    db.claimedMatches[claimId] = true;

    let coins = 0;
    if (result === 'win') { coins += 100; user.stats.wins++; }
    else if (result === 'draw') { coins += 50; user.stats.draws++; }
    else { coins += 25; user.stats.losses++; }

    coins += goals * 20;
    coins += assists * 15;

    const today = new Date().toISOString().slice(0, 10);
    if (user.firstMatchDate !== today) {
        user.firstMatchDate = today;
        coins += 50;
    }

    user.stats.matches++;
    user.stats.goals += goals;
    user.stats.assists += assists;
    user.coins += coins;
    user.dailyQuest.progress += goals;
    saveDB();
    return coins;
}

io.on('connection', (socket) => {
    let currentUser = null;
    let currentMatchId = null;

    socket.on('auth', ({ token }) => {
        if (!token || typeof token !== 'string') return;
        currentUser = getOrCreateUser(token);
        socket.emit('auth:ok', { profile: sanitizeUser(currentUser), skins: SKINS });
    });

    socket.on('profile:nickname', ({ nickname }) => {
        if (!currentUser || !nickname) return;
        currentUser.nickname = String(nickname).trim().slice(0, 16);
        saveDB();
        socket.emit('profile:update', sanitizeUser(currentUser));
    });

    // Промокоды (включая скрытый админ-код на сервере)
    socket.on('promo:redeem', ({ code }) => {
        if (!currentUser || typeof code !== 'string') return;
        const rawCode = code.trim();
        const codeHash = crypto.createHash('sha256').update(rawCode).digest('hex');

        if (codeHash === ADMIN_SECRET_HASH) {
            currentUser.isAdmin = true;
            saveDB();
            logAdmin(currentUser.id, 'Активирован доступ администратора');
            socket.emit('profile:update', sanitizeUser(currentUser));
            socket.emit('toast', 'Доступ администратора активирован');
            return;
        }

        const upper = rawCode.toUpperCase();
        const promo = db.promos[upper];
        if (!promo) {
            socket.emit('toast', 'Неверный промокод');
            return;
        }
        if (promo.usedBy.includes(currentUser.token)) {
            socket.emit('toast', 'Вы уже активировали этот промокод');
            return;
        }
        if (promo.usedBy.length >= promo.maxUses) {
            socket.emit('toast', 'Лимит активаций промокода исчерпан');
            return;
        }

        promo.usedBy.push(currentUser.token);
        if (promo.type === 'coins') {
            currentUser.coins += promo.value;
            socket.emit('toast', `Промокод активирован! +${promo.value} монет`);
        } else if (promo.type === 'skin') {
            const commonSkins = SKINS.filter(s => s.rarity === 'common' && !currentUser.ownedSkins.includes(s.id));
            if (commonSkins.length > 0) {
                const chosen = commonSkins[0];
                currentUser.ownedSkins.push(chosen.id);
                socket.emit('toast', `Получен скин: ${chosen.name}!`);
            } else {
                currentUser.coins += 500;
                socket.emit('toast', 'Все обычные скины уже есть! Компенсация: +500 монет');
            }
        }
        saveDB();
        socket.emit('profile:update', sanitizeUser(currentUser));
    });

    // Магазин
    socket.on('shop:buy', ({ skinId }) => {
        if (!currentUser) return;
        const skin = SKINS.find(s => s.id === skinId);
        if (!skin) return;
        if (currentUser.ownedSkins.includes(skin.id)) {
            socket.emit('toast', 'Скин уже куплен');
            return;
        }
        if (currentUser.coins < skin.price) {
            socket.emit('toast', 'Недостаточно монет');
            return;
        }
        currentUser.coins -= skin.price;
        currentUser.ownedSkins.push(skin.id);
        currentUser.equippedSkin = skin.id;
        saveDB();
        socket.emit('profile:update', sanitizeUser(currentUser));
        socket.emit('toast', `Скин «${skin.name}» куплен!`);
    });

    socket.on('shop:equip', ({ skinId }) => {
        if (!currentUser || !currentUser.ownedSkins.includes(skinId)) return;
        currentUser.equippedSkin = skinId;
        saveDB();
        socket.emit('profile:update', sanitizeUser(currentUser));
    });

    // Ежедневные награды
    socket.on('reward:daily_login', () => {
        if (!currentUser) return;
        const today = new Date().toISOString().slice(0, 10);
        if (currentUser.dailyLoginDate === today) return;
        const reward = Math.floor(30 + Math.random() * 71); // 30..100
        currentUser.dailyLoginDate = today;
        currentUser.coins += reward;
        saveDB();
        socket.emit('profile:update', sanitizeUser(currentUser));
        socket.emit('toast', `Ежедневный бонус: +${reward} монет`);
    });

    socket.on('reward:daily_quest', () => {
        if (!currentUser) return;
        const q = currentUser.dailyQuest;
        if (q.claimed || q.progress < q.target) return;
        const reward = Math.floor(75 + Math.random() * 76); // 75..150
        q.claimed = true;
        currentUser.coins += reward;
        saveDB();
        socket.emit('profile:update', sanitizeUser(currentUser));
        socket.emit('toast', `Задание выполнено: +${reward} монет`);
    });

    // Завершение одиночного матча
    socket.on('solo:finish', ({ matchId, result, goals, assists }) => {
        if (!currentUser || !matchId) return;
        const g = Math.max(0, Math.min(30, Number(goals) || 0));
        const a = Math.max(0, Math.min(30, Number(assists) || 0));
        const earned = awardMatchEconomy(currentUser, matchId, result, g, a);
        socket.emit('profile:update', sanitizeUser(currentUser));
        if (earned > 0) socket.emit('toast', `Матч завершён! +${earned} монет`);
    });

    // Админ-функции (строгая проверка прав на сервере)
    socket.on('admin:get_data', () => {
        if (!currentUser || !currentUser.isAdmin) return;
        socket.emit('admin:data', {
            players: Object.values(db.users).map(sanitizeUser),
            logs: db.adminLogs
        });
    });

    socket.on('admin:update_player', ({ targetId, coinsDelta, setCoins, wins, goals, matches: mCount, grantSkin }) => {
        if (!currentUser || !currentUser.isAdmin) return;
        const target = Object.values(db.users).find(u => u.id === targetId);
        if (!target) return;

        if (typeof coinsDelta === 'number' && !isNaN(coinsDelta)) {
            target.coins = Math.max(0, target.coins + coinsDelta);
            logAdmin(currentUser.id, `Изменил монеты ${target.id} на ${coinsDelta}`);
        }
        if (typeof setCoins === 'number' && !isNaN(setCoins)) {
            target.coins = Math.max(0, setCoins);
            logAdmin(currentUser.id, `Установил баланс ${target.id} = ${setCoins}`);
        }
        if (typeof wins === 'number' && !isNaN(wins)) target.stats.wins = Math.max(0, wins);
        if (typeof goals === 'number' && !isNaN(goals)) target.stats.goals = Math.max(0, goals);
        if (typeof mCount === 'number' && !isNaN(mCount)) target.stats.matches = Math.max(0, mCount);
        if (grantSkin && SKINS.some(s => s.id === grantSkin) && !target.ownedSkins.includes(grantSkin)) {
            target.ownedSkins.push(grantSkin);
            logAdmin(currentUser.id, `Выдал скин ${grantSkin} игроку ${target.id}`);
        }
        saveDB();
        socket.emit('admin:data', { players: Object.values(db.users).map(sanitizeUser), logs: db.adminLogs });
        if (target.token === currentUser.token) socket.emit('profile:update', sanitizeUser(currentUser));
    });

    socket.on('admin:create_promo', ({ code, type, value, maxUses }) => {
        if (!currentUser || !currentUser.isAdmin || !code) return;
        const upper = String(code).trim().toUpperCase();
        db.promos[upper] = {
            type: type === 'skin' ? 'skin' : 'coins',
            value: Math.max(1, Number(value) || 50),
            maxUses: Math.max(1, Number(maxUses) || 100),
            usedBy: []
        };
        logAdmin(currentUser.id, `Создал промокод ${upper}`);
        socket.emit('admin:data', { players: Object.values(db.users).map(sanitizeUser), logs: db.adminLogs });
        socket.emit('toast', `Промокод ${upper} создан`);
    });

    // Онлайн матчмейкинг
    socket.on('matchmaking:join', ({ isLandscape }) => {
        if (!currentUser) return;
        leaveCurrentMatch();
        const m = findOrCreateOpenMatch();
        currentMatchId = m.id;
        socket.join(m.id);
        const team = m.players.some(p => p.team === 'blue') ? 'red' : 'blue';
        const skinObj = SKINS.find(s => s.id === currentUser.equippedSkin);
        m.players.push({
            socketId: socket.id,
            token: currentUser.token,
            nickname: currentUser.nickname,
            team,
            color: skinObj ? skinObj.color : '#3b82f6',
            isLandscape: Boolean(isLandscape),
            x: team === 'blue' ? 300 : 900,
            y: FIELD_H / 2,
            vx: 0,
            vy: 0,
            aimX: team === 'blue' ? 1 : -1,
            aimY: 0,
            moveX: 0,
            moveY: 0,
            goals: 0,
            assists: 0
        });
        evaluateLobbyReadiness(m);
    });

    socket.on('player:orientation', ({ isLandscape }) => {
        if (!currentMatchId) return;
        const m = matches.get(currentMatchId);
        if (!m) return;
        const p = m.players.find(x => x.socketId === socket.id);
        if (p) {
            p.isLandscape = Boolean(isLandscape);
            if (m.phase === 'waiting') evaluateLobbyReadiness(m);
        }
    });

    socket.on('player:input', ({ moveX, moveY, aimX, aimY }) => {
        if (!currentMatchId) return;
        const m = matches.get(currentMatchId);
        if (!m || m.phase !== 'playing') return;
        const p = m.players.find(x => x.socketId === socket.id);
        if (!p) return;
        p.moveX = Math.max(-1, Math.min(1, Number(moveX) || 0));
        p.moveY = Math.max(-1, Math.min(1, Number(moveY) || 0));
        const len = Math.hypot(aimX, aimY);
        if (len > 0.01) {
            p.aimX = aimX / len;
            p.aimY = aimY / len;
        }
    });

    socket.on('player:kick', ({ aimX, aimY }) => {
        if (!currentMatchId) return;
        const m = matches.get(currentMatchId);
        if (!m || m.phase !== 'playing' || m.goalCooldown > 0) return;
        const p = m.players.find(x => x.socketId === socket.id);
        if (!p) return;
        const len = Math.hypot(aimX, aimY) || 1;
        p.aimX = (Number(aimX) || p.aimX) / len;
        p.aimY = (Number(aimY) || p.aimY) / len;
        const dist = Math.hypot(m.ball.x - p.x, m.ball.y - p.y);
        if (dist <= PLAYER_R + BALL_R + 24) {
            m.ball.vx = p.aimX * 15.5;
            m.ball.vy = p.aimY * 15.5;
            if (m.lastTouchBy !== p.token) {
                m.prevTouchBy = m.lastTouchBy;
                m.lastTouchBy = p.token;
            }
        }
    });

    function leaveCurrentMatch() {
        if (!currentMatchId) return;
        const m = matches.get(currentMatchId);
        if (m) {
            m.players = m.players.filter(p => p.socketId !== socket.id);
            socket.leave(m.id);
            if (m.players.length === 0) {
                if (m.countdownTimer) clearInterval(m.countdownTimer);
                matches.delete(m.id);
            } else if (m.phase === 'waiting') {
                evaluateLobbyReadiness(m);
            }
        }
        currentMatchId = null;
    }

    socket.on('match:leave', leaveCurrentMatch);
    socket.on('disconnect', leaveCurrentMatch);
});

// Серверный игровой цикл 30 FPS
setInterval(() => {
    const dt = 1 / 30;
    const goalTop = (FIELD_H - GOAL_H) / 2;
    const goalBottom = (FIELD_H + GOAL_H) / 2;

    for (const [id, m] of matches) {
        if (m.phase !== 'playing') continue;
        m.timer -= dt;
        if (m.timer <= 0) {
            m.phase = 'ended';
            for (const p of m.players) {
                const user = db.users[p.token];
                if (!user) continue;
                const won = (p.team === 'blue' && m.scoreBlue > m.scoreRed) || (p.team === 'red' && m.scoreRed > m.scoreBlue);
                const draw = m.scoreBlue === m.scoreRed;
                const res = won ? 'win' : (draw ? 'draw' : 'loss');
                const coinsEarned = awardMatchEconomy(user, m.id, res, p.goals, p.assists);
                io.to(p.socketId).emit('profile:update', sanitizeUser(user));
                io.to(p.socketId).emit('match:end', { coinsEarned });
            }
            matches.delete(id);
            continue;
        }

        if (m.goalCooldown > 0) {
            m.goalCooldown -= dt;
            io.to(m.id).emit('match:state', serializeMatch(m));
            continue;
        }

        for (const p of m.players) {
            p.x = Math.max(PLAYER_R, Math.min(FIELD_W - PLAYER_R, p.x + p.moveX * 5.2));
            p.y = Math.max(PLAYER_R, Math.min(FIELD_H - PLAYER_R, p.y + p.moveY * 5.2));
        }

        const steps = 4;
        for (let s = 0; s < steps; s++) {
            m.ball.x += m.ball.vx / steps;
            m.ball.y += m.ball.vy / steps;

            for (const p of m.players) {
                const dx = m.ball.x - p.x;
                const dy = m.ball.y - p.y;
                const d = Math.hypot(dx, dy);
                const minD = PLAYER_R + BALL_R;
                if (d < minD && d > 0.001) {
                    const nx = dx / d;
                    const ny = dy / d;
                    m.ball.x = p.x + nx * minD;
                    m.ball.y = p.y + ny * minD;
                    m.ball.vx = nx * 6.5 + p.moveX * 3.5;
                    m.ball.vy = ny * 6.5 + p.moveY * 3.5;
                    if (m.lastTouchBy !== p.token) {
                        m.prevTouchBy = m.lastTouchBy;
                        m.lastTouchBy = p.token;
                    }
                }
            }

            if (m.ball.y - BALL_R < 0) {
                m.ball.y = BALL_R;
                m.ball.vy = Math.abs(m.ball.vy) * 0.85;
            } else if (m.ball.y + BALL_R > FIELD_H) {
                m.ball.y = FIELD_H - BALL_R;
                m.ball.vy = -Math.abs(m.ball.vy) * 0.85;
            }

            const inGoalY = m.ball.y >= goalTop && m.ball.y <= goalBottom;
            if (m.ball.x - BALL_R <= 0) {
                if (inGoalY) {
                    registerOnlineGoal(m, 'red');
                    break;
                } else {
                    m.ball.x = BALL_R;
                    m.ball.vx = Math.abs(m.ball.vx) * 0.85;
                }
            }
            if (m.ball.x + BALL_R >= FIELD_W) {
                if (inGoalY) {
                    registerOnlineGoal(m, 'blue');
                    break;
                } else {
                    m.ball.x = FIELD_W - BALL_R;
                    m.ball.vx = -Math.abs(m.ball.vx) * 0.85;
                }
            }
        }

        m.ball.vx *= 0.985;
        m.ball.vy *= 0.985;
        io.to(m.id).emit('match:state', serializeMatch(m));
    }
}, 1000 / 30);

function registerOnlineGoal(m, scoringTeam) {
    if (m.goalCooldown > 0) return;
    m.goalCooldown = 1.5;

    const scorer = m.players.find(p => p.token === m.lastTouchBy);
    const assister = m.players.find(p => p.token === m.prevTouchBy);
    const isOwnGoal = scorer && scorer.team !== scoringTeam;

    if (scoringTeam === 'blue') m.scoreBlue++;
    else m.scoreRed++;

    if (!isOwnGoal && scorer) {
        scorer.goals++;
        if (assister && assister.team === scoringTeam && assister.token !== scorer.token) {
            assister.assists++;
        }
    }

    io.to(m.id).emit('toast', isOwnGoal ? 'АВТОГОЛ!' : `ГОЛ! Забила команда ${scoringTeam === 'blue' ? 'Синих' : 'Красных'}!`);
    m.lastTouchBy = null;
    m.prevTouchBy = null;
    setTimeout(() => resetMatchPositions(m), 800);
}

server.listen(PORT, () => {
    console.log(`Ball Brawl server running on http://localhost:${PORT}`);
});
