(() => {

  const socket = io({

    autoConnect: true,

    auth: {

      token: localStorage.getItem('poker-token') || '',

    },

  });

  const state = {

    token: localStorage.getItem('poker-token') || '',

    roomCode: localStorage.getItem('poker-room') || '',

    room: null,

    rooms: [],

    self: null,

    peekCards: false,

    lastHandResults: null,

    modalOpen: false,

    hideShowOffer: null,

    turnDeadlineAt: null,

    actionTimeoutMs: 30000,

    myTurnActive: false,

    raiseAmount: null,

    raiseKey: null,

    viewerCardsKey: '',

    prevHandId: null,

    prevContrib: {},

    prevPot: 0,

    prevHandStatus: null,

    actionSoundKey: '',

    turnRemainMs: null,

    turnRemainAt: 0,

    clockSynced: false,

  };

  const BOT_LEVEL_LABELS = {

    beginner: '初级',

    intermediate: '中级',

    advanced: '高级',

  };

  function botLevelClass(level) {

    if (level === 'advanced') return 'advanced';

    if (level === 'intermediate') return 'intermediate';

    return 'beginner';

  }

  // ===== 音效引擎（Web Audio 合成，无音频文件） =====
  const soundState = {

    enabled: localStorage.getItem('poker-sound') !== 'off',

    ctx: null,

    master: null,

  };

  function ensureAudioContext() {

    if (!soundState.enabled) return null;

    if (!soundState.ctx) {

      const Ctx = window.AudioContext || window.webkitAudioContext;

      if (!Ctx) return null;

      const ctx = new Ctx();

      // 主链：所有音效经主增益 + 压缩器再输出，多音叠加不再削波失真
      const master = ctx.createGain();

      master.gain.value = 0.5;

      const compressor = ctx.createDynamicsCompressor();

      compressor.threshold.value = -20;

      compressor.knee.value = 20;

      compressor.ratio.value = 5;

      compressor.attack.value = 0.004;

      compressor.release.value = 0.16;

      master.connect(compressor).connect(ctx.destination);

      soundState.ctx = ctx;

      soundState.master = master;

    }

    if (soundState.ctx.state === 'suspended') {

      soundState.ctx.resume().catch(() => {});

    }

    return soundState.ctx;

  }

  // 浏览器自动播放策略：首次用户交互时解锁 AudioContext
  const unlockAudio = () => ensureAudioContext();

  document.addEventListener('pointerdown', unlockAudio, { once: true, capture: true });

  document.addEventListener('keydown', unlockAudio, { once: true, capture: true });

  function playTone({ freq = 880, duration = 0.12, type = 'sine', gain = 0.08, delay = 0, slideTo = null }) {

    const ctx = ensureAudioContext();

    if (!ctx || !soundState.master) return;

    const start = ctx.currentTime + delay + 0.001;

    const osc = ctx.createOscillator();

    const amp = ctx.createGain();

    osc.type = type;

    osc.frequency.setValueAtTime(Math.max(30, freq), start);

    if (slideTo) osc.frequency.exponentialRampToValueAtTime(Math.max(30, slideTo), start + duration);

    // 柔和包络：20ms 起音 + 释放尾，消除咔哒声
    const attack = Math.min(0.02, duration * 0.4);

    const release = 0.05;

    const holdEnd = start + Math.max(attack, duration - 0.01);

    amp.gain.setValueAtTime(0.0001, start);

    amp.gain.exponentialRampToValueAtTime(gain, start + attack);

    amp.gain.setValueAtTime(gain, holdEnd);

    amp.gain.exponentialRampToValueAtTime(0.0001, holdEnd + release);

    osc.connect(amp).connect(soundState.master);

    osc.start(start);

    osc.stop(holdEnd + release + 0.03);

  }

  const SFX = {

    turn() {

      playTone({ freq: 660, duration: 0.1, type: 'sine', gain: 0.09 });

      playTone({ freq: 990, duration: 0.16, type: 'sine', gain: 0.08, delay: 0.11 });

    },

    check() {

      playTone({ freq: 190, duration: 0.05, type: 'triangle', gain: 0.1 });

      playTone({ freq: 150, duration: 0.07, type: 'triangle', gain: 0.08, delay: 0.06 });

    },

    call() {

      playTone({ freq: 520, duration: 0.05, type: 'triangle', gain: 0.08 });

      playTone({ freq: 660, duration: 0.06, type: 'triangle', gain: 0.07, delay: 0.05 });

    },

    raise() {

      playTone({ freq: 520, duration: 0.05, type: 'triangle', gain: 0.08 });

      playTone({ freq: 700, duration: 0.05, type: 'triangle', gain: 0.07, delay: 0.05 });

      playTone({ freq: 880, duration: 0.07, type: 'triangle', gain: 0.06, delay: 0.1 });

    },

    allin() {

      [440, 554, 659, 880].forEach((f, i) => playTone({ freq: f, duration: 0.09, type: 'triangle', gain: 0.06, delay: i * 0.07 }));

    },

    fold() {

      playTone({ freq: 320, slideTo: 170, duration: 0.12, type: 'sine', gain: 0.05 });

    },

    // delay：与发牌动画错开（翻牌三张依次响，避免同帧叠加）
    deal(audioDelay = 0) {

      playTone({ freq: 980, slideTo: 700, duration: 0.05, type: 'sine', gain: 0.045, delay: audioDelay });

    },

    win() {

      [523, 659, 784, 1046].forEach((f, i) => playTone({ freq: f, duration: 0.16, type: 'sine', gain: 0.08, delay: i * 0.11 }));

    },

  };

  // ===== 轮到你行动提醒：声音 + 标题闪烁 + 震动 =====
  const originalTitle = document.title;

  let titleFlashTimer = null;

  function startTurnAlert() {

    SFX.turn();

    if (navigator.vibrate) {

      try { navigator.vibrate([200, 100, 200]); } catch { /* 部分浏览器不支持 */ }

    }

    if (titleFlashTimer) return;

    let on = false;

    titleFlashTimer = setInterval(() => {

      document.title = on ? originalTitle : '⚠️ 轮到你行动！';

      on = !on;

    }, 900);

  }

  function stopTurnAlert() {

    if (titleFlashTimer) {

      clearInterval(titleFlashTimer);

      titleFlashTimer = null;

      document.title = originalTitle;

    }

  }

  const $ = (id) => document.getElementById(id);

  const elements = {

    connectionStatus: $('connectionStatus'),

    leaveTableBtn: $('leaveTableBtn'),

    lobbyView: $('lobbyView'),

    tableView: $('tableView'),

    playerName: $('playerName'),

    roomCode: $('roomCode'),

    smallBlind: $('smallBlind'),

    bigBlind: $('bigBlind'),

    startingStack: $('startingStack'),

    maxSeats: $('maxSeats'),

    actionTimeout: $('actionTimeout'),

    createRoomBtn: $('createRoomBtn'),

    joinRoomBtn: $('joinRoomBtn'),

    lobbyError: $('lobbyError'),

    refreshRoomsBtn: $('refreshRoomsBtn'),

    roomList: $('roomList'),

    roomCodeBadge: $('roomCodeBadge'),

    roomName: $('roomName'),

    standBtn: $('standBtn'),

    resumeBtn: $('resumeBtn'),

    rebuyBtn: $('rebuyBtn'),

    startHandBtn: $('startHandBtn'),

    addBotBtn: $('addBotBtn'),

    botLevelSelect: $('botLevelSelect'),

    memberList: $('memberList'),

    seatGrid: $('seatGrid'),

    board: $('board'),

    pot: $('pot'),

    dealerMessage: $('dealerMessage'),

    viewerCards: $('viewerCards'),

    peekCardsBtn: $('peekCardsBtn'),

    actionPanel: $('actionPanel'),

    actionLog: $('actionLog'),
    logToggleBtn: $('logToggleBtn'),
    actionLogWrap: $('actionLogWrap'),
    roomListEmpty: $('roomListEmpty'),
    settleBtn: $('settleBtn'),
    toast: $('toast'),
    historyBtn: $('historyBtn'),
    historyModal: $('historyModal'),
    historyContent: $('historyContent'),
    moreBtn: $('moreBtn'),
    headerSecondary: $('headerSecondary'),
    copyReportBtn: $('copyReportBtn'),
    soundToggleBtn: $('soundToggleBtn'),

  };

  let lastSettlement = null;

  function buildReportText() {
    if (!lastSettlement) return '';
    const { settlements, roomName, roomCode, settledAt } = lastSettlement;
    const time = new Date(settledAt ?? Date.now());
    const pad = (n) => String(n).padStart(2, '0');
    const timeText = `${time.getFullYear()}-${pad(time.getMonth() + 1)}-${pad(time.getDate())} ${pad(time.getHours())}:${pad(time.getMinutes())}`;
    const lines = [
      '【德州扑克战报】',
      `房间：${roomName || '-'}${roomCode ? `（${roomCode}）` : ''}`,
      `时间：${timeText}`,
      '----------------',
    ];
    settlements.forEach((entry, index) => {
      const ratio = entry.totalBuyIn > 0 ? ((entry.profitLoss / entry.totalBuyIn) * 100).toFixed(1) : '0.0';
      const sign = entry.profitLoss >= 0 ? '+' : '';
      const tag = entry.isBot ? '[AI] ' : '';
      lines.push(`${index + 1}. ${tag}${entry.name}  买入${entry.totalBuyIn} 剩余${entry.currentStack}  ${sign}${entry.profitLoss} (${sign}${ratio}%)`);
    });
    return lines.join('\n');
  }

  async function copyReportToClipboard() {
    const text = buildReportText();
    if (!text) {
      showToast('暂无战报可复制', true);
      return;
    }
    // 非安全上下文（http://局域网IP）没有 navigator.clipboard，回退 execCommand
    try {
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(text);
        showToast('战报已复制到剪贴板');
        return;
      }
    } catch {
      // 继续走降级
    }
    try {
      const textarea = document.createElement('textarea');
      textarea.value = text;
      textarea.style.position = 'fixed';
      textarea.style.opacity = '0';
      document.body.appendChild(textarea);
      textarea.select();
      const ok = document.execCommand('copy');
      textarea.remove();
      showToast(ok ? '战报已复制到剪贴板' : '复制失败，请手动截图保存', !ok);
    } catch {
      showToast('复制失败，请手动截图保存', true);
    }
  }

  let toastTimer = null;

  function showToast(text, error = false) {
    if (!elements.toast) return;
    elements.toast.textContent = text;
    elements.toast.className = error ? 'toast error' : 'toast';
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => {
      elements.toast.classList.add('hidden');
    }, 2400);
  }

  function exitToLocalLobby() {
    state.room = null;
    state.roomCode = '';
    state.turnDeadlineAt = null;
    state.turnRemainMs = null;
    state.myTurnActive = false;
    stopTurnAlert();
    setHandEndFab(false);
    localStorage.removeItem('poker-room');
    if (elements.headerSecondary) {
      elements.headerSecondary.classList.remove('open');
    }
    renderLobby();
  }

  function updateSoundToggleBtn() {
    if (!elements.soundToggleBtn) return;
    elements.soundToggleBtn.textContent = soundState.enabled ? '🔊' : '🔇';
    elements.soundToggleBtn.classList.toggle('muted', !soundState.enabled);
  }

  function setTableMode(enabled) {

    document.body.classList.toggle('is-table-view', enabled);

  }

  const suitClass = (card) => (/♥|♦/.test(card) ? 'red' : '');

  function setStatus(text, error = false) {
    elements.connectionStatus.textContent = text;
    elements.connectionStatus.className = error ? 'conn-badge disconnected' : 'conn-badge connected';
  }

  function storeSession(token, roomCode) {

    state.token = token;

    state.roomCode = roomCode;

    localStorage.setItem('poker-token', token);

    if (roomCode) {

      localStorage.setItem('poker-room', roomCode);

    }

    socket.auth = { token };

  }

  function fmtTime(ts) {

    if (!ts) return '';

    return new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

  }

  const SUIT_SYMBOL_MAP = { S: '\u2660', H: '\u2665', D: '\u2666', C: '\u2663' };
  const RANK_DISPLAY = { T: '10' };

  function renderCard(card, back) {

    const div = document.createElement('div');

    if (back) {

      div.className = 'card back';

      return div;

    }

    const rank = card[0];

    const suit = card[1];

    const symbol = SUIT_SYMBOL_MAP[suit] || suit;

    const colorClass = (suit === 'H' || suit === 'D') ? 'red' : 'black';

    div.className = 'card ' + colorClass;
    var cornerTL = document.createElement('div');

    cornerTL.className = 'corner top-left';

    var rankTL = document.createElement('span');

    rankTL.className = 'rank';

    rankTL.textContent = RANK_DISPLAY[rank] || rank;

    var suitTL = document.createElement('span');

    suitTL.className = 'suit-symbol';
    suitTL.textContent = symbol;

    cornerTL.append(rankTL, suitTL);

    var cornerBR = document.createElement('div');

    cornerBR.className = 'corner bottom-right';

    var rankBR = document.createElement('span');

    rankBR.className = 'rank';

    rankBR.textContent = RANK_DISPLAY[rank] || rank;

    var suitBR = document.createElement('span');

    suitBR.className = 'suit-symbol';

    suitBR.textContent = symbol;

    cornerBR.append(rankBR, suitBR);

    var centerSuit = document.createElement('div');

    centerSuit.className = 'center-suit';

    centerSuit.textContent = symbol;

    div.append(cornerTL, centerSuit, cornerBR);

    return div;

  }

  function layoutSeats(count) {

    // These are seat centers rather than top-left offsets. Keeping the
    // centers away from the edges leaves room for the card itself.
    const tunedNine = [

      [50, 79],

      [25, 69],

      [13, 50],

      [18, 31],

      [37, 21],

      [63, 21],

      [82, 31],

      [87, 50],

      [75, 69],

    ];

    if (count === 9) {
      return Array.from({ length: count }, (_, index) => tunedNine[index]);
    }

    // 其他人数按椭圆均匀分布，从底部中央开始顺时针排布，保证任意座位数都对称。
    const positions = [];
    for (let index = 0; index < count; index += 1) {
      const angleDeg = -90 - index * (360 / count);
      const angle = (angleDeg * Math.PI) / 180;
      const x = Math.round((50 + 40 * Math.cos(angle)) * 10) / 10;
      const y = Math.round((50 - 40 * Math.sin(angle)) * 10) / 10;
      positions.push([x, y]);
    }
    return positions;

  }

  function getHandStartState(room) {
    const participants = room.players.filter((player) => player.seatIndex !== null && player.stack > 0 && !player.sitOut);
    const readyHumans = participants.filter((player) => !player.isBot);
    const readyCount = readyHumans.filter((player) => player.ready).length;
    return {
      participants,
      readyHumans,
      readyCount,
      readyTotal: readyHumans.length,
      needsReady: readyHumans.length > 1,
      canStartDirectly: participants.length >= 2,
      allReady: readyHumans.length > 0 && readyCount === readyHumans.length,
    };
  }

  function updateStartControlButton(button, room) {
    if (!button || !room) return;
    const me = room.players.find((player) => player.isViewer);
    const startState = getHandStartState(room);
    if (room.hand?.status === 'running') {
      button.textContent = '对局进行中';
      button.title = '';
      button.classList.remove('ready-state');
      button.disabled = true;
      return;
    }
    if (!me || me.seatIndex === null) {
      button.textContent = '请先坐下';
      button.title = '';
      button.classList.remove('ready-state');
      button.disabled = true;
      return;
    }
    if (startState.needsReady) {
      button.textContent = me.ready ? '✓ 已准备' : '准备';
      button.title = me.ready ? '点击可取消准备' : '';
      button.disabled = false;
      button.classList.toggle('ready-state', Boolean(me.ready));
      return;
    }
    button.title = '';
    button.classList.remove('ready-state');
    button.textContent = startState.canStartDirectly ? '开始下一局' : '等待更多玩家';
    button.disabled = !startState.canStartDirectly;
  }

  function seatText(room, seat) {
    if (!seat.player) return '空位';
    const tags = [];
    if (seat.player.isHost) tags.push('房主');
    if (seat.player.isBot) tags.push('🤖 ' + (BOT_LEVEL_LABELS[seat.player.botLevel] || '机器人'));
    if (seat.player.sitOut) tags.push('暂离');
    if (seat.player.allIn) tags.push('全下');
    if (seat.player.folded) tags.push('弃牌');
    if (!seat.player.connected && !seat.player.isBot) tags.push('离线');
    if (room.hand?.status !== 'running' && !seat.player.isBot && seat.player.stack > 0 && !seat.player.sitOut) {
      tags.push(seat.player.ready ? '已准备' : '未准备');
    }
    return tags.join(' · ');
  }

  function renderLobby() {

    setTableMode(false);

    elements.lobbyView.classList.remove('hidden');

    elements.tableView.classList.add('hidden');

    elements.leaveTableBtn.classList.add('hidden');

    elements.roomList.innerHTML = '';

    if (elements.roomListEmpty) {

      elements.roomListEmpty.classList.toggle('hidden', state.rooms.length > 0);

    }

    for (const room of state.rooms) {

      const item = document.createElement('div');

      item.className = 'room-item';

      const info = document.createElement('div');

      const name = document.createElement('strong');

      name.textContent = room.name;

      const meta = document.createElement('div');

      meta.className = 'room-meta';

      meta.textContent = `${room.code} · ${room.seatsTaken}/${room.seatsTotal} · ${room.handStatus === 'running' ? '进行中' : '等待中'}`;

      info.append(name, meta);

      const button = document.createElement('button');

      button.textContent = '加入';

      button.className = 'ghost';

      button.addEventListener('click', () => joinRoom(room.code));

      item.append(info, button);

      elements.roomList.append(item);

    }

  }

  function renderBoard(room) {

    const cards = room.hand?.board || [];

    if (!cards.length) {

      elements.board.innerHTML = '';

      const empty = document.createElement('div');

      empty.className = 'dealer-message';

      empty.textContent = '等待发牌';

      elements.board.append(empty);

      return;

    }

    const placeholder = elements.board.querySelector('.dealer-message');

    if (placeholder) placeholder.remove();

    // diff 渲染：保留已发出的牌，只给新牌加发牌动画
    while (elements.board.children.length > cards.length) {

      elements.board.lastChild.remove();

    }

    const batchStart = elements.board.children.length;

    for (let i = elements.board.children.length; i < cards.length; i += 1) {

      const cardEl = renderCard(cards[i]);

      cardEl.classList.add('dealt');

      cardEl.style.animationDelay = `${(i - batchStart) * 0.12}s`;

      elements.board.append(cardEl);

      // 音效与发牌动画同步错开，避免三张同帧叠加
      SFX.deal((i - batchStart) * 0.08);

    }

  }

  function renderViewerCards(room) {

    const me = room.players.find((player) => player.isViewer);

    const cards = me?.holeCards || [];

    const realCards = cards.filter((card) => card && card !== '??');

    if (!cards.length) {

      elements.viewerCards.innerHTML = '';

      const seated = me && me.seatIndex !== null;

      elements.viewerCards.textContent = seated ? '等待发牌' : '未坐下';

      elements.peekCardsBtn.classList.add('hidden');

      state.viewerCardsKey = '';

      return;

    }

    elements.peekCardsBtn.classList.remove('hidden');

    const key = `${realCards.join(',')}|${state.peekCards ? 'F' : 'B'}`;

    if (key === state.viewerCardsKey) return;

    const prevCount = state.viewerCardsKey ? state.viewerCardsKey.split('|')[0].split(',').filter(Boolean).length : 0;

    const isNewDeal = realCards.length > prevCount;

    state.viewerCardsKey = key;

    elements.viewerCards.innerHTML = '';

    realCards.forEach((card, index) => {

      const cardEl = renderCard(card, !state.peekCards);

      // 手牌用纯淡入（不改变布局尺寸，避免干扰测量与点击）
      cardEl.classList.add('dealt-fade');

      cardEl.style.animationDelay = `${index * 0.08}s`;

      elements.viewerCards.append(cardEl);

    });

    if (isNewDeal) SFX.deal();

  }

  function renderLogs(room) {

    elements.actionLog.innerHTML = '';

    const items = [...room.log].slice(-18).reverse();

    for (const entry of items) {

      const row = document.createElement('div');

      row.className = 'log-entry';

      row.textContent = `${fmtTime(entry.at)} ${entry.text}`;

      elements.actionLog.append(row);

    }

  }

  function seatPosition(index, total) {

    const positions = layoutSeats(total);

    return positions[index] || [50, 50];

  }

  // ===== 筹码飞行动效：下注时从座位飞向底池 =====
  function flyChipFromSeat(surface, seatIndex, maxSeats) {

    const [x, y] = seatPosition(seatIndex, maxSeats);

    const chip = document.createElement('div');

    chip.className = 'chip-fly';

    chip.style.left = `${x}%`;

    chip.style.top = `${y}%`;

    surface.appendChild(chip);

    requestAnimationFrame(() => {

      requestAnimationFrame(() => chip.classList.add('to-pot'));

    });

    setTimeout(() => chip.remove(), 700);

  }

  function maybeAnimateChips(room) {

    const hand = room.hand;

    if (!hand) return;

    if (state.prevHandId !== hand.id) {

      state.prevHandId = hand.id ?? null;

      state.prevContrib = {};

      state.prevPot = 0;

    }

    if (hand.status !== 'running') return;

    const surface = document.querySelector('.table-surface');

    if (!surface) return;

    for (const player of room.players) {

      if (player.seatIndex == null) continue;

      const prev = state.prevContrib[player.seatIndex] ?? 0;

      const cur = player.streetContribution ?? 0;

      if (cur > prev && !player.folded) {

        flyChipFromSeat(surface, player.seatIndex, room.config.maxSeats);

      }

      state.prevContrib[player.seatIndex] = cur;

    }

    if ((hand.pot ?? 0) > state.prevPot) {

      elements.pot.classList.remove('pulse');

      void elements.pot.offsetWidth;

      elements.pot.classList.add('pulse');

    }

    state.prevPot = hand.pot ?? 0;

  }

  // ===== 动作音效：根据本街最新动作播放 =====
  function maybePlayActionSound(room) {

    const hand = room.hand;

    if (!hand || hand.status !== 'running') {

      state.actionSoundKey = '';

      return;

    }

    const entries = Object.entries(hand.playerStreetActions ?? {});

    const key = `${hand.id}|${hand.street}|${entries.length}`;

    if (key === state.actionSoundKey) return;

    const isSameStreet = state.actionSoundKey.startsWith(`${hand.id}|${hand.street}|`);

    state.actionSoundKey = key;

    if (!isSameStreet || !entries.length) return;

    // 按时间戳取最新动作（对象键为座位号，遍历顺序并非插入顺序）
    const latest = entries.reduce((a, b) => (b[1].timestamp > a[1].timestamp ? b : a));

    const type = latest[1]?.type;

    if (type === 'raise') SFX.raise();

    else if (type === 'call') SFX.call();

    else if (type === 'check') SFX.check();

    else if (type === 'fold') SFX.fold();

    else if (type === 'allin') SFX.allin();

  }

  // ===== 回合提醒：仅当"轮到我"状态发生变化时触发 =====
  function updateTurnAlert(room) {

    const isMyTurn = Boolean(room.hand?.availableActions);

    if (isMyTurn && !state.myTurnActive) {

      state.myTurnActive = true;

      startTurnAlert();

    } else if (!isMyTurn && state.myTurnActive) {

      state.myTurnActive = false;

      stopTurnAlert();

    }

  }

  // ===== 胜利音效：状态从 running → finished 瞬间播放 =====
  function maybePlayWinSound(room) {

    const status = room.hand?.status ?? null;

    if (status === 'finished' && state.prevHandStatus === 'running') {

      SFX.win();

    }

    state.prevHandStatus = status;

  }

  function buildTurnCountdown() {
    const wrap = document.createElement('div');
    wrap.className = 'turn-countdown';
    wrap.id = 'turnCountdown';
    const bar = document.createElement('div');
    bar.className = 'turn-countdown-bar';
    const fill = document.createElement('div');
    fill.className = 'turn-countdown-fill';
    const text = document.createElement('span');
    text.className = 'turn-countdown-text';
    bar.append(fill);
    wrap.append(bar, text);
    return wrap;
  }

  // 剩余行动时间：优先用"服务端时钟差值 + 本地流逝时间"递减，
  // 免疫设备（尤其手机）与服务端的时钟偏移；旧服务端无 serverNow 时回退绝对时间差
  function getTurnRemainMs() {

    if (state.clockSynced) {

      if (state.turnRemainMs == null) return null;

      return state.turnRemainMs - (Date.now() - state.turnRemainAt);

    }

    if (!state.turnDeadlineAt) return null;

    return state.turnDeadlineAt - Date.now();

  }

  function updateTurnCountdown() {
    const wrap = document.getElementById('turnCountdown');
    if (!wrap) return;
    const remainMs = getTurnRemainMs();
    if (remainMs == null) {
      wrap.classList.add('hidden');
      return;
    }
    wrap.classList.remove('hidden');
    const totalMs = Math.max(1, state.actionTimeoutMs);
    const fill = wrap.querySelector('.turn-countdown-fill');
    const text = wrap.querySelector('.turn-countdown-text');
    if (remainMs <= 0) {
      if (fill) fill.style.width = '0%';
      if (text) text.textContent = '⏱ 0s';
      wrap.classList.add('warn');
      return;
    }
    const pct = Math.max(0, Math.min(100, (remainMs / totalMs) * 100));
    if (fill) fill.style.width = `${pct}%`;
    if (text) text.textContent = `⏱ ${Math.ceil(remainMs / 1000)}s`;
    wrap.classList.toggle('warn', remainMs < 6000);
  }

  setInterval(() => {
    updateTurnCountdown();
  }, 500);

  function renderActions(room) {

    elements.actionPanel.innerHTML = '';

    state.turnDeadlineAt = room.hand?.status === 'running' ? (room.hand.turnDeadlineAt ?? null) : null;

    const actions = room.hand?.availableActions;

    if (!actions) {

      state.raiseAmount = null;

      state.raiseKey = null;

      const hint = document.createElement('div');

      hint.className = 'room-meta';

      hint.textContent = room.hand ? '等待下一轮行动' : '先加入或创建房间';

      elements.actionPanel.append(hint);

      updateTurnCountdown();

      return;

    }

    // 输入状态保护：同一轮行动内保留加注金额，切换街道/行动者时重置
    const turnKey = `${room.hand.id}|${room.hand.street}|${room.hand.actionSeat}`;

    if (state.raiseKey !== turnKey) {

      state.raiseKey = turnKey;

      state.raiseAmount = null;

    }

    const clampRaiseAmount = (value) => {

      const num = Math.round(Number(value));

      if (!Number.isFinite(num)) return actions.minRaiseTo;

      return Math.max(actions.minRaiseTo, Math.min(num, actions.maxRaiseTo));

    };

    const currentAmount = () => clampRaiseAmount(state.raiseAmount ?? actions.minRaiseTo);

    const grid = document.createElement('div');

    grid.className = 'action-grid';

    const makeButton = (label, action, disabled = false, cssClass = '') => {

      const button = document.createElement('button');

      button.textContent = label;

      button.disabled = disabled;

      if (cssClass) button.className = cssClass;

      button.addEventListener('click', () => sendAction(action));

      return button;

    };

    grid.append(

      makeButton('弃牌', { type: 'fold' }, false, 'btn-fold'),

      makeButton(actions.canCheck ? '过牌' : `跟注 ${actions.toCall}`, actions.canCheck ? { type: 'check' } : { type: 'call' }, !actions.canCheck && !actions.canCall, actions.canCheck ? 'btn-check' : 'btn-call'),

    );

    const bb = room.config?.bigBlind || 20;

    const raiseRow = document.createElement('div');

    raiseRow.className = 'raise-row';

    const stepDownBtn = document.createElement('button');

    stepDownBtn.type = 'button';

    stepDownBtn.className = 'raise-step';

    stepDownBtn.textContent = '−';

    stepDownBtn.disabled = !actions.canRaise;

    stepDownBtn.addEventListener('click', () => setAmount(currentAmount() - bb));

    const input = document.createElement('input');

    input.type = 'number';

    input.min = actions.minRaiseTo;

    input.max = actions.maxRaiseTo;

    input.step = 1;

    input.value = currentAmount();

    input.id = 'raiseAmountInput';

    const stepUpBtn = document.createElement('button');

    stepUpBtn.type = 'button';

    stepUpBtn.className = 'raise-step';

    stepUpBtn.textContent = '+';

    stepUpBtn.disabled = !actions.canRaise;

    stepUpBtn.addEventListener('click', () => setAmount(currentAmount() + bb));

    const slider = document.createElement('input');

    slider.type = 'range';

    slider.className = 'raise-slider';

    slider.min = actions.minRaiseTo;

    slider.max = actions.maxRaiseTo;

    // 自由步进：保证滑块与输入框/实际下注金额精确同步（吸附刻度在 input 事件里处理）
    slider.step = 1;

    slider.value = currentAmount();

    slider.disabled = !actions.canRaise || actions.minRaiseTo === actions.maxRaiseTo;

    // 滑块拖动按小盲刻度吸附（默认整 10）；step 保持 1，避免浏览器对程序化赋值静默回弹导致的不同步
    const snapGrid = Math.max(1, room.config?.smallBlind || 10);

    const snapToGrid = (value) => {

      const num = Number(value);

      if (!Number.isFinite(num)) return value;

      return Number(slider.min) + Math.round((num - Number(slider.min)) / snapGrid) * snapGrid;

    };

    const setAmount = (value) => {

      const val = clampRaiseAmount(value);

      state.raiseAmount = val;

      input.value = val;

      slider.value = val;

    };

    input.addEventListener('input', () => {

      const num = Number(input.value);

      if (input.value !== '' && Number.isFinite(num)) state.raiseAmount = num;

      const clamped = clampRaiseAmount(num);

      if (clamped >= Number(slider.min) && clamped <= Number(slider.max)) slider.value = clamped;

    });

    input.addEventListener('blur', () => setAmount(input.value));

    // 拖动中只更新金额显示，不回写 slider.value——
    // 拖动中改写拇指位置会与手指的原生拖动打架，造成移动端卡顿
    slider.addEventListener('input', () => {

      const val = clampRaiseAmount(snapToGrid(slider.value));

      state.raiseAmount = val;

      input.value = val;

    });

    // 松手后再把拇指精确吸附到刻度
    slider.addEventListener('change', () => setAmount(snapToGrid(slider.value)));

    const raiseBtn = document.createElement('button');

    raiseBtn.textContent = '加注';

    raiseBtn.disabled = !actions.canRaise;

    raiseBtn.className = 'btn-raise';

    raiseBtn.addEventListener('click', () => {

      sendAction({ type: 'raise', amount: currentAmount() });

    });

    raiseRow.append(stepDownBtn, input, stepUpBtn, raiseBtn);

    const allInBtn = makeButton('全下', { type: 'allin' }, !actions.canRaise || room.players.find((player) => player.isViewer)?.stack <= 0, 'btn-allin');

    grid.append(raiseRow, allInBtn);

    // 快捷加注：加注到 = 当前下注 + 底池比例
    const potBase = (room.hand?.pot ?? 0) + actions.toCall;
    const currentBet = room.hand?.currentBet ?? 0;
    const quickRow = document.createElement('div');
    quickRow.className = 'quick-row';
    for (const [label, frac] of [['最小', 0], ['⅓池', 1 / 3], ['½池', 0.5], ['⅔池', 2 / 3], ['满池', 1]]) {
      const quickBtn = document.createElement('button');
      quickBtn.type = 'button';
      quickBtn.textContent = label;
      quickBtn.disabled = !actions.canRaise;
      quickBtn.addEventListener('click', () => {
        setAmount(Math.round(currentBet + potBase * frac));
      });
      quickRow.append(quickBtn);
    }

    elements.actionPanel.append(buildTurnCountdown(), grid, slider, quickRow);

    updateTurnCountdown();

  }

  function renderTable(room) {

    setTableMode(true);

    state.room = room;

    state.actionTimeoutMs = room.config?.actionTimeoutMs ?? 30000;

    // 记录"收到状态瞬间"的服务端剩余行动时间（纯服务端时钟差值），本地只递减流逝时间
    if (typeof room.serverNow === 'number') {

      state.clockSynced = true;

      state.turnRemainMs = room.hand?.status === 'running' && room.hand.turnDeadlineAt

        ? Math.max(0, room.hand.turnDeadlineAt - room.serverNow)

        : null;

      state.turnRemainAt = Date.now();

    } else {

      state.clockSynced = false;

    }

    elements.lobbyView.classList.add('hidden');

    elements.tableView.classList.remove('hidden');

    elements.leaveTableBtn.classList.remove('hidden');

    elements.roomCodeBadge.textContent = room.code;

    elements.roomName.textContent = room.name;

    const startState = getHandStartState(room);

    elements.dealerMessage.textContent = room.hand?.dealerMessage || (startState.needsReady
      ? `等待准备 ${startState.readyCount}/${startState.readyTotal}`
      : (startState.canStartDirectly ? '等待开始' : '等待更多玩家'));

    const displayPot = room.hand ? (room.hand.status === 'finished' ? (room.hand.finalPot ?? room.hand.pot ?? 0) : (room.hand.pot ?? 0)) : 0;

    elements.pot.textContent = `${displayPot} 筹码`;

    // 使用增强版的座位渲染（包含行动提示和操作信息）
    enhancedRenderSeatGrid(room);
    renderMembers(room);

    renderBoard(room);

    renderViewerCards(room);

    renderActions(room);

    renderLogs(room);

    updateTurnAlert(room);

    maybePlayActionSound(room);

    maybeAnimateChips(room);

    maybePlayWinSound(room);

    updateStartControlButton(elements.startHandBtn, room);

    // 更新补充筹码、离座、重新入局按钮状态
    const me = room.players.find((player) => player.isViewer);
    const canRebuy = me && !me.isBot && me.seatIndex !== null && room.hand?.status !== 'running';
    elements.rebuyBtn.disabled = !canRebuy;
    elements.rebuyBtn.style.display = (me && me.seatIndex !== null) ? '' : 'none';

    // 离座按钮：已坐下且不在观战状态时显示
    const canStand = me && me.seatIndex !== null && !me.sitOut && room.hand?.status !== 'running';
    elements.standBtn.disabled = !canStand;
    elements.standBtn.style.display = (me && me.seatIndex !== null && !me.sitOut) ? '' : 'none';

    // 重新入局按钮：已坐下且在观战状态时显示
    const canResume = me && me.seatIndex !== null && me.sitOut && me.stack > 0 && room.hand?.status !== 'running';
    elements.resumeBtn.disabled = !canResume;
    elements.resumeBtn.style.display = (me && me.seatIndex !== null && me.sitOut) ? '' : 'none';

    // Check for hand end and show results modal
    // 摊牌延迟弹窗，让玩家先看清桌面翻牌与赢家高亮；弃牌获胜轻延迟保持节奏
    if (room.hand?.status === 'finished' && !state.modalOpen && state.lastHandResults !== room.hand.id) {
      state.lastHandResults = room.hand.id;
      const handSnapshot = room.hand;
      const delayMs = handSnapshot.revealed ? 1400 : 350;
      setTimeout(() => {
        if (state.modalOpen || state.lastHandResults !== handSnapshot.id) return;
        if (state.room?.hand?.id !== handSnapshot.id || state.room?.hand?.status !== 'finished') return;
        showHandEndModal(state.room);
      }, delayMs);
    }

    // 弹窗打开期间收到新状态（如有人秀牌）时实时刷新内容与底部按钮
    if (state.modalOpen && room.hand?.status === 'finished' && room.hand.id === state.lastHandResults) {
      renderHandEndResults(room);
      updateNextHandButtons();
    }

    // 弹窗收起但本局结算仍在：顶部悬浮入口可随时切回弹窗（下一局开始后自动消失）
    setHandEndFab(room.hand?.status === 'finished'
      && room.hand.id === state.lastHandResults
      && !state.modalOpen);

    // Update next hand buttons when hand is idle
    if (room.hand?.status === 'idle' && !state.modalOpen) {
      updateNextHandButtons();
    }

  }

  function updateRoomsList(rooms) {

    state.rooms = rooms || [];

    if (elements.lobbyView.classList.contains('hidden')) return;

  

    renderLobby();

  }

  function joinRoom(roomCode) {

    const playerName = elements.playerName.value.trim() || '玩家';

    socket.emit('room:join', {

      roomCode,

      token: state.token || localStorage.getItem('poker-token') || '',

      playerName,

    }, (result) => {

      if (!result?.ok) {

        elements.lobbyError.textContent = result?.error || '加入失败';

        return;

      }

      storeSession(result.token, result.roomCode);

      renderTable(result.room);

    });

  }

  function createRoom() {

    const payload = {

      token: state.token || localStorage.getItem('poker-token') || '',

      playerName: elements.playerName.value.trim() || '玩家',

      roomName: `${elements.playerName.value.trim() || '私人'} 的牌桌`,

      config: {

        smallBlind: Number(elements.smallBlind.value || 10),

        bigBlind: Number(elements.bigBlind.value || 20),

        startingStack: Number(elements.startingStack.value || 2000),

        maxSeats: Number(elements.maxSeats.value || 9),

        // 秒 → 毫秒，与服务端钳制范围(5s~120s)对齐
        actionTimeoutMs: Math.min(120, Math.max(5, Math.round(Number(elements.actionTimeout.value) || 30))) * 1000,

      },

    };

    socket.emit('room:create', payload, (result) => {

      if (!result?.ok) {

        elements.lobbyError.textContent = result?.error || '创建失败';

        return;

      }

      storeSession(result.token, result.roomCode);

      renderTable(result.room);

    });

  }

  function sitAtSeat(seatIndex) {

    if (!state.room) return;

    socket.emit('room:sit', {

      roomCode: state.room.code,

      token: state.token,

      seatIndex,

    }, (result) => {

      if (!result?.ok) {

        showToast(result?.error || '坐下失败', true);

        return;

      }

      if (result.room) renderTable(result.room);

    });

  }

  function sendAction(action) {

    if (!state.room) return;

    socket.emit('room:action', {

      roomCode: state.room.code,

      token: state.token,

      action,

    }, (result) => {

      if (!result?.ok) {

        showToast(result?.error || '行动失败', true);

      }

    });

  }

  function addBot() {

    if (!state.room) return;

    const level = elements.botLevelSelect.value;

    socket.emit('room:bot:add', {

      roomCode: state.room.code,

      token: state.token,

      level,

    }, (result) => {

      if (!result?.ok) {

        showToast(result?.error || '添加机器人失败', true);

        return;

      }

      if (result.room) renderTable(result.room);

    });

  }

  function removeBot(botToken, botName = '这个机器人') {
    if (!state.room) return;
    if (!confirm(`确定要移除 ${botName} 吗？`)) return;

    socket.emit('room:bot:remove', {
      roomCode: state.room.code,
      token: state.token,
      botToken,
    }, (result) => {
      if (!result?.ok) {
        showToast(result?.error || '移除机器人失败', true);
        return;
      }
      if (result.room) renderTable(result.room);
    });
  }

  function kickPlayer(targetToken, playerName = '这位玩家') {
    if (!state.room) return;
    if (!confirm(`确定要踢出 ${playerName} 吗？`)) return;

    socket.emit('room:player:kick', {
      roomCode: state.room.code,
      token: state.token,
      targetToken,
    }, (result) => {
      if (!result?.ok) {
        showToast(result?.error || '踢人失败', true);
        return;
      }
      if (result.room) renderTable(result.room);
    });
  }

  function manageMember(player) {
    if (!player?.targetToken || !state.room?.self?.isHost || player.isHost || player.isViewer) return;
    if (state.room.summary?.handStatus === 'running') {
      showToast('对局进行中不能踢人', true);
      return;
    }
    if (player.isBot) {
      removeBot(player.targetToken, player.name);
    } else {
      kickPlayer(player.targetToken, player.name);
    }
  }

  function renderMembers(room) {
    if (!elements.memberList) return;
    elements.memberList.innerHTML = '';

    for (const player of room.players) {
      const item = document.createElement('div');
      item.className = 'member-item';

      const info = document.createElement('div');
      info.className = 'member-info';

      const name = document.createElement('strong');
      name.textContent = player.name;

      const tags = [];
      if (player.isHost) tags.push('房主');
      if (player.isBot) tags.push('AI');
      if (player.seatIndex === null) tags.push('观战');
      else tags.push(`${player.seatIndex + 1}号位`);
      if (player.sitOut && player.seatIndex !== null) tags.push('暂离');
      if (!player.connected && !player.isBot) tags.push('离线');
      if (room.hand?.status !== 'running' && player.seatIndex !== null && !player.isBot && player.stack > 0 && !player.sitOut) {
        tags.push(player.ready ? '已准备' : '未准备');
      }

      const meta = document.createElement('span');
      meta.className = 'member-meta';
      meta.textContent = tags.join(' · ');
      info.append(name, meta);

      item.append(info);
      if (room.self?.isHost && player.targetToken && !player.isHost && !player.isViewer) {
        const button = document.createElement('button');
        button.type = 'button';
        button.className = 'ghost member-kick-btn';
        button.textContent = player.isBot ? '移除' : '踢出';
        button.disabled = room.summary?.handStatus === 'running';
        button.addEventListener('click', () => manageMember(player));
        item.append(button);
      }
      elements.memberList.append(item);
    }
  }

  function resumeIfPossible() {

    if (!state.roomCode || !state.token) return;

    socket.emit('session:resume', {

      roomCode: state.roomCode,

      token: state.token,

    }, (result) => {

      if (result?.ok) {

        storeSession(result.token, result.roomCode);

    renderTable(result.room);

      }

    });

  }

  socket.on('connect', () => {

    setStatus('已连接');

    if (state.token) socket.auth = { token: state.token };

    socket.emit('rooms:list', {}, (result) => {

      if (result?.rooms) updateRoomsList(result.rooms);

    });

    resumeIfPossible();

  });

  socket.on('disconnect', () => {

    setStatus('连接已断开，正在等待重连', true);

  });

  socket.on('connect_error', () => {

    setStatus('连接失败', true);

  });

  socket.on('session:token', ({ token }) => {

    if (token) {

      storeSession(token, state.roomCode);

    }

  });

  socket.on('rooms:list', ({ rooms }) => updateRoomsList(rooms));

  socket.on('room:kicked', ({ reason } = {}) => {
    exitToLocalLobby();
    showToast(reason || '你已被房主移出房间', true);
  });

  socket.on('room:closed', ({ reason } = {}) => {
    if (elements.lobbyView.classList.contains('hidden')) {
      exitToLocalLobby();
      showToast(reason === 'settled' ? '房主已结算并解散房间' : '房间已关闭', true);
    }
  });

  // 恢复会话失败（房间已被清理或解散）：回到大厅，避免停留在冻结的牌桌
  socket.on('session:resume:miss', () => {
    if (state.roomCode && elements.lobbyView.classList.contains('hidden')) {
      exitToLocalLobby();
      showToast('房间已不存在或已解散', true);
    }
  });

  // 移动端切后台后返回前台 / 网络恢复时，主动重连并立即同步房间状态
  function recoverConnectionOnForeground() {
    if (socket.disconnected) {
      try {
        socket.connect();
      } catch {
        // socket.io 内部可能已在重连流程中，忽略
      }
    }
    resumeIfPossible();
  }

  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) {
      recoverConnectionOnForeground();
    }
  });

  window.addEventListener('online', recoverConnectionOnForeground);

  socket.on('room:state', (room) => {

    if (!room) return;

    if (room.viewerToken) {

      storeSession(room.viewerToken, room.code);

    }

    if (room.code) {

      state.roomCode = room.code;

      localStorage.setItem('poker-room', room.code);

    }

    if (room.summary?.handStatus === 'idle' && elements.lobbyView.classList.contains('hidden')) {

      renderTable(room);

      return;

    }

    if (elements.tableView.classList.contains('hidden')) {

      renderTable(room);

    } else if (state.room?.code === room.code) {

      renderTable(room);

    }

  });

  elements.createRoomBtn.addEventListener('click', createRoom);

  elements.joinRoomBtn.addEventListener('click', () => {

    const code = elements.roomCode.value.trim().toUpperCase();

    if (!code) {

      elements.lobbyError.textContent = '请输入房间码';

      return;

    }

    joinRoom(code);

  });

  elements.refreshRoomsBtn.addEventListener('click', () => {

    socket.emit('rooms:list', {}, (result) => {

      if (result?.rooms) updateRoomsList(result.rooms);

    });

  });

  elements.leaveTableBtn.addEventListener('click', () => {

    if (state.roomCode) {

      socket.emit('room:leave', { roomCode: state.roomCode, token: state.token });

    }

    exitToLocalLobby();

  });

  elements.standBtn.addEventListener('click', () => {

    if (!state.room) return;

    socket.emit('room:stand', { roomCode: state.room.code, token: state.token }, (result) => {

      if (!result?.ok) {

        showToast(result?.error || '离座失败', true);

      }

    });

  });

  elements.resumeBtn.addEventListener('click', () => {

    if (!state.room) return;

    socket.emit('room:resume', { roomCode: state.room.code, token: state.token }, (result) => {

      if (!result?.ok) {

        showToast(result?.error || '重新入局失败', true);

      } else {

        showToast('已重新加入游戏');

        if (result.room) renderTable(result.room);

      }

    });

  });

  elements.rebuyBtn.addEventListener('click', () => {

    if (!state.room) return;

    const me = state.room.players.find((player) => player.isViewer);
    if (!me) return;

    // 提示用户输入补充金额
    const amount = prompt(`请输入补充筹码数量（当前筹码：${me.stack}）`, '1000');
    if (!amount) return;

    const rebuyAmount = Number(amount);
    if (!Number.isFinite(rebuyAmount) || rebuyAmount <= 0) {
      showToast('请输入有效的正整数', true);
      return;
    }

    socket.emit('room:rebuy', { roomCode: state.room.code, token: state.token, amount: rebuyAmount }, (result) => {

      if (!result?.ok) {

        showToast(result?.error || '补充筹码失败', true);

      } else {

        showToast(`成功补充 ${rebuyAmount} 筹码`);

        if (result.room) renderTable(result.room);

      }

    });

  });

  elements.settleBtn.addEventListener('click', () => {
    if (!state.room) return;

    const me = state.room.players.find((player) => player.isViewer);
    if (!me || !me.isHost) {
      showToast('只有房主可以结算房间', true);
      return;
    }

    if (!confirm('确定要结算并解散房间吗？此操作不可撤销。')) {
      return;
    }

    socket.emit('room:settle', { roomCode: state.room.code, token: state.token }, (result) => {
      if (!result?.ok) {
        showToast(result?.error || '结算失败', true);
      } else {
        // 显示结算战报
        lastSettlement = {
          settlements: result.settlements || [],
          roomName: result.roomName || state.room?.name || '',
          roomCode: state.room?.code || '',
          settledAt: result.settledAt ?? Date.now(),
        };
        showSettlementModal(lastSettlement.settlements);
      }
    });
  });

  elements.addBotBtn.addEventListener('click', addBot);

  // 移动端"⋯"更多操作菜单
  function closeMoreMenu() {
    if (elements.headerSecondary) {
      elements.headerSecondary.classList.remove('open');
    }
  }

  if (elements.moreBtn && elements.headerSecondary) {
    elements.moreBtn.addEventListener('click', (event) => {
      event.stopPropagation();
      elements.headerSecondary.classList.toggle('open');
    });

    // 点击面板外自动收起
    document.addEventListener('click', (event) => {
      if (!elements.headerSecondary.classList.contains('open')) return;
      if (elements.headerSecondary.contains(event.target)) return;
      if (elements.moreBtn.contains(event.target)) return;
      closeMoreMenu();
    });

    // 点击面板内普通按钮后收起（下拉选择机器人等级不收起）
    elements.headerSecondary.addEventListener('click', (event) => {
      if (event.target.closest('button')) {
        closeMoreMenu();
      }
    });
  }

  if (elements.logToggleBtn) {
    elements.logToggleBtn.addEventListener('click', () => {
      elements.actionLogWrap.classList.toggle('hidden');
      const isOpen = !elements.actionLogWrap.classList.contains('hidden');
      elements.logToggleBtn.textContent = isOpen ? '行动日志 \u25b4' : '行动日志 \u25be';
    });
  }

  elements.startHandBtn.addEventListener('click', () => {
    if (!state.room) return;
    sendStartHandRequest();
  });

  function togglePeekCards() {

    state.peekCards = !state.peekCards;

    elements.peekCardsBtn.textContent = state.peekCards ? '\u9690\u85CF\u624B\u724C' : '\u67E5\u770B\u624B\u724C';

    elements.peekCardsBtn.classList.toggle('active', state.peekCards);

    if (state.room) renderViewerCards(state.room);

  }

  elements.peekCardsBtn.addEventListener('click', togglePeekCards);

  if (elements.soundToggleBtn) {
    elements.soundToggleBtn.addEventListener('click', () => {
      soundState.enabled = !soundState.enabled;
      localStorage.setItem('poker-sound', soundState.enabled ? 'on' : 'off');
      updateSoundToggleBtn();
      if (soundState.enabled) SFX.turn();
      showToast(soundState.enabled ? '音效已开启' : '音效已关闭');
    });
  }

  renderLobby();

  updateSoundToggleBtn();

  // Modal functions
  function closeModal() {
    const modal = document.getElementById('handEndModal');
    modal.classList.add('hidden');
    state.modalOpen = false;
    const nextHandBtn = document.getElementById('nextHandBtn');
    nextHandBtn.disabled = true;
    // 收起后若本局结算仍有效，显示「查看结算」悬浮入口
    const hand = state.room?.hand;
    setHandEndFab(hand?.status === 'finished' && hand.id === state.lastHandResults);
  }

  // 结算弹窗与台面之间来回切换（不重新注册下一局自动关闭监听）
  function reopenHandEndModal() {
    if (!state.room || state.modalOpen) return;
    if (state.room.hand?.status !== 'finished') return;
    setHandEndFab(false);
    renderHandEndResults(state.room);
    const modal = document.getElementById('handEndModal');
    modal.classList.remove('hidden');
    state.modalOpen = true;
    updateNextHandButtons();
  }

  function setHandEndFab(visible) {
    const fab = document.getElementById('handEndFab');
    if (!fab) return;
    fab.classList.toggle('hidden', !visible);
    if (!visible) return;
    // 顶栏高度随设备字体缩放/安全区变化，动态贴在其下方，避免被遮挡
    const topbar = document.querySelector('.topbar');
    const bottom = topbar ? topbar.getBoundingClientRect().bottom : 48;
    fab.style.top = `${Math.round(Math.max(bottom + 8, 52))}px`;
  }

  function showSettlementModal(settlements) {
    const modal = document.getElementById('settlementModal');
    const modalResults = document.getElementById('settlementResults');
    modalResults.innerHTML = '';

    const title = document.createElement('h4');
    title.textContent = '最终战报';
    title.style.textAlign = 'center';
    title.style.marginBottom = '20px';
    modalResults.appendChild(title);

    const table = document.createElement('div');
    table.className = 'settlement-table';

    settlements.forEach(s => {
      const row = document.createElement('div');
      row.className = 'settlement-row';

      const nameCell = document.createElement('div');
      nameCell.className = 'settlement-cell settlement-name';
      nameCell.textContent = s.name;

      const totalBuyinCell = document.createElement('div');
      totalBuyinCell.className = 'settlement-cell';
      totalBuyinCell.textContent = `买入: ${s.totalBuyIn}`;

      const finalStackCell = document.createElement('div');
      finalStackCell.className = 'settlement-cell';
      finalStackCell.textContent = `剩余: ${s.currentStack}`;

      const profitCell = document.createElement('div');
      profitCell.className = 'settlement-cell settlement-profit';
      const profit = s.profitLoss;
      const profitRatio = s.totalBuyIn > 0 ? ((profit / s.totalBuyIn) * 100).toFixed(1) : '0.0';
      profitCell.textContent = `${profit >= 0 ? '+' : ''}${profit} (${profitRatio}%)`;
      profitCell.style.color = profit >= 0 ? '#4ade80' : '#f87171';
      profitCell.style.fontWeight = 'bold';

      row.appendChild(nameCell);
      row.appendChild(totalBuyinCell);
      row.appendChild(finalStackCell);
      row.appendChild(profitCell);

      table.appendChild(row);
    });

    modalResults.appendChild(table);
    modal.classList.remove('hidden');
  }

  function closeSettlementModal() {
    const modal = document.getElementById('settlementModal');
    modal.classList.add('hidden');
    // 结算后返回大厅（服务端已删除房间，本地同步退出）
    exitToLocalLobby();
  }

  function renderHandEndResults(room) {
    const modalResults = document.getElementById('modalResults');
    modalResults.innerHTML = '';

    const winners = room.hand.winners;
    const totalPot = room.hand.finalPot ?? room.hand.pot;

    if (winners.length === 0) {
      const noWinner = document.createElement('div');
      noWinner.className = 'modal-body';
      noWinner.textContent = '本局无人获胜';
      modalResults.appendChild(noWinner);
    } else {
      winners.forEach(winner => {
        const resultDiv = document.createElement('div');
        resultDiv.className = 'player-result';

        const nameDiv = document.createElement('div');
        nameDiv.className = 'player-result-name';
        nameDiv.textContent = winner.name;

        const cardsDiv = document.createElement('div');
        cardsDiv.className = 'player-result-cards';
        if (winner.holeCards && winner.holeCards.length > 0 && winner.holeCards[0] !== '??') {
          winner.holeCards.forEach(card => {
            cardsDiv.appendChild(renderCard(card));
          });
        }

        const handLabelDiv = document.createElement('div');
        handLabelDiv.className = 'player-result-hand';
        handLabelDiv.textContent = winner.handLabel || '';

        const amountDiv = document.createElement('div');
        amountDiv.className = 'player-result-amount player-result-win';
        amountDiv.textContent = `+${winner.amount} 筹码`;

        resultDiv.appendChild(nameDiv);
        if (winner.holeCards && winner.holeCards.length > 0 && winner.holeCards[0] !== '??') {
          resultDiv.appendChild(cardsDiv);
        }
        if (winner.handLabel) {
          resultDiv.appendChild(handLabelDiv);
        }
        resultDiv.appendChild(amountDiv);

        modalResults.appendChild(resultDiv);
      });
    }

    // 弃牌获胜的真人赢家：选择是否秀牌（服务端 room:state 广播后所有人看到结果）
    const hand = room.hand;
    if (hand.status === 'finished' && !hand.revealed && !hand.shownCards
        && hand.showOffer?.token === state.token
        && state.hideShowOffer !== hand.id) {
      const choiceRow = document.createElement('div');
      choiceRow.className = 'show-choice-row';

      const label = document.createElement('span');
      label.className = 'show-choice-label';
      label.textContent = '亮出手牌？';
      choiceRow.appendChild(label);

      const options = [
        { text: '秀第一张', showCount: 1, side: 0 },
        { text: '秀第二张', showCount: 1, side: 1 },
        { text: '秀两张', showCount: 2, side: null },
      ];
      for (const option of options) {
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'show-choice-btn';
        btn.textContent = option.text;
        btn.addEventListener('click', () => {
          socket.emit('room:show', {
            roomCode: state.room.code,
            token: state.token,
            showCount: option.showCount,
            side: option.side,
          }, (result) => {
            if (!result?.ok) showToast(result?.error || '秀牌失败', true);
          });
        });
        choiceRow.appendChild(btn);
      }

      const muckBtn = document.createElement('button');
      muckBtn.type = 'button';
      muckBtn.className = 'show-choice-btn show-choice-muted';
      muckBtn.textContent = '不秀';
      muckBtn.addEventListener('click', () => {
        state.hideShowOffer = room.hand.id;
        renderHandEndResults(state.room);
      });
      choiceRow.appendChild(muckBtn);

      modalResults.appendChild(choiceRow);
    }

    const potSummary = document.createElement('div');
    potSummary.className = 'pot-summary';
    potSummary.innerHTML = `💰 底池总额: <strong>${totalPot} 筹码</strong>`;

    modalResults.appendChild(potSummary);
  }

  function showHandEndModal(room) {
    const modal = document.getElementById('handEndModal');
    setHandEndFab(false);
    renderHandEndResults(room);

    modal.classList.remove('hidden');
    state.modalOpen = true;

    // Update buttons based on room state
    updateNextHandButtons();

    // Auto close modal when next hand starts
    const closeModalOnNewHand = () => {
      socket.off('room:hand:start', closeModalOnNewHand);
      closeModal();
    };

    socket.on('room:hand:start', closeModalOnNewHand);
  }

  function updateNextHandButtons() {
const nextHandBtn = document.getElementById('nextHandBtn');
    if (!state.room) return;
    const me = state.room.players.find((player) => player.isViewer);
    const canShow = state.room.hand?.status !== 'running' && me && me.seatIndex !== null;
    nextHandBtn.style.display = canShow ? 'block' : 'none';
    nextHandBtn.disabled = !canShow;
    if (canShow) updateStartControlButton(nextHandBtn, state.room);
  }

  // Modal event listeners
  const modalElement = document.getElementById('handEndModal');
  const modalCloseBtn = modalElement.querySelector('.modal-close');
const nextHandBtn = document.getElementById('nextHandBtn');
  const peekTableBtn = document.getElementById('peekTableBtn');
  const handEndFab = document.getElementById('handEndFab');

  modalCloseBtn.addEventListener('click', closeModal);

  modalElement.addEventListener('click', (e) => {
    if (e.target === modalElement) {
      closeModal();
    }
  });
nextHandBtn.addEventListener('click', () => {
    if (state.room) {
      sendStartHandRequest();
    }
  });

  // 弹窗 ⇄ 台面切换
  peekTableBtn.addEventListener('click', closeModal);
  handEndFab.addEventListener('click', reopenHandEndModal);

  // Settlement modal event listeners
  const settlementModal = document.getElementById('settlementModal');
  const settlementCloseBtn = settlementModal.querySelector('.modal-close');
  const settlementOkBtn = document.getElementById('settlementOkBtn');

  settlementCloseBtn.addEventListener('click', closeSettlementModal);
  settlementOkBtn.addEventListener('click', closeSettlementModal);
  if (elements.copyReportBtn) {
    elements.copyReportBtn.addEventListener('click', copyReportToClipboard);
  }
  settlementModal.addEventListener('click', (e) => {
    if (e.target === settlementModal) {
      closeSettlementModal();
    }
  });

  // Hand history modal
  function renderHistory(items) {
    elements.historyContent.innerHTML = '';
    if (!items.length) {
      const empty = document.createElement('p');
      empty.className = 'history-empty';
      empty.textContent = '暂无历史牌局';
      elements.historyContent.append(empty);
      return;
    }
    for (const entry of items) {
      const item = document.createElement('div');
      item.className = 'history-item';

      const head = document.createElement('div');
      head.className = 'history-head';
      const titleSpan = document.createElement('span');
      titleSpan.textContent = `第 ${entry.handNo} 局${entry.byFold ? ' · 弃牌获胜' : ''}`;
      const potSpan = document.createElement('span');
      potSpan.textContent = `底池 ${entry.finalPot ?? 0}`;
      head.append(titleSpan, potSpan);
      item.append(head);

      const winnersDiv = document.createElement('div');
      winnersDiv.className = 'history-winners';
      const winnersText = (entry.winners || [])
        .map((winner) => `${winner.name} +${winner.amount}${winner.handLabel ? `（${winner.handLabel}）` : ''}`)
        .join('，');
      winnersDiv.textContent = winnersText || '—';
      item.append(winnersDiv);

      // 显示所有参与者的盈亏
      if (entry.participants && entry.participants.length > 0) {
        const participantsDiv = document.createElement('div');
        participantsDiv.className = 'history-participants';
        const sorted = [...entry.participants].sort((a, b) => (b.profitLoss ?? 0) - (a.profitLoss ?? 0));
        const participantsText = sorted
          .map((p) => {
            const sign = (p.profitLoss ?? 0) >= 0 ? '+' : '';
            const departed = p.departed ? ' (已离场)' : '';
            return `${p.name} ${sign}${p.profitLoss ?? 0}${departed}`;
          })
          .join('，');
        participantsDiv.textContent = '参与者：' + participantsText;
        item.append(participantsDiv);
      }

      elements.historyContent.append(item);
    }
  }

  async function openHistory() {
    if (!state.room) return;
    elements.historyContent.innerHTML = '';
    const loading = document.createElement('p');
    loading.className = 'history-empty';
    loading.textContent = '加载中...';
    elements.historyContent.append(loading);
    elements.historyModal.classList.remove('hidden');
    try {
      const response = await fetch(`/api/rooms/${encodeURIComponent(state.room.code)}/history?limit=12`);
      if (!response.ok) throw new Error('bad status');
      const data = await response.json();
      renderHistory(data.history || []);
    } catch {
      elements.historyContent.innerHTML = '';
      const failed = document.createElement('p');
      failed.className = 'history-empty';
      failed.textContent = '加载失败，请稍后再试';
      elements.historyContent.append(failed);
    }
  }

  elements.historyBtn.addEventListener('click', openHistory);

  const historyCloseBtn = elements.historyModal.querySelector('.modal-close');
  historyCloseBtn.addEventListener('click', () => elements.historyModal.classList.add('hidden'));
  elements.historyModal.addEventListener('click', (e) => {
    if (e.target === elements.historyModal) {
      elements.historyModal.classList.add('hidden');
    }
  });

  function sendStartHandRequest() {
    if (!state.room) return;
    const startState = getHandStartState(state.room);
    const eventName = startState.needsReady ? 'room:ready' : 'room:start';
    socket.emit(eventName, {
      roomCode: state.room.code,
      token: state.token,
    }, (result) => {
      if (!result?.ok) {
        showToast(result?.error || '开局失败', true);
        nextHandBtn.disabled = false;
        return;
      }
      if (result.room) renderTable(result.room);
    });
  }

  function getCurrentStreetActions(room) {
    if (!room.hand || !room.hand.street) return {};
    
    const streetActions = room.hand.playerStreetActions || {};
    return streetActions;
  }

  function createActionElement(actionType, amount) {
    const actionEl = document.createElement('div');
    actionEl.className = 'player-action';
    
    const ACTION_TEXT = {
      raise: amount ? `加注 ${amount}` : '加注',
      allin: amount ? `全下 ${amount}` : '全下',
      call: '跟注',
      check: '过牌',
      fold: '弃牌',
    };
    actionEl.textContent = ACTION_TEXT[actionType] || actionType;
    
    const TYPE_CLASS = {
      raise: 'raise',
      call: 'call',
      fold: 'fold',
      check: 'check',
      allin: 'allin',
    };
    if (TYPE_CLASS[actionType]) {
      actionEl.classList.add(TYPE_CLASS[actionType]);
    }
    
    return actionEl;
  }

  // 增强版座位渲染函数
  function enhancedRenderSeatGrid(room) {
    elements.seatGrid.innerHTML = '';

    const seats = Array.from({ length: room.config.maxSeats }, (_, index) => ({
      index,
      player: room.players.find((player) => player.seatIndex === index) || null,
    }));

    const positions = layoutSeats(room.config.maxSeats);

    seats.forEach((seat) => {
      const card = document.createElement('div');

      const [x, y] = positions[seat.index];

      card.className = 'seat';

      if (!seat.player) {
        card.classList.add('empty');
        const label = document.createElement('span');
        label.textContent = `${seat.index + 1} 号位`;
        const sitBtn = document.createElement('button');
        sitBtn.type = 'button';
        sitBtn.textContent = '坐下';
        sitBtn.addEventListener('click', () => sitAtSeat(seat.index));
        card.append(label, sitBtn);
        card.style.left = `${x}%`;
        card.style.top = `${y}%`;
        elements.seatGrid.append(card);
        return;
      }

      if (seat.player.isViewer) card.classList.add('viewer');

      // 赢家金色发光高亮（本局结束状态）
      if (
        room.hand?.status === 'finished'
        && (room.hand.winners ?? []).some((winner) => winner.name === seat.player.name)
      ) {
        card.classList.add('winner');
      }

      // 添加行动玩家闪烁提示
      if (room.hand?.actionSeat === seat.index) {
        card.classList.add('active-turn');
      }

      card.style.left = `${x}%`;
      card.style.top = `${y}%`;

      // 按实际坐标决定行动气泡方向
      const isTop = y < 38;
      const isBottom = y > 62;

      if (isTop) {
        card.dataset.position = 'top';
      } else if (isBottom) {
        card.dataset.position = 'bottom';
      } else {
        card.dataset.position = 'middle';
      }

      // 庄家 / 小盲 / 大盲标记
      if (room.hand) {
        let badge = null;
        if (room.hand.buttonSeat === seat.index) {
          badge = document.createElement('span');
          badge.className = 'seat-badge d';
          badge.textContent = 'D';
        } else if (room.hand.smallBlindSeat === seat.index) {
          badge = document.createElement('span');
          badge.className = 'seat-badge sb';
          badge.textContent = 'SB';
        } else if (room.hand.bigBlindSeat === seat.index) {
          badge = document.createElement('span');
          badge.className = 'seat-badge bb';
          badge.textContent = 'BB';
        }
        if (badge) card.appendChild(badge);
      }

      // 添加本轮操作信息
      const streetActions = getCurrentStreetActions(room);
      const playerStreetAction = streetActions[seat.index];
      
      if (playerStreetAction) {
        const actionEl = createActionElement(playerStreetAction.type, playerStreetAction.amount);
        card.appendChild(actionEl);
      }

      const title = document.createElement('div');
      title.className = 'seat-name';
      const playerName = document.createElement('span');
      playerName.textContent = seat.player.name;
      const seatNumber = document.createElement('span');
      seatNumber.textContent = `#${seat.index + 1}`;
      title.append(playerName, seatNumber);

      const stack = document.createElement('div');
      stack.className = 'seat-stack';
      stack.textContent = `${seat.player.stack} 筹码`;

      const status = document.createElement('div');
      status.className = 'seat-status';
      status.textContent = seatText(room, seat);

      card.append(title, stack);

      // 本轮已投入筹码
      if (room.hand?.status === 'running' && seat.player.streetContribution > 0) {
        const bet = document.createElement('div');
        bet.className = 'seat-bet';
        bet.textContent = `${seat.player.streetContribution}`;
        card.append(bet);
      }

      card.append(status);

      if (room.self?.isHost && seat.player.targetToken && !seat.player.isHost && !seat.player.isViewer) {
        const manageButton = document.createElement('button');
        manageButton.type = 'button';
        manageButton.className = 'ghost seat-manage-btn';
        manageButton.textContent = seat.player.isBot ? '移除 AI' : '踢出';
        manageButton.disabled = room.summary?.handStatus === 'running';
        manageButton.addEventListener('click', () => manageMember(seat.player));
        card.append(manageButton);
      }

      elements.seatGrid.append(card);

    });
  }


})();
