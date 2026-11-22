<!DOCTYPE html>
<html lang="ru">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no, viewport-fit=cover" />
  <meta name="apple-mobile-web-app-capable" content="yes" />
  <meta name="mobile-web-app-capable" content="yes" />
  <meta name="theme-color" content="#0b1120" />
  <title>Ball Brawl Pro — Online & LAN Football</title>
  <script src="/socket.io/socket.io.js"></script>
  <style>
    :root {
      --bg: #0b1120;
      --panel: rgba(15, 23, 42, 0.92);
      --border: rgba(148, 163, 184, 0.22);
      --accent: #38bdf8;
      --accent-2: #22c55e;
      --danger: #ef4444;
      --gold: #facc15;
      --text: #f8fafc;
      --muted: #94a3b8;
    }
    * { box-sizing: border-box; -webkit-tap-highlight-color: transparent; user-select: none; }
    html, body {
      margin: 0; padding: 0; width: 100%; height: 100%;
      overflow: hidden; background: var(--bg); color: var(--text);
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
    }
    #gameCanvas {
      display: block; width: 100vw; height: 100vh;
      touch-action: none; background: #184221;
    }
    .overlay {
      position: fixed; inset: 0; z-index: 20;
      display: flex; align-items: center; justify-content: center;
      background: radial-gradient(circle at top, rgba(30,41,59,0.92), rgba(11,17,32,0.97));
      padding: 12px; overflow-y: auto;
    }
    .hidden { display: none !important; }
    .card {
      width: 100%; max-width: 960px; max-height: 94vh;
      background: var(--panel); border: 1px solid var(--border);
      border-radius: 18px; padding: 16px 18px; overflow-y: auto;
      box-shadow: 0 24px 60px rgba(0,0,0,0.6);
    }
    .row { display: flex; gap: 10px; flex-wrap: wrap; align-items: center; }
    .between { display: flex; justify-content: space-between; align-items: center; gap: 10px; }
    .grid-2 { display: grid; grid-template-columns: repeat(auto-fit, minmax(260px, 1fr)); gap: 12px; }
    .grid-3 { display: grid; grid-template-columns: repeat(auto-fit, minmax(180px, 1fr)); gap: 10px; }
    h1, h2, h3 { margin: 0 0 8px 0; }
    .badge {
      display: inline-flex; align-items: center; gap: 5px;
      padding: 4px 10px; border-radius: 999px; font-size: 12px; font-weight: 700;
      background: rgba(56, 189, 248, 0.16); border: 1px solid rgba(56, 189, 248, 0.35);
    }
    .badge.gold { background: rgba(250, 204, 21, 0.16); border-color: rgba(250, 204, 21, 0.4); color: var(--gold); }
    .badge.green { background: rgba(34, 197, 94, 0.16); border-color: rgba(34, 197, 94, 0.4); color: #4ade80; }
    .btn {
      border: 1px solid var(--border); background: rgba(30, 41, 59, 0.95);
      color: var(--text); padding: 10px 14px; border-radius: 12px;
      font-weight: 700; font-size: 13px; cursor: pointer; transition: transform .08s, background .15s;
    }
    .btn:active { transform: scale(0.96); }
    .btn.primary { background: linear-gradient(135deg, #0284c7, #2563eb); border-color: #38bdf8; }
    .btn.success { background: linear-gradient(135deg, #16a34a, #15803d); border-color: #4ade80; }
    .btn.danger { background: linear-gradient(135deg, #dc2626, #991b1b); border-color: #f87171; }
    .btn.gold { background: linear-gradient(135deg, #ca8a04, #a16207); border-color: #facc15; }
    .btn.sm { padding: 6px 10px; font-size: 12px; border-radius: 9px; }
    input, select {
      width: 100%; padding: 9px 11px; border-radius: 10px;
      border: 1px solid var(--border); background: rgba(15, 23, 42, 0.9);
      color: var(--text); font-size: 13px; outline: none;
    }
    label { display: block; font-size: 11px; color: var(--muted); margin-bottom: 4px; font-weight: 600; }
    .tabs { display: flex; gap: 6px; overflow-x: auto; padding-bottom: 6px; margin-bottom: 12px; border-bottom: 1px solid var(--border); }
    .tab {
      padding: 8px 12px; border-radius: 10px; font-size: 12px; font-weight: 700;
      background: rgba(30,41,59,0.65); border: 1px solid transparent; cursor: pointer; white-space: nowrap;
    }
    .tab.active { background: rgba(56, 189, 248, 0.2); border-color: var(--accent); color: var(--accent); }
    .box {
      background: rgba(30, 41, 59, 0.55); border: 1px solid var(--border);
      border-radius: 14px; padding: 12px;
    }
    .list-item {
      display: flex; justify-content: space-between; align-items: center; gap: 8px;
      padding: 8px 10px; border-radius: 10px; background: rgba(15,23,42,0.75);
      border: 1px solid rgba(148,163,184,0.14); margin-bottom: 6px; font-size: 13px;
    }
    /* HUD */
    #hud {
      position: fixed; inset: 0; pointer-events: none; z-index: 10;
    }
    .scoreboard {
      position: absolute; top: 10px; left: 50%; transform: translateX(-50%);
      display: flex; align-items: center; gap: 12px;
      background: rgba(15, 23, 42, 0.85); border: 1px solid var(--border);
      padding: 6px 16px; border-radius: 999px; font-weight: 800; font-size: 15px;
      backdrop-filter: blur(6px);
    }
    .team-pill { padding: 3px 10px; border-radius: 999px; }
    .team-red { background: rgba(239,68,68,0.28); color: #fca5a5; }
    .team-blue { background: rgba(59,130,246,0.28); color: #93c5fd; }
    .hud-top-right {
      position: absolute; top: 10px; right: 12px; display: flex; gap: 6px; pointer-events: auto;
    }
    .hud-top-left {
      position: absolute; top: 10px; left: 12px; display: flex; flex-direction: column; gap: 4px;
      font-size: 11px; color: var(--muted);
    }
    .stamina-wrap {
      width: 130px; height: 8px; background: rgba(15,23,42,0.85);
      border: 1px solid var(--border); border-radius: 999px; overflow: hidden;
    }
    #staminaFill { width: 100%; height: 100%; background: linear-gradient(90deg, #22c55e, #38bdf8); transition: width .08s; }
    /* Touch Controls */
    #touchControls {
      position: fixed; inset: 0; pointer-events: none; z-index: 12;
    }
    .joy-zone {
      position: absolute; left: 24px; bottom: 24px; width: 132px; height: 132px;
      border-radius: 50%; background: rgba(148,163,184,0.14); border: 2px solid rgba(148,163,184,0.3);
      pointer-events: auto; touch-action: none;
    }
    .joy-knob {
      position: absolute; left: 50%; top: 50%; width: 52px; height: 52px;
      margin-left: -26px; margin-top: -26px; border-radius: 50%;
      background: rgba(56,189,248,0.65); border: 2px solid #fff;
      pointer-events: none;
    }
    .act-btn {
      position: absolute; width: 64px; height: 64px; border-radius: 50%;
      display: flex; flex-direction: column; align-items: center; justify-content: center;
      font-size: 11px; font-weight: 800; color: #fff;
      background: rgba(15, 23, 42, 0.78); border: 2px solid rgba(255,255,255,0.32);
      pointer-events: auto; touch-action: none; box-shadow: 0 6px 18px rgba(0,0,0,0.45);
    }
    .act-btn.charging { border-color: var(--gold); box-shadow: 0 0 18px rgba(250,204,21,0.7); transform: scale(1.08); }
    .act-btn.cd { opacity: 0.45; }
    .toast {
      position: fixed; top: 62px; left: 50%; transform: translateX(-50%);
      z-index: 60; background: rgba(15,23,42,0.95); border: 1px solid var(--accent);
      padding: 8px 16px; border-radius: 12px; font-size: 13px; font-weight: 700;
      box-shadow: 0 10px 30px rgba(0,0,0,0.5);
    }
    .banner {
      position: fixed; top: 28%; left: 50%; transform: translate(-50%, -50%);
      z-index: 18; font-size: 36px; font-weight: 900; text-align: center;
      text-shadow: 0 4px 20px rgba(0,0,0,0.85); pointer-events: none;
    }
  </style>
</head>
<body>
  <canvas id="gameCanvas"></canvas>

  <!-- HUD -->
  <div id="hud" class="hidden">
    <div class="hud-top-left">
      <div id="hudNetInfo">PING: -- ms | ELO: 1000</div>
      <div class="stamina-wrap"><div id="staminaFill"></div></div>
      <div id="hudBuffInfo" style="color:#38bdf8;font-weight:700;"></div>
    </div>
    <div class="scoreboard">
      <span class="team-pill team-red">RED <span id="scoreRed">0</span></span>
      <span id="hudTimer">02:00</span>
      <span class="team-pill team-blue"><span id="scoreBlue">0</span> BLUE</span>
    </div>
    <div class="hud-top-right">
      <button class="btn sm" onclick="sendEmote('🔥')">🔥</button>
      <button class="btn sm" onclick="sendEmote('👏')">👏</button>
      <button class="btn sm" onclick="openControlEditor()">🎛️</button>
      <button class="btn sm danger" onclick="leaveMatchToMenu()">Выход</button>
    </div>
  </div>

  <!-- TOUCH / CUSTOMIZABLE CONTROLS -->
  <div id="touchControls" class="hidden">
    <div id="joyZone" class="joy-zone"><div id="joyKnob" class="joy-knob"></div></div>
    <button id="btnKick" class="act-btn" style="right:28px;bottom:28px;background:rgba(239,68,68,0.72);">УДАР</button>
    <button id="btnPass" class="act-btn" style="right:108px;bottom:24px;background:rgba(34,197,94,0.72);">ПАС</button>
    <button id="btnLob" class="act-btn" style="right:178px;bottom:68px;background:rgba(59,130,246,0.72);">НАВЕС</button>
    <button id="btnFinesse" class="act-btn" style="right:104px;bottom:102px;background:rgba(168,85,247,0.72);">КРУЧ.</button>
    <button id="btnDash" class="act-btn" style="right:26px;bottom:108px;background:rgba(234,179,8,0.75);">РЫВОК</button>
    <button id="btnTackle" class="act-btn" style="right:178px;bottom:146px;background:rgba(249,115,22,0.72);">ОТБОР</button>
    <button id="btnAbility" class="act-btn" style="right:26px;bottom:186px;background:rgba(14,165,233,0.8);">НАВЫК</button>
  </div>

  <div id="bannerText" class="banner hidden"></div>
  <div id="toastBox" class="toast hidden"></div>

  <!-- MAIN MENU -->
  <div id="menuOverlay" class="overlay">
    <div class="card">
      <div class="between" style="margin-bottom:10px;">
        <div>
          <h2 style="display:flex;align-items:center;gap:8px;">⚽ Ball Brawl Pro <span class="badge">v2.0</span></h2>
          <div style="font-size:12px;color:var(--muted);" id="accIdLabel">ID: --</div>
        </div>
        <div class="row">
          <span class="badge gold">🪙 <span id="uiCoins">0</span></span>
          <span class="badge">🏆 ELO <span id="uiElo">1000</span></span>
          <span class="badge green" id="uiConnStatus">Онлайн</span>
        </div>
      </div>

      <div class="tabs">
        <div class="tab active" data-tab="play" onclick="switchTab('play')">🎮 Играть</div>
        <div class="tab" data-tab="tactics" onclick="switchTab('tactics')">📋 Тактика и Навык</div>
        <div class="tab" data-tab="lan" onclick="switchTab('lan')">📡 Локальная сеть (LAN)</div>
        <div class="tab" data-tab="shop" onclick="switchTab('shop')">🛒 Магазин и Сезон</div>
        <div class="tab" data-tab="friends" onclick="switchTab('friends')">👥 Друзья</div>
        <div class="tab" data-tab="promo" onclick="switchTab('promo')">🎁 Промокоды</div>
        <div class="tab hidden" id="tabAdminBtn" data-tab="admin" onclick="switchTab('admin')">🛡️ Админ</div>
      </div>

      <!-- TAB: PLAY -->
      <div id="tab-play" class="tab-pane">
        <div class="grid-2">
          <div class="box">
            <h3>Профиль игрока</h3>
            <div class="grid-2">
              <div>
                <label>Никнейм</label>
                <input id="inpNick" maxlength="14" placeholder="Игрок" />
              </div>
              <div>
                <label>Номер на форме (0-99)</label>
                <input id="inpNum" type="number" min="0" max="99" value="10" />
              </div>
              <div>
                <label>Цвет формы</label>
                <input id="inpColor" type="color" value="#ff3366" style="height:38px;padding:3px;" />
              </div>
              <div>
                <label>Регион подбора</label>
                <select id="selRegion">
                  <option value="auto">Авто (мин. пинг)</option>
                  <option value="ru">Восточная Европа / RU</option>
                  <option value="eu">Европа (EU)</option>
                  <option value="us">Северная Америка (US)</option>
                  <option value="asia">Азия (ASIA)</option>
                </select>
              </div>
              <div>
                <label>Скин игрока</label>
                <select id="selPlayerSkin"></select>
              </div>
              <div>
                <label>Скин мяча</label>
                <select id="selBallSkin"></select>
              </div>
            </div>
            <div class="row" style="margin-top:10px;">
              <button class="btn sm" onclick="openControlEditor()">🎛️ Настроить кнопки управления</button>
            </div>
          </div>

          <div class="box">
            <h3>Быстрый матч и режимы</h3>
            <div class="grid-2" style="margin-bottom:10px;">
              <div>
                <label>Формат</label>
                <select id="selTeamSize">
                  <option value="1">1 на 1 (Дуэль)</option>
                  <option value="2" selected>2 на 2 (Командный)</option>
                </select>
              </div>
              <div>
                <label>Арена (для офлайн / приват.)</label>
                <select id="selArena">
                  <option value="classic">Классический стадион</option>
                  <option value="neon_stadium">Ночной Неон-Стадион</option>
                  <option value="desert_pitch">Пустынная Арена (с препятствиями)</option>
                  <option value="snow_cup">Зимний Кубок (скользкий лёд)</option>
                  <option value="ice">Ледовая Арена</option>
                  <option value="obstacles">Тактическая с блоками</option>
                  <option value="narrow">Узкое скоростное поле</option>
                </select>
              </div>
            </div>
            <div class="row">
              <button class="btn primary" style="flex:1;" onclick="startOnlineMatchmaking()">⚡ Найти онлайн-матч (ELO)</button>
              <button class="btn success" style="flex:1;" onclick="startOfflineBotMatch()">🤖 Тренировка с ботами</button>
            </div>

            <hr style="border-color:var(--border);margin:12px 0;" />
            <h3>Приватные комнаты</h3>
            <div class="row" style="margin-bottom:8px;">
              <button class="btn gold" onclick="createPrivateRoomUI()">🔒 Создать приватную комнату</button>
              <input id="inpPrivCode" placeholder="Код комнаты (6 симв.)" style="max-width:180px;text-transform:uppercase;" />
              <button class="btn" onclick="joinPrivateRoomUI()">Войти по коду</button>
            </div>
            <div class="row">
              <label style="display:flex;align-items:center;gap:6px;margin:0;"><input type="checkbox" id="chkOvertime" checked style="width:auto;" /> Овертайм</label>
              <label style="display:flex;align-items:center;gap:6px;margin:0;"><input type="checkbox" id="chkGoldenGoal" style="width:auto;" /> Золотой гол</label>
              <label style="display:flex;align-items:center;gap:6px;margin:0;"><input type="checkbox" id="chkAutoBalance" checked style="width:auto;" /> Автобаланс</label>
            </div>
          </div>
        </div>
      </div>

      <!-- TAB: TACTICS -->
      <div id="tab-tactics" class="tab-pane hidden">
        <div class="grid-3">
          <div class="box">
            <h3>Схема (Расстановка)</h3>
            <select id="selFormation">
              <option value="4-3-3">4-3-3 (Атакующий выдвинутый старт)</option>
              <option value="4-4-2">4-4-2 (Сбалансированная классика)</option>
              <option value="3-5-2">3-5-2 (Широкий охват флангов)</option>
              <option value="5-3-2">5-3-2 (Глубокая оборона)</option>
            </select>
            <p style="font-size:12px;color:var(--muted);margin-top:8px;">Влияет на стартовую позицию игроков при розыгрыше с центра поля и ширину построения.</p>
          </div>
          <div class="box">
            <h3>Тактика команды</h3>
            <select id="selTactic">
              <option value="balanced">Сбалансированная (100% скорость / удар)</option>
              <option value="attack">Атакующая (+6% скорость, +10% удар, -20% стамина)</option>
              <option value="defense">Оборонительная (+15% экономия выносливости)</option>
              <option value="press">Высокий прессинг (+9% скорость, высокий расход сил)</option>
            </select>
            <p style="font-size:12px;color:var(--muted);margin-top:8px;">Определяет баланс между максимальной скоростью, силой удара и расходом выносливости.</p>
          </div>
          <div class="box">
            <h3>Активная способность</h3>
            <select id="selAbility">
              <option value="turbo_surge">⚡ Турбо-рывок (мгновенный импульс и +22% скорость)</option>
              <option value="power_cannon">💥 Пушечный удар (+25% к силе ударов на 2.8с)</option>
              <option value="magnet_dribble">🧲 Магнит мяча (притягивает свободный мяч рядом)</option>
              <option value="iron_wall">🛡️ Железный блок (устойчивость в силовых стыках)</option>
            </select>
            <p style="font-size:12px;color:var(--muted);margin-top:8px;">Активируется кнопкой «НАВЫК» (перезарядка 6.5 сек).</p>
          </div>
        </div>
        <div style="margin-top:10px;">
          <button class="btn primary" onclick="savePrefsUI()">💾 Сохранить тактику и способности</button>
        </div>
      </div>

      <!-- TAB: LAN -->
      <div id="tab-lan" class="tab-pane hidden">
        <div class="grid-2">
          <div class="box">
            <h3>Создать LAN-игру (Локальная сеть / Wi-Fi)</h3>
            <p style="font-size:12px;color:var(--muted);">Работает без интернета по прямому WebRTC DataChannel между устройствами в одной локальной сети или через обмен кодом приглашения.</p>
            <button class="btn success" onclick="lanCreateHost()">📡 Создать локальный сервер (Хост)</button>
            <div id="lanHostPanel" class="hidden" style="margin-top:10px;">
              <label>1. Отправьте этот код приглашения (Offer) второму игроку:</label>
              <textarea id="lanOfferOut" rows="3" readonly style="width:100%;background:#0f172a;color:#38bdf8;border-radius:8px;padding:6px;font-size:11px;"></textarea>
              <label style="margin-top:6px;">2. Вставьте ответный код (Answer) от второго игрока:</label>
              <textarea id="lanAnswerIn" rows="3" style="width:100%;background:#0f172a;color:#fff;border-radius:8px;padding:6px;font-size:11px;"></textarea>
              <button class="btn primary sm" style="margin-top:6px;" onclick="lanHostAcceptAnswer()">Подключить игрока и начать LAN-матч</button>
            </div>
          </div>
          <div class="box">
            <h3>Подключиться к LAN-игре</h3>
            <label>1. Вставьте код приглашения (Offer) от хоста:</label>
            <textarea id="lanOfferIn" rows="3" style="width:100%;background:#0f172a;color:#fff;border-radius:8px;padding:6px;font-size:11px;"></textarea>
            <button class="btn primary sm" style="margin-top:6px;" onclick="lanJoinCreateAnswer()">Сгенерировать ответный код (Answer)</button>
            <div id="lanClientPanel" class="hidden" style="margin-top:8px;">
              <label>2. Передайте этот ответный код хосту:</label>
              <textarea id="lanAnswerOut" rows="3" readonly style="width:100%;background:#0f172a;color:#4ade80;border-radius:8px;padding:6px;font-size:11px;"></textarea>
            </div>
          </div>
        </div>
      </div>

      <!-- TAB: SHOP & SEASON -->
      <div id="tab-shop" class="tab-pane hidden">
        <div class="grid-2">
          <div class="box">
            <h3>Скины игрока</h3>
            <div id="shopPlayerSkins"></div>
          </div>
          <div class="box">
            <h3>Скины мяча</h3>
            <div id="shopBallSkins"></div>
          </div>
        </div>
        <div class="box" style="margin-top:12px;">
          <div class="between">
            <h3>Сезонный пропуск и квесты</h3>
            <span class="badge">XP: <span id="uiSeasonXp">0</span></span>
          </div>
          <div id="seasonQuestsList" style="margin-top:8px;"></div>
        </div>
      </div>

      <!-- TAB: FRIENDS -->
      <div id="tab-friends" class="tab-pane hidden">
        <div class="grid-2">
          <div class="box">
            <h3>Поиск игроков по нику или ID</h3>
            <div class="row" style="margin-bottom:8px;">
              <input id="inpFriendSearch" placeholder="Ник или acc_..." />
              <button class="btn primary sm" onclick="searchPlayersUI()">Найти</button>
            </div>
            <div id="friendSearchResults"></div>
          </div>
          <div class="box">
            <h3>Мои друзья и входящие заявки</h3>
            <div id="friendRequestsBox"></div>
            <div id="friendsListBox"></div>
          </div>
        </div>
      </div>

      <!-- TAB: PROMO -->
      <div id="tab-promo" class="tab-pane hidden">
        <div class="box" style="max-width:460px;">
          <h3>Активация промокода</h3>
          <p style="font-size:12px;color:var(--muted);">Доступные стартовые коды: WELCOME, BALL2026, GOALMASTER, FREESKIN</p>
          <div class="row">
            <input id="inpPromo" placeholder="Введите код..." />
            <button class="btn gold" onclick="redeemPromoUI()">Активировать</button>
          </div>
        </div>
      </div>

      <!-- TAB: ADMIN -->
      <div id="tab-admin" class="tab-pane hidden">
        <div class="box">
          <div class="between">
            <h3>Панель администратора</h3>
            <button class="btn sm" onclick="loadAdminDashboard()">Обновить</button>
          </div>
          <div id="adminContent" style="margin-top:10px;font-size:12px;"></div>
        </div>
      </div>
    </div>
  </div>

  <!-- LOBBY OVERLAY -->
  <div id="lobbyOverlay" class="overlay hidden">
    <div class="card" style="max-width:680px;">
      <div class="between" style="margin-bottom:10px;">
        <div>
          <h2 id="lobbyTitle">Комната ожидания</h2>
          <div style="font-size:12px;color:var(--muted);" id="lobbySub">Ожидание игроков...</div>
        </div>
        <button class="btn danger sm" onclick="leaveLobby()">Покинуть</button>
      </div>
      <div id="lobbyPlayersList" style="margin-bottom:12px;"></div>
      <div class="row">
        <button class="btn sm" onclick="socket && socket.emit('switchTeam','red')">За Красных</button>
        <button class="btn sm" onclick="socket && socket.emit('switchTeam','blue')">За Синих</button>
        <button class="btn sm" onclick="socket && socket.emit('switchTeam','spec')">Зритель</button>
        <button class="btn success sm" onclick="socket && socket.emit('setOrientationReady',{ready:true})">✅ Готов к матчу</button>
      </div>
    </div>
  </div>

  <!-- CONTROL LAYOUT EDITOR OVERLAY -->
  <div id="controlEditorOverlay" class="overlay hidden" style="background:rgba(11,17,32,0.78);">
    <div class="card" style="max-width:460px;">
      <h3>🎛️ Редактор кнопок управления</h3>
      <p style="font-size:12px;color:var(--muted);">Перетаскивайте кнопки по экрану, измените их масштаб или сбросьте по умолчанию.</p>
      <div style="margin:10px 0;">
        <label>Размер кнопок: <span id="ctrlScaleVal">100%</span></label>
        <input id="ctrlScaleRange" type="range" min="75" max="140" value="100" oninput="previewControlScale(this.value)" />
      </div>
      <div class="row">
        <button class="btn primary" onclick="saveCustomControlsUI()">Сохранить расположение</button>
        <button class="btn" onclick="resetCustomControlsUI()">Сбросить</button>
        <button class="btn danger" onclick="closeControlEditor()">Закрыть</button>
      </div>
    </div>
  </div>

  <script>
    // ==== STATE & CONFIG ====
    const PLAYER_SKINS = {
      plain: { name: 'Стандарт', price: 0 },
      star:  { name: 'Звезда (Обычный)', price: 500 },
      fire:  { name: 'Пламя (Редкий)', price: 1000 },
      ice:   { name: 'Лёд (Эпик)', price: 2000 },
      metal: { name: 'Титан (Легендарный)', price: 4000 }
    };
    const BALL_SKINS = {
      classic: { name: 'Классика', price: 0 },
      beach:   { name: 'Пляжный (Обычный)', price: 500 },
      fire:    { name: 'Огненный (Редкий)', price: 1000 },
      ice:     { name: 'Ледяной (Редкий)', price: 1000 },
      neon:    { name: 'Неон (Эпик)', price: 2000 },
      star:    { name: 'Чемпионский (Легендарный)', price: 4000 }
    };
    const ARENA_THEMES = {
      classic:      { w: 1800, h: 1100, grass1: '#23632b', grass2: '#1f5726', line: 'rgba(255,255,255,0.75)', obstacles: [] },
      neon_stadium: { w: 1860, h: 1120, grass1: '#0f1f33', grass2: '#132842', line: '#38bdf8', obstacles: [] },
      desert_pitch: { w: 1840, h: 1080, grass1: '#526e2a', grass2: '#465e23', line: '#fde047', obstacles: [[-420,0,70,70],[420,0,70,70]] },
      snow_cup:     { w: 1800, h: 1100, grass1: '#255c73', grass2: '#2d6c87', line: '#e0f2fe', obstacles: [] },
      ice:          { w: 1800, h: 1100, grass1: '#1f5a78', grass2: '#24688a', line: '#bae6fd', obstacles: [] },
      obstacles:    { w: 1900, h: 1200, grass1: '#24662c', grass2: '#1e5424', line: '#fff', obstacles: [[-300,-200,100,60],[300,200,100,60],[0,0,80,80]] },
      narrow:       { w: 2400, h: 800,  grass1: '#24662c', grass2: '#1f5726', line: '#fff', obstacles: [] }
    };

    let account = null;
    let sessionToken = localStorage.getItem('bb_session_token') || '';
    let savedAccId = localStorage.getItem('bb_account_id') || '';
    let socket = null;
    let pingMs = 0;

    let gameModeType = 'none'; // 'online' | 'offline' | 'lan_host' | 'lan_client'
    let currentRoom = null;
    let matchState = null;
    let localPlayers = {};
    let localBalls = [];
    let matchSettings = { arena: 'classic', mode: 'classic', ballSkin: 'classic' };
    let score = { red: 0, blue: 0 };
    let timerSec = 120;
    let netWave = { left: 0, right: 0 };
    let shakePower = 0;
    let particles = [];
    let emotesFloating = [];

    // Input & Touch
    const keys = {};
    const joyVec = { x: 0, y: 0 };
    let inputSeq = 0;
    let chargeState = { active: false, type: null, startTs: 0 };
    let customControls = null;
    let editingControls = false;

    // ==== UI HELPERS ====
    function showToast(msg) {
      const el = document.getElementById('toastBox');
      el.textContent = msg;
      el.classList.remove('hidden');
      clearTimeout(el._t);
      el._t = setTimeout(() => el.classList.add('hidden'), 3200);
    }

    function showBanner(msg, color = '#fff', ms = 1800) {
      const el = document.getElementById('bannerText');
      el.textContent = msg;
      el.style.color = color;
      el.classList.remove('hidden');
      clearTimeout(el._t);
      el._t = setTimeout(() => el.classList.add('hidden'), ms);
    }

    function switchTab(name) {
      document.querySelectorAll('.tab').forEach(t => t.classList.toggle('active', t.dataset.tab === name));
      document.querySelectorAll('.tab-pane').forEach(p => p.classList.add('hidden'));
      const pane = document.getElementById('tab-' + name);
      if (pane) pane.classList.remove('hidden');
      if (name === 'admin') loadAdminDashboard();
    }

    function syncAccountUI() {
      if (!account) return;
      localStorage.setItem('bb_account_id', account.id);
      document.getElementById('accIdLabel').textContent = `ID: ${account.id} | Побед: ${account.wins} | Голов: ${account.goals}`;
      document.getElementById('uiCoins').textContent = account.coins;
      document.getElementById('uiElo').textContent = account.elo || 1000;
      document.getElementById('uiSeasonXp').textContent = account.season?.xp || 0;
      if (!document.getElementById('inpNick').value) document.getElementById('inpNick').value = account.nick;

      if (account.playerPrefs) {
        document.getElementById('selFormation').value = account.playerPrefs.formation || '4-3-3';
        document.getElementById('selTactic').value = account.playerPrefs.tactic || 'balanced';
        document.getElementById('selAbility').value = account.playerPrefs.ability || 'turbo_surge';
        document.getElementById('selRegion').value = account.playerPrefs.region || 'auto';
      }

      // Skins selects
      const pSel = document.getElementById('selPlayerSkin');
      const curP = pSel.value;
      pSel.innerHTML = account.ownedSkins.map(id => `<option value="${id}">${PLAYER_SKINS[id]?.name || id}</option>`).join('');
      if (account.ownedSkins.includes(curP)) pSel.value = curP;

      const bSel = document.getElementById('selBallSkin');
      const curB = bSel.value;
      bSel.innerHTML = account.ownedBallSkins.map(id => `<option value="${id}">${BALL_SKINS[id]?.name || id}</option>`).join('');
      if (account.ownedBallSkins.includes(curB)) bSel.value = curB;

      // Shop lists
      document.getElementById('shopPlayerSkins').innerHTML = Object.entries(PLAYER_SKINS).map(([id, info]) => {
        const owned = account.ownedSkins.includes(id);
        return `<div class="list-item"><span>${info.name}</span>${owned
          ? '<span class="badge green">Куплено</span>'
          : `<button class="btn gold sm" onclick="buySkinUI('player','${id}')">🪙 ${info.price}</button>`}</div>`;
      }).join('');

      document.getElementById('shopBallSkins').innerHTML = Object.entries(BALL_SKINS).map(([id, info]) => {
        const owned = account.ownedBallSkins.includes(id);
        return `<div class="list-item"><span>${info.name}</span>${owned
          ? '<span class="badge green">Куплено</span>'
          : `<button class="btn gold sm" onclick="buySkinUI('ball','${id}')">🪙 ${info.price}</button>`}</div>`;
      }).join('');

      // Quests
      const q = account.season?.quests || { goals: 0, passes: 0, wins: 0, claimed: {} };
      const qDefs = [
        { key: 'goals', title: 'Забить 5 голов', cur: q.goals || 0, max: 5, rew: 120 },
        { key: 'passes', title: 'Сделать 15 передач', cur: q.passes || 0, max: 15, rew: 90 },
        { key: 'wins', title: 'Выиграть 2 матча', cur: q.wins || 0, max: 2, rew: 150 }
      ];
      document.getElementById('seasonQuestsList').innerHTML = qDefs.map(item => {
        const done = item.cur >= item.max;
        const claimed = q.claimed?.[item.key];
        return `<div class="list-item">
          <span>${item.title} (${Math.min(item.cur, item.max)}/${item.max})</span>
          ${claimed ? '<span class="badge">Получено</span>' : (done
            ? `<button class="btn success sm" onclick="claimQuestUI('${item.key}')">Забрать +${item.rew}</button>`
            : `<span class="badge gold">+${item.rew} 🪙</span>`)}
        </div>`;
      }).join('');

      if (account.customControls) {
        customControls = account.customControls;
        applyCustomControlsLayout();
      }
    }

    // ==== SOCKET CONNECTION ====
    function initSocket() {
      if (typeof io === 'undefined') {
        document.getElementById('uiConnStatus').textContent = 'Офлайн / LAN';
        return;
      }
      socket = io({ transports: ['websocket', 'polling'] });
      socket.on('connect', () => {
        document.getElementById('uiConnStatus').textContent = 'Онлайн';
        socket.emit('authAccount', {
          accountId: savedAccId,
          sessionToken,
          nick: localStorage.getItem('bb_nick') || ''
        }, (res) => {
          if (res && res.ok) {
            account = res.account;
            if (res.sessionToken) {
              sessionToken = res.sessionToken;
              localStorage.setItem('bb_session_token', sessionToken);
            }
            syncAccountUI();
            if (res.friendsData) renderFriendsUI(res.friendsData);
            if (res.dailyBonus > 0) showToast(`Ежедневный бонус за вход: +${res.dailyBonus} монет!`);
          }
        });
      });

      socket.on('disconnect', () => {
        document.getElementById('uiConnStatus').textContent = 'Переподключение...';
      });

      socket.on('accountSynced', (acc) => { account = acc; syncAccountUI(); });
      socket.on('friendsUpdate', renderFriendsUI);
      socket.on('friendRequestReceived', (d) => showToast(`Запрос в друзья от ${d.fromNick}`));
      socket.on('matchInviteReceived', (inv) => {
        if (confirm(`Игрок ${inv.fromNick} приглашает вас в приватный матч (${inv.inviteCode}). Принять?`)) {
          socket.emit('respondMatchInvite', { inviteId: inv.inviteId, accept: true });
          document.getElementById('inpPrivCode').value = inv.inviteCode;
          joinPrivateRoomUI();
        }
      });

      socket.on('lobbyUpdate', (data) => {
        currentRoom = data;
        document.getElementById('menuOverlay').classList.add('hidden');
        document.getElementById('lobbyOverlay').classList.remove('hidden');
        document.getElementById('lobbyTitle').textContent = data.isPrivate
          ? `Приватная комната • Код: ${data.inviteCode}`
          : `Онлайн-лобби (${data.region?.toUpperCase() || 'EU'})`;
        document.getElementById('lobbySub').textContent = `Игроков: ${data.players.length} | Формат: ${data.settings.teamSize}v${data.settings.teamSize}`;
        document.getElementById('lobbyPlayersList').innerHTML = data.players.map(p => `
          <div class="list-item">
            <span><b>${p.name}</b> [ELO ${p.elo || 1000}] • ${p.formation}</span>
            <span>
              <span class="badge ${p.team === 'red' ? '' : 'green'}">${p.team.toUpperCase()}</span>
              ${p.ready ? '✅' : '⏳'}
            </span>
          </div>
        `).join('');
      });

      socket.on('countdown', ({ seconds }) => showBanner(`Матч через ${seconds}...`, '#facc15', 2800));
      socket.on('countdownCancelled', ({ reason }) => showToast(reason || 'Отсчёт отменён'));

      socket.on('gameStarted', (data) => {
        gameModeType = 'online';
        matchSettings = data.settings;
        localPlayers = {};
        data.players.forEach(p => { localPlayers[p.id] = { ...p, x: 0, y: 0, vx: 0, vy: 0, stamina: 100 }; });
        document.getElementById('lobbyOverlay').classList.add('hidden');
        document.getElementById('menuOverlay').classList.add('hidden');
        document.getElementById('hud').classList.remove('hidden');
        document.getElementById('touchControls').classList.remove('hidden');
        showBanner('МАТЧ НАЧАЛСЯ!', '#4ade80', 1400);
      });

      socket.on('state', (snap) => {
        if (gameModeType !== 'online') return;
        localBalls = snap.balls || [];
        timerSec = Math.max(0, Math.ceil(snap.timeLeft || 0));
        for (const [id, st] of Object.entries(snap.players || {})) {
          if (!localPlayers[id]) localPlayers[id] = { id, name: 'Игрок', color: '#38bdf8', team: 'blue', number: 1 };
          Object.assign(localPlayers[id], st);
        }
        const me = localPlayers[socket.id];
        if (me) {
          document.getElementById('staminaFill').style.width = `${Math.round(me.stamina ?? 100)}%`;
          updateCooldownBadges(me);
        }
      });

      socket.on('goal', (g) => {
        score.red = g.red;
        score.blue = g.blue;
        document.getElementById('scoreRed').textContent = score.red;
        document.getElementById('scoreBlue').textContent = score.blue;
        if (g.netWave) netWave = g.netWave;
        shakePower = 14;
        spawnGoalParticles(g.team === 'red' ? 880 : -880, 0, g.team === 'red' ? '#ef4444' : '#3b82f6');
        showBanner(`ГОЛ! ${g.scorerName || ''}`, '#facc15', 2200);
      });

      socket.on('screenShake', ({ intensity }) => { shakePower = Math.max(shakePower, intensity || 8); });
      socket.on('emote', ({ id, em }) => {
        const p = localPlayers[id];
        if (p) emotesFloating.push({ x: p.x, y: p.y - 45, em, ttl: 2.0 });
      });

      socket.on('matchEnd', (res) => {
        const myReward = res.rewardsBySocket?.[socket.id];
        if (myReward && myReward.account) {
          account = myReward.account;
          syncAccountUI();
        }
        const msg = res.winner === 'draw' ? 'НИЧЬЯ!' : `ПОБЕДА ${res.winner.toUpperCase()} (${res.red}:${res.blue})`;
        showBanner(msg, '#38bdf8', 3200);
        if (myReward && myReward.earned) {
          showToast(`Награда: +${myReward.earned} 🪙 (${myReward.breakdown.join(', ')})`);
        }
        setTimeout(() => {
          document.getElementById('hud').classList.add('hidden');
          document.getElementById('touchControls').classList.add('hidden');
          document.getElementById('lobbyOverlay').classList.remove('hidden');
        }, 2800);
      });

      setInterval(() => {
        if (socket && socket.connected) {
          const t0 = performance.now();
          socket.emit('pingCheck', t0, () => {
            pingMs = Math.round(performance.now() - t0);
            document.getElementById('hudNetInfo').textContent = `PING: ${pingMs} ms | ELO: ${account?.elo || 1000}`;
          });
        }
      }, 2500);
    }

    function getPlayerPayload() {
      const nick = document.getElementById('inpNick').value.trim() || 'Игрок';
      localStorage.setItem('bb_nick', nick);
      return {
        accountId: account?.id || savedAccId,
        sessionToken,
        name: nick,
        color: document.getElementById('inpColor').value,
        number: parseInt(document.getElementById('inpNum').value, 10) || 10,
        skin: document.getElementById('selPlayerSkin').value || 'plain',
        ballSkin: document.getElementById('selBallSkin').value || 'classic',
        formation: document.getElementById('selFormation').value || '4-3-3',
        tactic: document.getElementById('selTactic').value || 'balanced',
        ability: document.getElementById('selAbility').value || 'turbo_surge',
        region: document.getElementById('selRegion').value || 'auto',
        teamSize: parseInt(document.getElementById('selTeamSize').value, 10) || 2,
        isLandscape: window.innerWidth >= window.innerHeight
      };
    }

    function startOnlineMatchmaking() {
      if (!socket || !socket.connected) return showToast('Нет соединения с сервером');
      socket.emit('findMatch', getPlayerPayload(), (res) => {
        if (!res || !res.ok) showToast(res?.error || 'Ошибка поиска матча');
      });
    }

    function createPrivateRoomUI() {
      if (!socket || !socket.connected) return showToast('Нет соединения с сервером');
      const payload = getPlayerPayload();
      payload.customRules = {
        arena: document.getElementById('selArena').value,
        allowOvertime: document.getElementById('chkOvertime').checked,
        goldenGoal: document.getElementById('chkGoldenGoal').checked,
        autoBalance: document.getElementById('chkAutoBalance').checked
      };
      socket.emit('createPrivateRoom', payload, (res) => {
        if (!res || !res.ok) return showToast(res?.error || 'Ошибка создания комнаты');
        showToast(`Комната создана! Код: ${res.inviteCode}`);
      });
    }

    function joinPrivateRoomUI() {
      if (!socket || !socket.connected) return showToast('Нет соединения с сервером');
      const code = document.getElementById('inpPrivCode').value.trim().toUpperCase();
      if (!code) return showToast('Введите код комнаты');
      const payload = getPlayerPayload();
      payload.codeOrRoomId = code;
      socket.emit('joinPrivateRoom', payload, (res) => {
        if (!res || !res.ok) showToast(res?.error || 'Не удалось войти в комнату');
      });
    }

    function leaveLobby() {
      if (socket) socket.disconnect();
      document.getElementById('lobbyOverlay').classList.add('hidden');
      document.getElementById('menuOverlay').classList.remove('hidden');
      initSocket();
    }

    function leaveMatchToMenu() {
      gameModeType = 'none';
      if (lanPc) { try { lanPc.close(); } catch (e) {} lanPc = null; }
      document.getElementById('hud').classList.add('hidden');
      document.getElementById('touchControls').classList.add('hidden');
      document.getElementById('lobbyOverlay').classList.add('hidden');
      document.getElementById('menuOverlay').classList.remove('hidden');
      if (socket) { socket.disconnect(); initSocket(); }
    }

    function savePrefsUI() {
      const prefs = {
        formation: document.getElementById('selFormation').value,
        tactic: document.getElementById('selTactic').value,
        ability: document.getElementById('selAbility').value,
        region: document.getElementById('selRegion').value
      };
      if (socket && socket.connected) {
        socket.emit('savePlayerPrefs', { accountId: account?.id, sessionToken, prefs }, (res) => {
          if (res?.ok) showToast('Тактика и способности сохранены!');
        });
      }
    }

    function buySkinUI(category, skinId) {
      if (!socket || !socket.connected) return;
      socket.emit('buySkin', { accountId: account?.id, sessionToken, category, skinId }, (res) => {
        if (!res || !res.ok) return showToast(res?.error || 'Ошибка покупки');
        account = res.account;
        syncAccountUI();
        showToast('Скин успешно приобретён!');
      });
    }

    function claimQuestUI(key) {
      if (!socket || !socket.connected) return;
      socket.emit('claimSeasonReward', { accountId: account?.id, sessionToken, kind: 'quest', key }, (res) => {
        if (!res || !res.ok) return showToast(res?.error || 'Ошибка');
        account = res.account;
        syncAccountUI();
        showToast(`Награда получена: +${res.rewardCoins} 🪙!`);
      });
    }

    function redeemPromoUI() {
      const code = document.getElementById('inpPromo').value.trim();
      if (!code || !socket) return;
      socket.emit('redeemPromo', { accountId: account?.id, sessionToken, code }, (res) => {
        if (!res || !res.ok) return showToast(res?.error || 'Неверный промокод');
        account = res.account;
        syncAccountUI();
        if (res.isAdmin) {
          document.getElementById('tabAdminBtn').classList.remove('hidden');
          switchTab('admin');
        }
        showToast(res.rewardText || res.message || 'Промокод активирован!');
      });
    }

    function loadAdminDashboard() {
      if (!socket) return;
      socket.emit('adminGetDashboard', {}, (res) => {
        if (!res || !res.ok) return;
        document.getElementById('adminContent').innerHTML = `
          <div><b>Всего аккаунтов:</b> ${res.players.length} | <b>Промокодов:</b> ${Object.keys(res.promos).length}</div>
          <div style="margin-top:8px;"><b>Последние логи:</b></div>
          ${res.logs.slice(0, 10).map(l => `<div class="list-item"><span>${l.ts} • ${l.action}</span><span>${JSON.stringify(l.details)}</span></div>`).join('')}
        `;
      });
    }

    function searchPlayersUI() {
      const query = document.getElementById('inpFriendSearch').value.trim();
      if (!socket) return;
      socket.emit('searchPlayers', { accountId: account?.id, sessionToken, query }, (res) => {
        if (!res || !res.ok) return;
        document.getElementById('friendSearchResults').innerHTML = res.results.map(u => `
          <div class="list-item">
            <span>${u.nick} [ELO ${u.elo}]</span>
            ${u.isFriend ? '<span class="badge green">Друг</span>' : `<button class="btn primary sm" onclick="sendFriendReqUI('${u.id}')">+ В друзья</button>`}
          </div>
        `).join('');
      });
    }

    function sendFriendReqUI(targetId) {
      socket.emit('sendFriendRequest', { accountId: account?.id, sessionToken, targetId }, (res) => {
        if (res?.ok) { showToast('Заявка отправлена'); if (res.friendsData) renderFriendsUI(res.friendsData); }
        else showToast(res?.error || 'Ошибка');
      });
    }

    function renderFriendsUI(data) {
      document.getElementById('friendRequestsBox').innerHTML = (data.incoming || []).map(req => `
        <div class="list-item">
          <span>Заявка от <b>${req.nick}</b></span>
          <div class="row">
            <button class="btn success sm" onclick="respFriendReq('${req.id}',true)">Принять</button>
            <button class="btn danger sm" onclick="respFriendReq('${req.id}',false)">Отклонить</button>
          </div>
        </div>
      `).join('');
      document.getElementById('friendsListBox').innerHTML = (data.friends || []).map(f => `
        <div class="list-item">
          <span><b>${f.nick}</b> (${f.status})</span>
          <button class="btn primary sm" onclick="inviteFriendUI('${f.id}')">Пригласить</button>
        </div>
      `).join('') || '<div style="font-size:12px;color:var(--muted);">Список друзей пуст</div>';
    }

    function respFriendReq(fromId, accept) {
      socket.emit('respondFriendRequest', { accountId: account?.id, sessionToken, fromId, accept }, (res) => {
        if (res?.friendsData) renderFriendsUI(res.friendsData);
      });
    }

    function inviteFriendUI(friendId) {
      const payload = getPlayerPayload();
      payload.friendId = friendId;
      socket.emit('inviteFriendToMatch', payload, (res) => {
        if (res?.ok) showToast(`Приглашение отправлено! Код: ${res.inviteCode}`);
        else showToast(res?.error || 'Не удалось пригласить');
      });
    }

    // ==== OFFLINE BOT MODE & LAN P2P MODE ====
    let localSimInterval = null;
    let lanPc = null, lanDc = null;

    function startOfflineBotMatch() {
      gameModeType = 'offline';
      matchSettings = { arena: document.getElementById('selArena').value || 'classic', mode: 'time', ballSkin: document.getElementById('selBallSkin').value || 'classic' };
      score = { red: 0, blue: 0 };
      timerSec = 120;
      const p = getPlayerPayload();
      localPlayers = {
        me: { id: 'me', name: p.name, color: p.color, number: p.number, team: 'red', x: -350, y: 0, vx: 0, vy: 0, facing: 0, stamina: 100, dashCd: 0, tackleCd: 0, abilityCd: 0, ability: p.ability, tactic: p.tactic },
        bot1: { id: 'bot1', name: 'Бот Защитник', color: '#3b82f6', number: 4, team: 'blue', x: 350, y: -90, vx: 0, vy: 0, facing: Math.PI, stamina: 100, dashCd: 0, tackleCd: 0, abilityCd: 0 },
        bot2: { id: 'bot2', name: 'Бот Форвард', color: '#2563eb', number: 9, team: 'blue', x: 260, y: 90, vx: 0, vy: 0, facing: Math.PI, stamina: 100, dashCd: 0, tackleCd: 0, abilityCd: 0 }
      };
      localBalls = [{ x: 0, y: 0, prevX: 0, prevY: 0, vx: 0, vy: 0, z: 0, vz: 0, curve: 0, powerGlow: 0, ownerId: null }];
      document.getElementById('menuOverlay').classList.add('hidden');
      document.getElementById('hud').classList.remove('hidden');
      document.getElementById('touchControls').classList.remove('hidden');
      document.getElementById('scoreRed').textContent = '0';
      document.getElementById('scoreBlue').textContent = '0';
      showBanner('ТРЕНИРОВКА С БОТАМИ!', '#4ade80', 1400);
      runLocalPhysicsLoop(false);
    }

    // LAN WebRTC Host / Client
    async function lanCreateHost() {
      lanPc = new RTCPeerConnection({ iceServers: [] });
      lanDc = lanPc.createDataChannel('ballbrawl');
      setupLanChannel(lanDc, true);
      const offer = await lanPc.createOffer();
      await lanPc.setLocalDescription(offer);
      await new Promise(r => {
        if (lanPc.iceGatheringState === 'complete') return r();
        lanPc.onicegatheringstatechange = () => { if (lanPc.iceGatheringState === 'complete') r(); };
        setTimeout(r, 1200);
      });
      document.getElementById('lanHostPanel').classList.remove('hidden');
      document.getElementById('lanOfferOut').value = btoa(unescape(encodeURIComponent(JSON.stringify(lanPc.localDescription))));
    }

    async function lanHostAcceptAnswer() {
      try {
        const raw = document.getElementById('lanAnswerIn').value.trim();
        const desc = JSON.parse(decodeURIComponent(escape(atob(raw))));
        await lanPc.setRemoteDescription(desc);
        showToast('Ожидание открытия LAN-канала...');
      } catch (e) { showToast('Некорректный код ответа'); }
    }

    async function lanJoinCreateAnswer() {
      try {
        const raw = document.getElementById('lanOfferIn').value.trim();
        const offerDesc = JSON.parse(decodeURIComponent(escape(atob(raw))));
        lanPc = new RTCPeerConnection({ iceServers: [] });
        lanPc.ondatachannel = (ev) => { lanDc = ev.channel; setupLanChannel(lanDc, false); };
        await lanPc.setRemoteDescription(offerDesc);
        const answer = await lanPc.createAnswer();
        await lanPc.setLocalDescription(answer);
        await new Promise(r => {
          if (lanPc.iceGatheringState === 'complete') return r();
          lanPc.onicegatheringstatechange = () => { if (lanPc.iceGatheringState === 'complete') r(); };
          setTimeout(r, 1200);
        });
        document.getElementById('lanClientPanel').classList.remove('hidden');
        document.getElementById('lanAnswerOut').value = btoa(unescape(encodeURIComponent(JSON.stringify(lanPc.localDescription))));
      } catch (e) { showToast('Некорректный код приглашения'); }
    }

    let remoteLanInput = { x: 0, y: 0 };
    function setupLanChannel(dc, isHost) {
      dc.onopen = () => {
        showToast('LAN-соединение установлено!');
        const p = getPlayerPayload();
        if (isHost) {
          gameModeType = 'lan_host';
          matchSettings = { arena: document.getElementById('selArena').value || 'classic', mode: 'time', ballSkin: p.ballSkin };
          score = { red: 0, blue: 0 }; timerSec = 180;
          localPlayers = {
            me: { id: 'me', name: p.name, color: p.color, number: p.number, team: 'red', x: -350, y: 0, vx: 0, vy: 0, facing: 0, stamina: 100 },
            peer: { id: 'peer', name: 'LAN Игрок', color: '#3b82f6', number: 7, team: 'blue', x: 350, y: 0, vx: 0, vy: 0, facing: Math.PI, stamina: 100 }
          };
          localBalls = [{ x: 0, y: 0, prevX: 0, prevY: 0, vx: 0, vy: 0, z: 0, vz: 0, curve: 0, powerGlow: 0, ownerId: null }];
          document.getElementById('menuOverlay').classList.add('hidden');
          document.getElementById('hud').classList.remove('hidden');
          document.getElementById('touchControls').classList.remove('hidden');
          runLocalPhysicsLoop(true);
        } else {
          gameModeType = 'lan_client';
          document.getElementById('menuOverlay').classList.add('hidden');
          document.getElementById('hud').classList.remove('hidden');
          document.getElementById('touchControls').classList.remove('hidden');
          dc.send(JSON.stringify({ t: 'hello', name: p.name, color: p.color, number: p.number }));
        }
      };
      dc.onmessage = (ev) => {
        const msg = JSON.parse(ev.data);
        if (isHost) {
          if (msg.t === 'hello' && localPlayers.peer) {
            localPlayers.peer.name = msg.name; localPlayers.peer.color = msg.color; localPlayers.peer.number = msg.number;
          } else if (msg.t === 'inp') {
            remoteLanInput = { x: msg.x, y: msg.y };
          } else if (msg.t === 'act' && localPlayers.peer) {
            executeLocalAction(localPlayers.peer, msg.type, msg.dirX, msg.dirY, msg.power, msg.curveSign);
          }
        } else {
          if (msg.t === 'state') {
            localPlayers = msg.players; localBalls = msg.balls; score = msg.score; timerSec = msg.timerSec;
            matchSettings = msg.settings || matchSettings;
            document.getElementById('scoreRed').textContent = score.red;
            document.getElementById('scoreBlue').textContent = score.blue;
          }
        }
      };
    }

    function executeLocalAction(p, type, dirX, dirY, power = 1, curveSign = 0) {
      const b = localBalls[0];
      if (!b) return;
      if (type === 'dash' && (p.dashCd || 0) <= 0) {
        p.dashCd = 1.7;
        p.vx = Math.cos(p.facing || 0) * 650;
        p.vy = Math.sin(p.facing || 0) * 650;
      } else if (type === 'tackle' && (p.tackleCd || 0) <= 0) {
        p.tackleCd = 1.8;
        if (Math.hypot(b.x - p.x, b.y - p.y) < 105) { b.ownerId = p.id; }
      } else if (['kick', 'pass', 'lob', 'finesse'].includes(type)) {
        if (b.ownerId === p.id || Math.hypot(b.x - p.x, b.y - p.y) < 115) {
          b.ownerId = null;
          const imp = (type === 'kick' ? 920 : (type === 'finesse' ? 840 : (type === 'lob' ? 780 : 640))) * power;
          const nx = Math.cos(p.facing || 0), ny = Math.sin(p.facing || 0);
          b.vx = nx * imp; b.vy = ny * imp;
          b.vz = type === 'lob' ? 240 : 0;
          b.curve = type === 'finesse' ? (curveSign || 1) * 310 : (curveSign || 0) * 200;
          b.powerGlow = power;
        }
      }
    }

    function runLocalPhysicsLoop(isLanHost) {
      if (localSimInterval) clearInterval(localSimInterval);
      let last = performance.now();
      localSimInterval = setInterval(() => {
        if (gameModeType !== 'offline' && gameModeType !== 'lan_host') {
          clearInterval(localSimInterval); return;
        }
        const now = performance.now();
        const dt = Math.min(0.05, (now - last) / 1000);
        last = now;
        const theme = ARENA_THEMES[matchSettings.arena] || ARENA_THEMES.classic;
        const minX = -theme.w / 2, maxX = theme.w / 2, minY = -theme.h / 2, maxY = theme.h / 2;
        const goalHalfH = (theme.h * 0.3) / 2;

        timerSec = Math.max(0, timerSec - dt);
        const inp = getCombinedInput();
        const me = localPlayers.me;
        if (me) {
          if (Math.hypot(inp.x, inp.y) > 0.05) {
            me.facing = Math.atan2(inp.y, inp.x);
            me.vx = inp.x * 380; me.vy = inp.y * 380;
          } else { me.vx *= 0.88; me.vy *= 0.88; }
          me.x = Math.max(minX + 30, Math.min(maxX - 30, me.x + me.vx * dt));
          me.y = Math.max(minY + 30, Math.min(maxY - 30, me.y + me.vy * dt));
          if (me.dashCd > 0) me.dashCd -= dt;
          if (me.tackleCd > 0) me.tackleCd -= dt;
        }

        const b = localBalls[0];
        if (isLanHost && localPlayers.peer) {
          const peer = localPlayers.peer;
          if (Math.hypot(remoteLanInput.x, remoteLanInput.y) > 0.05) {
            peer.facing = Math.atan2(remoteLanInput.y, remoteLanInput.x);
            peer.vx = remoteLanInput.x * 380; peer.vy = remoteLanInput.y * 380;
          } else { peer.vx *= 0.88; peer.vy *= 0.88; }
          peer.x = Math.max(minX + 30, Math.min(maxX - 30, peer.x + peer.vx * dt));
          peer.y = Math.max(minY + 30, Math.min(maxY - 30, peer.y + peer.vy * dt));
        } else {
          // Smart AI Bots
          for (const bid of ['bot1', 'bot2']) {
            const bot = localPlayers[bid];
            if (!bot || !b) continue;
            const tx = bid === 'bot1' ? Math.max(80, b.x + 120) : b.x;
            const ty = bid === 'bot1' ? b.y * 0.65 : b.y;
            const dx = tx - bot.x, dy = ty - bot.y, d = Math.hypot(dx, dy) || 1;
            bot.facing = Math.atan2(dy, dx);
            bot.x += (dx / d) * 285 * dt;
            bot.y += (dy / d) * 285 * dt;
            if (b.ownerId === bot.id) {
              const gx = minX - bot.x, gy = -bot.y, gl = Math.hypot(gx, gy) || 1;
              bot.facing = Math.atan2(gy, gx);
              if (Math.abs(bot.x - minX) < 520) executeLocalAction(bot, 'kick', gx / gl, gy / gl, 0.85, 0);
            }
          }
        }

        if (b) {
          b.prevX = b.x; b.prevY = b.y;
          if (b.ownerId && localPlayers[b.ownerId]) {
            const o = localPlayers[b.ownerId];
            b.x = o.x + Math.cos(o.facing || 0) * 52;
            b.y = o.y + Math.sin(o.facing || 0) * 52;
            b.vx = o.vx; b.vy = o.vy;
          } else {
            if (b.curve) {
              const px = -b.vy, py = b.vx, pl = Math.hypot(px, py) || 1;
              b.vx += (px / pl) * b.curve * dt * 1.4;
              b.vy += (py / pl) * b.curve * dt * 1.4;
              b.curve *= 0.94;
            }
            b.x += b.vx * dt; b.y += b.vy * dt;
            b.vx *= 0.975; b.vy *= 0.975;
            if (b.z > 0 || b.vz !== 0) {
              b.vz -= 640 * dt;
              b.z = Math.max(0, b.z + b.vz * dt);
              if (b.z === 0) b.vz = 0;
            }
            for (const p of Object.values(localPlayers)) {
              if (Math.hypot(b.x - p.x, b.y - p.y) < 52 && (b.z || 0) < 22) {
                b.ownerId = p.id; break;
              }
            }
          }
          if (b.y < minY + 20) { b.y = minY + 20; b.vy = Math.abs(b.vy) * 0.8; }
          if (b.y > maxY - 20) { b.y = maxY - 20; b.vy = -Math.abs(b.vy) * 0.8; }

          // Goal check BEFORE wall bounce
          if (b.x <= minX && Math.abs(b.y) <= goalHalfH) {
            score.blue++; document.getElementById('scoreBlue').textContent = score.blue;
            netWave.left = 15; showBanner('ГОЛ СИНИХ!', '#3b82f6', 1600);
            b.x = 0; b.y = 0; b.vx = 0; b.vy = 0; b.ownerId = null;
          } else if (b.x >= maxX && Math.abs(b.y) <= goalHalfH) {
            score.red++; document.getElementById('scoreRed').textContent = score.red;
            netWave.right = 15; showBanner('ГОЛ КРАСНЫХ!', '#ef4444', 1600);
            b.x = 0; b.y = 0; b.vx = 0; b.vy = 0; b.ownerId = null;
          } else {
            if (b.x < minX + 20) { b.x = minX + 20; b.vx = Math.abs(b.vx) * 0.8; }
            if (b.x > maxX - 20) { b.x = maxX - 20; b.vx = -Math.abs(b.vx) * 0.8; }
          }
        }

        if (isLanHost && lanDc && lanDc.readyState === 'open') {
          lanDc.send(JSON.stringify({ t: 'state', players: localPlayers, balls: localBalls, score, timerSec, settings: matchSettings }));
        }
      }, 1000 / 60);
    }

    // ==== INPUTS & CUSTOMIZABLE CONTROLS ====
    function getCombinedInput() {
      let x = joyVec.x, y = joyVec.y;
      if (keys['KeyW'] || keys['ArrowUp']) y -= 1;
      if (keys['KeyS'] || keys['ArrowDown']) y += 1;
      if (keys['KeyA'] || keys['ArrowLeft']) x -= 1;
      if (keys['KeyD'] || keys['ArrowRight']) x += 1;
      const l = Math.hypot(x, y);
      if (l > 1) { x /= l; y /= l; }
      return { x, y };
    }

    window.addEventListener('keydown', (e) => {
      keys[e.code] = true;
      if (e.code === 'Space') triggerAction('kick', 0.9);
      if (e.code === 'KeyE') triggerAction('pass', 0.85);
      if (e.code === 'KeyQ') triggerAction('lob', 0.85);
      if (e.code === 'KeyC') triggerAction('finesse', 0.9);
      if (e.code === 'ShiftLeft') triggerAction('dash', 1);
      if (e.code === 'KeyF') triggerAction('tackle', 1);
      if (e.code === 'KeyR') triggerAction('ability', 1);
    });
    window.addEventListener('keyup', (e) => { keys[e.code] = false; });

    function triggerAction(type, power = 1) {
      const inp = getCombinedInput();
      const me = localPlayers[socket?.id] || localPlayers.me;
      const dirX = Math.hypot(inp.x, inp.y) > 0.05 ? inp.x : Math.cos(me?.facing || 0);
      const dirY = Math.hypot(inp.x, inp.y) > 0.05 ? inp.y : Math.sin(me?.facing || 0);
      const curveSign = inp.y < -0.2 ? -1 : (inp.y > 0.2 ? 1 : 0);

      if (gameModeType === 'online' && socket && socket.connected) {
        socket.emit('action', { type, dirX, dirY, power, curveSign });
      } else if (gameModeType === 'offline' || gameModeType === 'lan_host') {
        if (localPlayers.me) executeLocalAction(localPlayers.me, type, dirX, dirY, power, curveSign);
      } else if (gameModeType === 'lan_client' && lanDc && lanDc.readyState === 'open') {
        lanDc.send(JSON.stringify({ t: 'act', type, dirX, dirY, power, curveSign }));
      }
    }

    function sendEmote(em) {
      if (socket && socket.connected) socket.emit('emote', em);
    }

    setInterval(() => {
      const inp = getCombinedInput();
      if (gameModeType === 'online' && socket && socket.connected) {
        socket.emit('input', { x: inp.x, y: inp.y, seq: ++inputSeq });
      } else if (gameModeType === 'lan_client' && lanDc && lanDc.readyState === 'open') {
        lanDc.send(JSON.stringify({ t: 'inp', x: inp.x, y: inp.y }));
      }
    }, 1000 / 30);

    // Joystick & Action Buttons
    (function initTouch() {
      const zone = document.getElementById('joyZone');
      const knob = document.getElementById('joyKnob');
      let joyTouchId = null;

      zone.addEventListener('touchstart', (e) => {
        if (editingControls) return;
        e.preventDefault();
        const t = e.changedTouches[0];
        joyTouchId = t.identifier;
        updateJoy(t);
      }, { passive: false });

      zone.addEventListener('touchmove', (e) => {
        if (editingControls) return;
        e.preventDefault();
        for (const t of e.changedTouches) {
          if (t.identifier === joyTouchId) updateJoy(t);
        }
      }, { passive: false });

      const endJoy = (e) => {
        for (const t of e.changedTouches) {
          if (t.identifier === joyTouchId) {
            joyTouchId = null; joyVec.x = 0; joyVec.y = 0;
            knob.style.transform = 'translate(0px, 0px)';
          }
        }
      };
      zone.addEventListener('touchend', endJoy);
      zone.addEventListener('touchcancel', endJoy);

      function updateJoy(t) {
        const rect = zone.getBoundingClientRect();
        const cx = rect.left + rect.width / 2, cy = rect.top + rect.height / 2;
        const maxR = rect.width * 0.38;
        let dx = t.clientX - cx, dy = t.clientY - cy;
        const d = Math.hypot(dx, dy);
        if (d > maxR) { dx = (dx / d) * maxR; dy = (dy / d) * maxR; }
        knob.style.transform = `translate(${dx}px, ${dy}px)`;
        joyVec.x = dx / maxR; joyVec.y = dy / maxR;
      }

      const btnMap = [
        ['btnKick', 'kick', true],
        ['btnPass', 'pass', false],
        ['btnLob', 'lob', true],
        ['btnFinesse', 'finesse', true],
        ['btnDash', 'dash', false],
        ['btnTackle', 'tackle', false],
        ['btnAbility', 'ability', false]
      ];
      btnMap.forEach(([id, type, chargeable]) => {
        const el = document.getElementById(id);
        el.addEventListener('pointerdown', (e) => {
          if (editingControls) return;
          e.preventDefault();
          if (chargeable) {
            chargeState = { active: true, type, startTs: performance.now() };
            el.classList.add('charging');
          } else {
            triggerAction(type, 1);
          }
        });
        const release = (e) => {
          if (editingControls) return;
          if (chargeState.active && chargeState.type === type) {
            const heldMs = performance.now() - chargeState.startTs;
            const pwr = Math.max(0.35, Math.min(1, 0.35 + heldMs / 750));
            chargeState.active = false;
            el.classList.remove('charging');
            triggerAction(type, pwr);
          }
        };
        el.addEventListener('pointerup', release);
        el.addEventListener('pointercancel', release);
      });
    })();

    // Control Editor
    function openControlEditor() {
      editingControls = true;
      document.getElementById('touchControls').classList.remove('hidden');
      document.getElementById('controlEditorOverlay').classList.remove('hidden');
      const ids = ['joyZone', 'btnKick', 'btnPass', 'btnLob', 'btnFinesse', 'btnDash', 'btnTackle', 'btnAbility'];
      ids.forEach(id => {
        const el = document.getElementById(id);
        el.onpointerdown = (ev) => {
          if (!editingControls) return;
          ev.preventDefault();
          const rect = el.getBoundingClientRect();
          const offX = ev.clientX - rect.left, offY = ev.clientY - rect.top;
          const onMove = (mv) => {
            el.style.left = (mv.clientX - offX) + 'px';
            el.style.top = (mv.clientY - offY) + 'px';
            el.style.right = 'auto';
            el.style.bottom = 'auto';
          };
          const onUp = () => {
            window.removeEventListener('pointermove', onMove);
            window.removeEventListener('pointerup', onUp);
          };
          window.addEventListener('pointermove', onMove);
          window.addEventListener('pointerup', onUp);
        };
      });
    }

    function previewControlScale(val) {
      document.getElementById('ctrlScaleVal').textContent = val + '%';
      const s = Number(val) / 100;
      document.querySelectorAll('.act-btn').forEach(b => { b.style.transform = `scale(${s})`; });
    }

    function saveCustomControlsUI() {
      const ids = ['joyZone', 'btnKick', 'btnPass', 'btnLob', 'btnFinesse', 'btnDash', 'btnTackle', 'btnAbility'];
      const layout = { scale: Number(document.getElementById('ctrlScaleRange').value) / 100, items: {} };
      ids.forEach(id => {
        const el = document.getElementById(id);
        layout.items[id] = { left: el.style.left, top: el.style.top, right: el.style.right, bottom: el.style.bottom };
      });
      customControls = layout;
      localStorage.setItem('bb_controls', JSON.stringify(layout));
      if (socket && socket.connected) {
        socket.emit('saveCustomControls', { accountId: account?.id, sessionToken, controls: layout });
      }
      showToast('Расположение кнопок сохранено!');
      closeControlEditor();
    }

    function resetCustomControlsUI() {
      localStorage.removeItem('bb_controls');
      customControls = null;
      location.reload();
    }

    function applyCustomControlsLayout() {
      const saved = customControls || JSON.parse(localStorage.getItem('bb_controls') || 'null');
      if (!saved || !saved.items) return;
      for (const [id, pos] of Object.entries(saved.items)) {
        const el = document.getElementById(id);
        if (!el) continue;
        if (pos.left) el.style.left = pos.left;
        if (pos.top) el.style.top = pos.top;
        if (pos.right) el.style.right = pos.right;
        if (pos.bottom) el.style.bottom = pos.bottom;
      }
      if (saved.scale) previewControlScale(Math.round(saved.scale * 100));
    }

    function closeControlEditor() {
      editingControls = false;
      document.getElementById('controlEditorOverlay').classList.add('hidden');
      if (gameModeType === 'none') document.getElementById('touchControls').classList.add('hidden');
    }

    function updateCooldownBadges(me) {
      document.getElementById('btnDash').classList.toggle('cd', (me.dashCd || 0) > 0);
      document.getElementById('btnTackle').classList.toggle('cd', (me.tackleCd || 0) > 0);
      document.getElementById('btnAbility').classList.toggle('cd', (me.abilityCd || 0) > 0);
    }

    // ==== CANVAS RENDERER (SMOOTH CAMERA, NET WAVE, PARTICLES, NO LEG RUN ANIM) ====
    const canvas = document.getElementById('gameCanvas');
    const ctx = canvas.getContext('2d');
    const cam = { x: 0, y: 0, zoom: 0.72 };

    function resizeCanvas() {
      canvas.width = window.innerWidth * devicePixelRatio;
      canvas.height = window.innerHeight * devicePixelRatio;
    }
    window.addEventListener('resize', resizeCanvas);
    resizeCanvas();

    function spawnGoalParticles(x, y, color) {
      for (let i = 0; i < 45; i++) {
        const a = Math.random() * Math.PI * 2;
        const sp = 90 + Math.random() * 340;
        particles.push({ x, y, vx: Math.cos(a) * sp, vy: Math.sin(a) * sp, color, ttl: 0.9 + Math.random() * 0.6 });
      }
    }

    function renderLoop() {
      requestAnimationFrame(renderLoop);
      const mm = String(Math.floor(timerSec / 60)).padStart(2, '0');
      const ss = String(timerSec % 60).padStart(2, '0');
      document.getElementById('hudTimer').textContent = `${mm}:${ss}`;

      const theme = ARENA_THEMES[matchSettings.arena] || ARENA_THEMES.classic;
      const me = localPlayers[socket?.id] || localPlayers.me || Object.values(localPlayers)[0];
      const b0 = localBalls[0];
      const targetX = me ? (me.x * 0.65 + (b0 ? b0.x * 0.35 : 0)) : 0;
      const targetY = me ? (me.y * 0.65 + (b0 ? b0.y * 0.35 : 0)) : 0;
      cam.x += (targetX - cam.x) * 0.12;
      cam.y += (targetY - cam.y) * 0.12;

      const baseZoom = Math.min(canvas.width / (theme.w * 0.72), canvas.height / (theme.h * 0.78));
      cam.zoom += (Math.max(0.45, Math.min(1.15, baseZoom)) - cam.zoom) * 0.08;

      ctx.save();
      ctx.fillStyle = '#09111e';
      ctx.fillRect(0, 0, canvas.width, canvas.height);

      let sx = 0, sy = 0;
      if (shakePower > 0.2) {
        sx = (Math.random() - 0.5) * shakePower * 2;
        sy = (Math.random() - 0.5) * shakePower * 2;
        shakePower *= 0.88;
      }

      ctx.translate(canvas.width / 2 + sx, canvas.height / 2 + sy);
      ctx.scale(cam.zoom, cam.zoom);
      ctx.translate(-cam.x, -cam.y);

      // Pitch stripes
      const minX = -theme.w / 2, minY = -theme.h / 2;
      const stripeW = theme.w / 12;
      for (let i = 0; i < 12; i++) {
        ctx.fillStyle = i % 2 === 0 ? theme.grass1 : theme.grass2;
        ctx.fillRect(minX + i * stripeW, minY, stripeW + 1, theme.h);
      }

      // Field markings
      ctx.strokeStyle = theme.line;
      ctx.lineWidth = 4;
      ctx.strokeRect(minX, minY, theme.w, theme.h);
      ctx.beginPath();
      ctx.moveTo(0, minY); ctx.lineTo(0, minY + theme.h);
      ctx.stroke();
      ctx.beginPath();
      ctx.arc(0, 0, 140, 0, Math.PI * 2);
      ctx.stroke();

      // Goals & dynamic net wave
      const goalH = theme.h * 0.3;
      const goalDepth = 78;
      netWave.left *= 0.92;
      netWave.right *= 0.92;

      drawGoalNet(minX - goalDepth - netWave.left, -goalH / 2, goalDepth + netWave.left, goalH, '#ef4444');
      drawGoalNet(minX + theme.w, -goalH / 2, goalDepth + netWave.right, goalH, '#3b82f6');

      // Obstacles
      for (const [ox, oy, ow, oh] of (theme.obstacles || [])) {
        ctx.fillStyle = 'rgba(15,23,42,0.85)';
        ctx.strokeStyle = '#38bdf8';
        ctx.lineWidth = 3;
        ctx.fillRect(ox - ow / 2, oy - oh / 2, ow, oh);
        ctx.strokeRect(ox - ow / 2, oy - oh / 2, ow, oh);
      }

      // Players (clean top-down disc + jersey number + indicator, without leg animation)
      for (const p of Object.values(localPlayers)) {
        if (p.team === 'spec') continue;
        ctx.save();
        ctx.translate(p.x, p.y);
        // Shadow
        ctx.fillStyle = 'rgba(0,0,0,0.32)';
        ctx.beginPath(); ctx.ellipse(4, 8, 30, 26, 0, 0, Math.PI * 2); ctx.fill();

        // Team ring
        ctx.strokeStyle = p.team === 'red' ? '#ef4444' : '#3b82f6';
        ctx.lineWidth = 5;
        ctx.beginPath(); ctx.arc(0, 0, 32, 0, Math.PI * 2); ctx.stroke();

        // Body
        ctx.fillStyle = p.color || '#ff3366';
        ctx.beginPath(); ctx.arc(0, 0, 28, 0, Math.PI * 2); ctx.fill();

        // Facing pointer
        ctx.rotate(p.facing || 0);
        ctx.fillStyle = '#fff';
        ctx.beginPath(); ctx.moveTo(34, 0); ctx.lineTo(24, -7); ctx.lineTo(24, 7); ctx.closePath(); ctx.fill();
        ctx.rotate(-(p.facing || 0));

        // Number & Nick
        ctx.fillStyle = '#fff';
        ctx.font = '800 16px sans-serif';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText(String(p.number ?? ''), 0, 1);

        ctx.font = '700 13px sans-serif';
        ctx.fillStyle = '#f8fafc';
        ctx.fillText(p.name || '', 0, -44);
        ctx.restore();
      }

      // Balls (with altitude z shadow + power glow)
      for (const b of localBalls) {
        const z = b.z || 0;
        const scale = 1 + z / 220;
        ctx.save();
        // Ground shadow
        ctx.fillStyle = 'rgba(0,0,0,0.35)';
        ctx.beginPath();
        ctx.ellipse(b.x + z * 0.25, b.y + 8 + z * 0.25, 20, 16, 0, 0, Math.PI * 2);
        ctx.fill();

        ctx.translate(b.x, b.y - z * 0.55);
        ctx.scale(scale, scale);

        if ((b.powerGlow || 0) > 0.1) {
          ctx.shadowColor = '#facc15';
          ctx.shadowBlur = 22 * b.powerGlow;
        }
        ctx.fillStyle = matchSettings.ballSkin === 'fire' ? '#f97316'
          : (matchSettings.ballSkin === 'ice' ? '#38bdf8'
          : (matchSettings.ballSkin === 'neon' ? '#a855f7'
          : (matchSettings.ballSkin === 'star' ? '#facc15' : '#ffffff')));
        ctx.beginPath(); ctx.arc(0, 0, 20, 0, Math.PI * 2); ctx.fill();
        ctx.strokeStyle = '#0f172a'; ctx.lineWidth = 3; ctx.stroke();
        ctx.restore();
      }

      // Particles & Emotes
      for (let i = particles.length - 1; i >= 0; i--) {
        const pt = particles[i];
        pt.x += pt.vx * 0.016; pt.y += pt.vy * 0.016; pt.ttl -= 0.016;
        if (pt.ttl <= 0) { particles.splice(i, 1); continue; }
        ctx.fillStyle = pt.color;
        ctx.globalAlpha = Math.max(0, pt.ttl);
        ctx.fillRect(pt.x - 4, pt.y - 4, 8, 8);
        ctx.globalAlpha = 1;
      }

      for (let i = emotesFloating.length - 1; i >= 0; i--) {
        const em = emotesFloating[i];
        em.y -= 0.7; em.ttl -= 0.016;
        if (em.ttl <= 0) { emotesFloating.splice(i, 1); continue; }
        ctx.font = '28px sans-serif';
        ctx.textAlign = 'center';
        ctx.fillText(em.em, em.x, em.y);
      }

      ctx.restore();
    }

    function drawGoalNet(x, y, w, h, color) {
      ctx.save();
      ctx.fillStyle = 'rgba(255,255,255,0.12)';
      ctx.strokeStyle = color;
      ctx.lineWidth = 4;
      ctx.fillRect(x, y, w, h);
      ctx.strokeRect(x, y, w, h);
      ctx.strokeStyle = 'rgba(255,255,255,0.22)';
      ctx.lineWidth = 1.5;
      for (let gx = x + 16; gx < x + w; gx += 16) {
        ctx.beginPath(); ctx.moveTo(gx, y); ctx.lineTo(gx, y + h); ctx.stroke();
      }
      for (let gy = y + 16; gy < y + h; gy += 16) {
        ctx.beginPath(); ctx.moveTo(x, gy); ctx.lineTo(x + w, gy); ctx.stroke();
      }
      ctx.restore();
    }

    applyCustomControlsLayout();
    initSocket();
    renderLoop();
  </script>
</body>
</html>
