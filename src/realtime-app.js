import express from 'express';
import http from 'node:http';
import { Server as SocketIOServer } from 'socket.io';
import { GameManager, makeToken, DEFAULT_CONFIG } from './game-engine.js';
import { RoomStore } from './store.js';

export function createRealtimeApp({ store = new RoomStore() } = {}) {
  const app = express();
  app.use(express.json({ limit: '1mb' }));
  // no-cache：每次协商缓存（内容未变返回 304），避免移动端 WebView 长期使用旧版页面/脚本
  app.use(express.static('public', {
    setHeaders: (res) => res.setHeader('Cache-Control', 'no-cache'),
  }));

  let io = null;
  const manager = new GameManager(store, {
    onUpdate(room) {
      if (!io) return;
      for (const player of room.players) {
        const socketId = room.socketMap?.[player.token];
        if (!socketId) continue;
        const socket = io.sockets.sockets.get(socketId);
        if (socket) {
          socket.emit('room:state', manager.getRoomView(room.code, player.token));
        }
      }
      io.emit('rooms:list', { rooms: manager.listRooms() });
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
    config: DEFAULT_CONFIG,
  });

  app.get('/api/rooms', (_req, res) => {
    res.json({ rooms: manager.listRooms() });
  });

  app.get('/api/rooms/:code', (req, res) => {
    const view = manager.getRoomView(req.params.code, req.query.token ?? null);
    if (!view) {
      res.status(404).json({ error: 'not_found' });
      return;
    }
    res.json(view);
  });

  app.get('/api/rooms/:code/history', (req, res) => {
    res.json({ history: manager.listHandHistory(req.params.code, Number(req.query.limit ?? 10)) });
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
    socket.emit('rooms:list', { rooms: manager.listRooms() });

    socket.on('rooms:list', (_payload, ack) => {
      ok(ack, { rooms: manager.listRooms() });
    });

    socket.on('session:resume', (payload = {}, ack) => {
      const roomCode = payload.roomCode || socket.data.roomCode;
      const token = payload.token || socket.data.token;
      const room = roomCode && token ? manager.resumeRoom(roomCode, token) : null;
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
        if (roomCode && token) {
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
        const result = manager.settleRoom(roomCode, token);
        ok(ack, result);
      } catch (error) {
        fail(ack, error);
      }
    });

    socket.on('disconnect', () => {
      if (socket.data.roomCode && socket.data.token) {
        manager.disconnectSocket(socket.data.roomCode, socket.data.token, socket.id);
      }
    });
  });

  const timer = setInterval(() => manager.tick(), 1000);
  timer.unref();

  return {
    app,
    server,
    io,
    manager,
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


