import express from 'express';
import http from 'node:http';
import { readFileSync } from 'node:fs';
import { Server as SocketIOServer } from 'socket.io';
import { GameManager, makeToken, DEFAULT_CONFIG } from './game-engine.js';
import { ZjhManager, ZJH_DEFAULT_CONFIG } from './zjh-engine.js';
import { GdyManager, GDY_DEFAULT_CONFIG } from './gdy-engine.js';
import { DnManager, DN_DEFAULT_CONFIG } from './douniu-engine.js';
import { RoomStore } from './store.js';

// 读取项目根目录的 .env（存在时覆盖同名环境变量，使改配置只需重启进程）
// 无 .env（本地开发/测试）时静默跳过
function loadEnvFile() {
  try {
    const text = readFileSync(new URL('../.env', import.meta.url), 'utf8');
    for (const line of text.split(/\r?\n/)) {
      const matched = line.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
      if (matched) process.env[matched[1]] = matched[2].trim();
    }
  } catch {
    // 无 .env 文件则忽略
  }
}
loadEnvFile();

export function createRealtimeApp({ store = new RoomStore() } = {}) {
  // 启动时清理 30 天前的牌局历史，防止 hand_history 无限膨胀拖慢写库
  try {
    store.cleanOldHistory?.(Date.now() - 30 * 24 * 60 * 60 * 1000);
  } catch {
    // 历史清理失败不阻塞启动
  }
  const app = express();
  app.use(express.json({ limit: '1mb' }));
  // no-cache：每次协商缓存（内容未变返回 304），避免移动端 WebView 长期使用旧版页面/脚本
  app.use(express.static('public', {
    setHeaders: (res) => res.setHeader('Cache-Control', 'no-cache'),
  }));

  // root 管理密钥：环境变量 ROOT_KEY 可覆盖，默认 root123（仅适合内网/私人部署，公网务必改掉）
  const rootKey = process.env.ROOT_KEY ?? 'root123';

  // 引擎 tick 周期（毫秒）：默认 200ms，四引擎共用，环境变量 GAME_TICK_MS 可调。
  // 放在 createRealtimeApp 内读取，确保根目录 .env 已被 loadEnvFile() 加载。
  // 调小只会让机器人行动与超时托管更及时；调大则机器人出牌变慢。
  const rawTickMs = process.env.GAME_TICK_MS;
  const envTickMs = rawTickMs === undefined || rawTickMs === '' ? NaN : Number(rawTickMs);
  const tickMs = Number.isFinite(envTickMs)
    ? Math.min(1000, Math.max(50, Math.floor(envTickMs)))
    : 200;

  let io = null;

  // 四款游戏（德州/炸金花/干瞪眼/斗牛）共用的广播回调
  function managerCallbacks() {
    return {
      onUpdate(room) {
        if (!io) return;
        const viewManager = managerForGame(room.gameType);
        for (const player of room.players) {
          const socketId = room.socketMap?.[player.token];
          if (!socketId) continue;
          const socket = io.sockets.sockets.get(socketId);
          if (socket) {
            const view = viewManager.getRoomView(room.code, player.token);
            socket.emit('room:state', view);
          }
        }
        emitRoomsList();
      },
      onHandStart(room) {
        if (!io) return;
        for (const player of room.players) {
          const socketId = room.socketMap?.[player.token];
          if (!socketId) continue;
          const socket = io.sockets.sockets.get(socketId);
          if (socket) {
            socket.emit('room:hand:start', { roomCode: room.code, handNo: room.handNo });
          }
        }
      },
      onClose(room, info = {}) {
        if (!io) return;
        for (const [token, socketId] of Object.entries(room.socketMap ?? {})) {
          const socket = io.sockets.sockets.get(socketId);
          if (!socket) continue;
          socket.emit('room:closed', { roomCode: room.code, reason: info.reason ?? 'closed' });
          socket.leave(room.code);
          if (socket.data.token === token) {
            socket.data.roomCode = null;
          }
        }
      },
    };
  }

  // 先建德州 manager（占位回调），再建炸金花/干瞪眼/斗牛 manager，最后互挂全局房间码查重
  const otherCodes = (...exclude) => {
    const all = [gameManager, zjhManager, gdyManager, dnManager];
    const codes = new Set();
    for (const manager of all) {
      if (!manager || exclude.includes(manager)) continue;
      for (const code of manager.rooms.keys()) codes.add(code);
    }
    return codes;
  };
  const managerForGame = (gameType) => {
    if (gameType === 'zjh') return zjhManager;
    if (gameType === 'gdy') return gdyManager;
    if (gameType === 'dn') return dnManager;
    return gameManager;
  };
  const gameManager = new GameManager(store, {
    ...managerCallbacks(),
    config: DEFAULT_CONFIG,
    occupiedCodes: () => otherCodes(gameManager),
  });
  const zjhManager = new ZjhManager(store, {
    ...managerCallbacks(),
    config: ZJH_DEFAULT_CONFIG,
    occupiedCodes: () => otherCodes(zjhManager),
  });
  const gdyManager = new GdyManager(store, {
    ...managerCallbacks(),
    config: GDY_DEFAULT_CONFIG,
    occupiedCodes: () => otherCodes(gdyManager),
  });
  const dnManager = new DnManager(store, {
    ...managerCallbacks(),
    config: DN_DEFAULT_CONFIG,
    occupiedCodes: () => otherCodes(dnManager),
  });

  function mergedRooms() {
    return [
      ...gameManager.listRooms(),
      ...zjhManager.listRooms(),
      ...gdyManager.listRooms(),
      ...dnManager.listRooms(),
    ];
  }

  let roomsListTimer = null;
  // 上一次广播的房间列表指纹：内容未变则不再广播，避免牌桌内每 500ms 被无意义唤醒
  let lastRoomsListFingerprint = '';

  function emitRoomsListNow() {
    if (!io) return;
    if (roomsListTimer) {
      clearTimeout(roomsListTimer);
      roomsListTimer = null;
    }
    const rooms = mergedRooms();
    const fingerprint = JSON.stringify(rooms);
    if (fingerprint === lastRoomsListFingerprint) return;
    lastRoomsListFingerprint = fingerprint;
    io.emit('rooms:list', { rooms });
  }

  // 动作路径的全服房间列表广播做 500ms 合并：机器人房每秒一手时避免持续轰炸所有客户端
  function emitRoomsList() {
    if (!io || roomsListTimer) return;
    roomsListTimer = setTimeout(() => {
      roomsListTimer = null;
      emitRoomsListNow();
    }, 500);
  }

  // 按房间码定位所属 manager
  function locateManager(code) {
    const key = String(code ?? '').trim().toUpperCase();
    if (gameManager.rooms.has(key)) return gameManager;
    if (zjhManager.rooms.has(key)) return zjhManager;
    if (gdyManager.rooms.has(key)) return gdyManager;
    if (dnManager.rooms.has(key)) return dnManager;
    return null;
  }

  app.get('/api/rooms', (_req, res) => {
    res.json({ rooms: mergedRooms() });
  });

  app.get('/api/rooms/:code', (req, res) => {
    const manager = locateManager(req.params.code);
    const view = manager?.getRoomView(req.params.code, req.query.token ?? null);
    if (!view) {
      res.status(404).json({ error: 'not_found' });
      return;
    }
    res.json(view);
  });

  app.get('/api/rooms/:code/history', (req, res) => {
    const manager = locateManager(req.params.code);
    if (!manager) {
      res.status(404).json({ error: 'not_found' });
      return;
    }
    // 限制上限，避免 ?limit=超大值 把整表历史读出来、非数字导致 SQL 报错
    const limit = Math.min(Math.max(Number.parseInt(req.query.limit, 10) || 10, 1), 50);
    res.json({ history: manager.listHandHistory(req.params.code, limit) });
  });

  // ===== root 管理：查看全部房间 / 强制删除房间（含进行中对局） =====
  app.get('/api/root/rooms', (req, res) => {
    if (String(req.query.key ?? '') !== rootKey) {
      res.status(403).json({ error: '密钥错误' });
      return;
    }
    res.json({ rooms: mergedRooms() });
  });

  app.post('/api/root/rooms/close', (req, res) => {
    if (String(req.body?.key ?? '') !== rootKey) {
      res.status(403).json({ error: '密钥错误' });
      return;
    }
    const manager = locateManager(req.body?.code);
    if (!manager) {
      res.status(404).json({ error: '房间不存在' });
      return;
    }
    try {
      const removed = manager.rootRemoveRoom(req.body.code);
      emitRoomsListNow();
      res.json({ ok: true, ...removed });
    } catch (error) {
      res.status(400).json({ error: error.message });
    }
  });

  const server = http.createServer(app);
  io = new SocketIOServer(server, {
    cors: { origin: '*' },
    pingInterval: 10000,
    pingTimeout: 20000,
  });

  function ok(ack, body = {}) {
    ack?.({ ok: true, ...body });
  }

  function fail(ack, error) {
    ack?.({ ok: false, error: error.message });
  }

  io.on('connection', (socket) => {
    socket.data.token = socket.handshake.auth?.token || makeToken();
    socket.data.roomCode = socket.handshake.auth?.roomCode || null;

    socket.emit('session:token', { token: socket.data.token });
    socket.emit('rooms:list', { rooms: mergedRooms() });

    socket.on('rooms:list', (_payload, ack) => {
      ok(ack, { rooms: mergedRooms() });
    });

    socket.on('session:resume', (payload = {}, ack) => {
      const roomCode = payload.roomCode || socket.data.roomCode;
      const token = payload.token || socket.data.token;
      const manager = roomCode && token ? locateManager(roomCode) : null;
      const room = manager?.resumeRoom(roomCode, token) ?? null;
      if (!room) {
        socket.emit('session:resume:miss');
        fail(ack, new Error('无法恢复会话'));
        return;
      }
      socket.join(room.code);
      socket.data.roomCode = room.code;
      socket.data.token = token;
      manager.connectSocket(room.code, token, socket.id);
      const view = manager.getRoomView(room.code, token);
      socket.emit('room:state', view);
      ok(ack, { roomCode: room.code, token, room: view });
    });

    socket.on('room:create', (payload = {}, ack) => {
      try {
        const token = payload.token || socket.data.token || makeToken();
        const gameType = ['zjh', 'gdy', 'dn'].includes(payload.gameType) ? payload.gameType : 'texas';
        const manager = managerForGame(gameType);
        const created = manager.createRoom({
          token,
          roomName: payload.roomName,
          playerName: payload.playerName,
          config: payload.config,
        });
        socket.join(created.room.code);
        socket.data.roomCode = created.room.code;
        socket.data.token = created.token;
        manager.connectSocket(created.room.code, created.token, socket.id);
        const view = manager.getRoomView(created.room.code, created.token);
        socket.emit('room:state', view);
        ok(ack, { roomCode: created.room.code, token: created.token, room: view });
      } catch (error) {
        fail(ack, error);
      }
    });

    socket.on('room:join', (payload = {}, ack) => {
      try {
        const token = payload.token || socket.data.token || makeToken();
        const manager = locateManager(payload.roomCode);
        if (!manager) throw new Error('房间不存在');
        const joined = manager.joinRoom(payload.roomCode, {
          token,
          playerName: payload.playerName,
        });
        socket.join(joined.room.code);
        socket.data.roomCode = joined.room.code;
        socket.data.token = joined.token;
        manager.connectSocket(joined.room.code, joined.token, socket.id);
        const view = manager.getRoomView(joined.room.code, joined.token);
        socket.emit('room:state', view);
        ok(ack, { roomCode: joined.room.code, token: joined.token, room: view });
      } catch (error) {
        fail(ack, error);
      }
    });

    socket.on('room:leave', (payload = {}, ack) => {
      try {
        const roomCode = payload.roomCode || socket.data.roomCode;
        const token = payload.token || socket.data.token;
        const manager = roomCode ? locateManager(roomCode) : null;
        if (manager && token) {
          manager.disconnectSocket(roomCode, token, socket.id);
          socket.leave(String(roomCode).trim().toUpperCase());
          if (socket.data.roomCode === roomCode) {
            socket.data.roomCode = null;
          }
        }
        ok(ack);
      } catch (error) {
        fail(ack, error);
      }
    });

    socket.on('room:sit', (payload = {}, ack) => {
      try {
        const roomCode = payload.roomCode || socket.data.roomCode;
        const token = payload.token || socket.data.token;
        const manager = locateManager(roomCode);
        if (!manager) throw new Error('房间不存在');
        const room = manager.seatPlayer(roomCode, token, Number(payload.seatIndex));
        ok(ack, { room: manager.getRoomView(room.code, token) });
      } catch (error) {
        fail(ack, error);
      }
    });

    socket.on('room:stand', (payload = {}, ack) => {
      try {
        const roomCode = payload.roomCode || socket.data.roomCode;
        const token = payload.token || socket.data.token;
        const manager = locateManager(roomCode);
        if (!manager) throw new Error('房间不存在');
        const room = manager.standPlayer(roomCode, token);
        ok(ack, { room: manager.getRoomView(room.code, token) });
      } catch (error) {
        fail(ack, error);
      }
    });

    socket.on('room:start', (payload = {}, ack) => {
      try {
        const roomCode = payload.roomCode || socket.data.roomCode;
        const token = payload.token || socket.data.token;
        const manager = locateManager(roomCode);
        if (!manager) throw new Error('房间不存在');
        const room = manager.startHand(roomCode, token);
        ok(ack, { room: manager.getRoomView(room.code, token) });
      } catch (error) {
        fail(ack, error);
      }
    });

    socket.on('room:ready', (payload = {}, ack) => {
      try {
        const roomCode = payload.roomCode || socket.data.roomCode;
        const token = payload.token || socket.data.token;
        const manager = locateManager(roomCode);
        if (!manager) throw new Error('房间不存在');
        const room = manager.toggleReady(roomCode, token);
        ok(ack, { room: manager.getRoomView(room.code, token) });
      } catch (error) {
        fail(ack, error);
      }
    });

    // 斗牛：本局结束后由庄家决定下一局续庄 / 移交给指定玩家
    socket.on('room:banker', (payload = {}, ack) => {
      try {
        const roomCode = payload.roomCode || socket.data.roomCode;
        const token = payload.token || socket.data.token;
        const manager = locateManager(roomCode);
        if (!manager) throw new Error('房间不存在');
        if (manager !== dnManager) throw new Error('该游戏没有庄家');
        const action = payload.action === 'transfer' ? 'transfer' : 'keep';
        const room = manager.setBanker(roomCode, token, action, payload.targetToken ?? null);
        ok(ack, { room: manager.getRoomView(room.code, token) });
      } catch (error) {
        fail(ack, error);
      }
    });

    socket.on('room:rebuy', (payload = {}, ack) => {
      try {
        const roomCode = payload.roomCode || socket.data.roomCode;
        const token = payload.token || socket.data.token;
        const manager = locateManager(roomCode);
        if (!manager) throw new Error('房间不存在');
        const room = manager.rebuy(roomCode, token, payload.amount);
        ok(ack, { room: manager.getRoomView(room.code, token) });
      } catch (error) {
        fail(ack, error);
      }
    });

    socket.on('room:resume', (payload = {}, ack) => {
      try {
        const roomCode = payload.roomCode || socket.data.roomCode;
        const token = payload.token || socket.data.token;
        const manager = locateManager(roomCode);
        if (!manager) throw new Error('房间不存在');
        const room = manager.resumePlay(roomCode, token);
        ok(ack, { room: manager.getRoomView(room.code, token) });
      } catch (error) {
        fail(ack, error);
      }
    });

    socket.on('room:bot:add', (payload = {}, ack) => {
      try {
        const roomCode = payload.roomCode || socket.data.roomCode;
        const token = payload.token || socket.data.token;
        const manager = locateManager(roomCode);
        if (!manager) throw new Error('房间不存在');
        const room = manager.addBot(roomCode, token, payload.level);
        ok(ack, { room: manager.getRoomView(room.code, token) });
      } catch (error) {
        fail(ack, error);
      }
    });

    socket.on('room:bot:remove', (payload = {}, ack) => {
      try {
        const roomCode = payload.roomCode || socket.data.roomCode;
        const token = payload.token || socket.data.token;
        const manager = locateManager(roomCode);
        if (!manager) throw new Error('房间不存在');
        const room = manager.removeBot(roomCode, token, payload.botToken);
        ok(ack, { room: manager.getRoomView(room.code, token) });
      } catch (error) {
        fail(ack, error);
      }
    });

    socket.on('room:player:kick', (payload = {}, ack) => {
      try {
        const roomCode = payload.roomCode || socket.data.roomCode;
        const token = payload.token || socket.data.token;
        const targetToken = payload.targetToken;
        const manager = locateManager(roomCode);
        if (!manager) throw new Error('房间不存在');
        const targetSocketId = manager.getRoom(roomCode)?.socketMap?.[targetToken] ?? null;
        const room = manager.kickPlayer(roomCode, token, targetToken);

        if (targetSocketId) {
          const targetSocket = io.sockets.sockets.get(targetSocketId);
          if (targetSocket) {
            targetSocket.leave(room.code);
            targetSocket.data.roomCode = null;
            targetSocket.emit('room:kicked', {
              roomCode: room.code,
              reason: '你已被房主移出房间',
            });
          }
        }

        ok(ack, { room: manager.getRoomView(room.code, token) });
      } catch (error) {
        fail(ack, error);
      }
    });

    socket.on('room:action', (payload = {}, ack) => {
      try {
        const roomCode = payload.roomCode || socket.data.roomCode;
        const token = payload.token || socket.data.token;
        const manager = locateManager(roomCode);
        if (!manager) throw new Error('房间不存在');
        const room = manager.applyAction(roomCode, token, payload.action);
        ok(ack, { room: manager.getRoomView(room.code, token) });
      } catch (error) {
        fail(ack, error);
      }
    });

    socket.on('room:show', (payload = {}, ack) => {
      try {
        const roomCode = payload.roomCode || socket.data.roomCode;
        const token = payload.token || socket.data.token;
        const manager = locateManager(roomCode);
        if (!manager) throw new Error('房间不存在');
        if (manager !== gameManager) throw new Error('该游戏无需秀牌');
        const room = manager.showCards(roomCode, token, {
          showCount: payload.showCount,
          side: payload.side,
        });
        ok(ack, { room: manager.getRoomView(room.code, token) });
      } catch (error) {
        fail(ack, error);
      }
    });

    socket.on('room:settle', (payload = {}, ack) => {
      try {
        const roomCode = payload.roomCode || socket.data.roomCode;
        const token = payload.token || socket.data.token;
        const manager = locateManager(roomCode);
        if (!manager) throw new Error('房间不存在');
        const result = manager.settleRoom(roomCode, token);
        ok(ack, result);
      } catch (error) {
        fail(ack, error);
      }
    });

    socket.on('disconnect', () => {
      if (socket.data.roomCode && socket.data.token) {
        const manager = locateManager(socket.data.roomCode);
        manager?.disconnectSocket(socket.data.roomCode, socket.data.token, socket.id);
      }
    });
  });

  const timer = setInterval(() => {
    // 单个引擎的异常不允许中断其他引擎的 tick，更不允许以未捕获异常拖垮进程
    try {
      gameManager.tick();
    } catch (error) {
      console.error('gameManager.tick error:', error);
    }
    try {
      zjhManager.tick();
    } catch (error) {
      console.error('zjhManager.tick error:', error);
    }
    try {
      gdyManager.tick();
    } catch (error) {
      console.error('gdyManager.tick error:', error);
    }
    try {
      dnManager.tick();
    } catch (error) {
      console.error('dnManager.tick error:', error);
    }
  }, tickMs);
  timer.unref();

  return {
    app,
    server,
    io,
    manager: gameManager,
    zjhManager,
    gdyManager,
    dnManager,
    rootKey,
    store,
    close() {
      clearInterval(timer);
      return new Promise((resolve, reject) => {
        const closeStore = () => {
          store.close();
          resolve();
        };
        io.close(() => {
          if (!server.listening) {
            closeStore();
            return;
          }
          server.close((error) => {
            if (error && error.code !== 'ERR_SERVER_NOT_RUNNING') {
              reject(error);
              return;
            }
            closeStore();
          });
        });
      });
    },
  };
}
