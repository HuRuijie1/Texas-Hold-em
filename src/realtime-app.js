import express from 'express';
import http from 'node:http';
import { Server as SocketIOServer } from 'socket.io';
import { GameManager, makeToken, DEFAULT_CONFIG } from './game-engine.js';
import { ZjhManager, ZJH_DEFAULT_CONFIG } from './zjh-engine.js';
import { GdyManager, GDY_DEFAULT_CONFIG } from './gdy-engine.js';
import { RoomStore } from './store.js';

export function createRealtimeApp({ store = new RoomStore() } = {}) {
  const app = express();
  app.use(express.json({ limit: '1mb' }));
  // no-cache：每次协商缓存（内容未变返回 304），避免移动端 WebView 长期使用旧版页面/脚本
  app.use(express.static('public', {
    setHeaders: (res) => res.setHeader('Cache-Control', 'no-cache'),
  }));

  // root 管理密钥：环境变量 ROOT_KEY 可覆盖，默认 root123（仅适合内网/私人部署，公网务必改掉）
  const rootKey = process.env.ROOT_KEY ?? 'root123';

  let io = null;

  // 三款游戏共用的广播回调
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

  // 先建德州 manager（占位回调），再建炸金花/干瞪眼 manager，最后互挂全局房间码查重
  const managerForGame = (gameType) => (gameType === 'zjh' ? zjhManager : gameType === 'gdy' ? gdyManager : gameManager);
  const gameManager = new GameManager(store, {
    ...managerCallbacks(),
    config: DEFAULT_CONFIG,
    occupiedCodes: () => new Set([
      ...(zjhManager?.rooms.keys() ?? []),
      ...(gdyManager?.rooms.keys() ?? []),
    ]),
  });
  const zjhManager = new ZjhManager(store, {
    ...managerCallbacks(),
    config: ZJH_DEFAULT_CONFIG,
    occupiedCodes: () => new Set([
      ...gameManager.rooms.keys(),
      ...(gdyManager?.rooms.keys() ?? []),
    ]),
  });
  const gdyManager = new GdyManager(store, {
    ...managerCallbacks(),
    config: GDY_DEFAULT_CONFIG,
    occupiedCodes: () => new Set([
      ...gameManager.rooms.keys(),
      ...zjhManager.rooms.keys(),
    ]),
  });

  function mergedRooms() {
    return [...gameManager.listRooms(), ...zjhManager.listRooms(), ...gdyManager.listRooms()];
  }

  function emitRoomsList() {
    if (!io) return;
    io.emit('rooms:list', { rooms: mergedRooms() });
  }

  // 按房间码定位所属 manager
  function locateManager(code) {
    const key = String(code ?? '').trim().toUpperCase();
    if (gameManager.rooms.has(key)) return gameManager;
    if (zjhManager.rooms.has(key)) return zjhManager;
    if (gdyManager.rooms.has(key)) return gdyManager;
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
    res.json({ history: manager.listHandHistory(req.params.code, Number(req.query.limit ?? 10)) });
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
      emitRoomsList();
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
        const gameType = payload.gameType === 'zjh' ? 'zjh' : payload.gameType === 'gdy' ? 'gdy' : 'texas';
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
  }, 1000);
  timer.unref();

  return {
    app,
    server,
    io,
    manager: gameManager,
    zjhManager,
    gdyManager,
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
