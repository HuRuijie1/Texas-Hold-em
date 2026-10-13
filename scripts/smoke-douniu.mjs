// 斗牛房间端到端冒烟：创建 → 加机器人 → 准备开局 → 盲注/自动结算 → 庄家决定 → 校验序列化视图
// 支持 DN_MODE=none 跑无庄模式；默认跑有庄模式
import { io } from 'socket.io-client';

const URL = process.env.SMOKE_URL ?? 'http://127.0.0.1:3999';
const BANKER_MODE = process.env.DN_MODE === 'none' ? 'none' : 'banker';
const PLAYERS = 3;
const STARTING_STACK = 1000;
const socket = io(URL, { transports: ['websocket'], auth: { token: 'smoke-host' } });

function emit(event, payload = {}) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${event} 超时`)), 8000);
    socket.emit(event, payload, (result) => {
      clearTimeout(timer);
      resolve(result);
    });
  });
}

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// 从 5 张里找一组点数之和为 10 的倍数的三张（选牛牌用）
function dnCardPoints(card) {
  const rank = card?.[0];
  if (rank === 'A') return 1;
  if (rank === 'T' || rank === 'J' || rank === 'Q' || rank === 'K') return 10;
  return Number(rank) || 0;
}

function findBull(cards) {
  for (let i = 0; i < cards.length - 2; i += 1) {
    for (let j = i + 1; j < cards.length - 1; j += 1) {
      for (let k = j + 1; k < cards.length; k += 1) {
        const combo = [cards[i], cards[j], cards[k]];
        if (combo.reduce((sum, card) => sum + dnCardPoints(card), 0) % 10 === 0) return combo;
      }
    }
  }
  return null;
}

let lastRoom = null;
socket.on('room:state', (room) => { lastRoom = room; });

socket.on('connect', async () => {
  try {
    const created = await emit('room:create', {
      token: 'smoke-host',
      playerName: '冒烟房主',
      roomName: `斗牛冒烟房(${BANKER_MODE === 'none' ? '无庄' : '有庄'})`,
      gameType: 'dn',
      config: {
        bankerMode: BANKER_MODE,
        maxSeats: 4,
        baseStake: 10,
        startingStack: STARTING_STACK,
        ...(BANKER_MODE === 'none' ? {} : { actionTimeoutMs: 15000 }),
      },
    });
    if (!created?.ok) throw new Error(`创建失败: ${created?.error}`);
    const code = created.roomCode;
    console.log('创建房间:', code, '类型:', created.room.gameType, '模式:', BANKER_MODE);

    await emit('room:sit', { roomCode: code, token: 'smoke-host', seatIndex: 0 });
    await emit('room:bot:add', { roomCode: code, token: 'smoke-host', level: 'beginner' });
    await emit('room:bot:add', { roomCode: code, token: 'smoke-host', level: 'advanced' });
    await emit('room:ready', { roomCode: code, token: 'smoke-host' });

    // 轮询等待对局推进（服务端 tick 驱动机器人）
    for (let i = 0; i < 60; i += 1) {
      if (lastRoom?.hand?.status === 'running' && lastRoom.hand.availableActions) break;
      if (lastRoom?.hand?.status === 'finished') break;
      await wait(200);
    }

    const hand = lastRoom?.hand;
    console.log('对局状态:', hand?.status, '模式:', lastRoom?.bankerMode, '阶段:', hand?.phase, '庄家座位:', hand?.bankerSeat, '已发牌:', hand?.dealt);
    console.log('庄家:', lastRoom?.banker?.name ?? '（无庄）', '我是庄家:', lastRoom?.isViewerBanker);

    // 有庄模式的盲注阶段：服务端与视图都不应有任何手牌（无庄模式开局即发牌）
    if (hand?.status === 'running' && hand.phase === 'bet') {
      const preDeal = lastRoom.players.every((p) => p.holeCards.every((c) => c === '??') || p.holeCards.length === 0);
      console.log('盲注阶段未发牌:', preDeal && !hand.dealt ? '✓' : '✗', '已发牌:', hand.dealt);
    }

    // 只有轮到本人（非庄家）时才盲注；庄家与无庄模式均无动作可做
    if (hand?.availableActions?.canBet) {
      const options = hand.availableActions.betOptions ?? [];
      const amount = options[0] ?? 1;
      console.log('执行盲注 ×' + amount);
      await emit('room:action', { roomCode: code, token: 'smoke-host', action: { type: 'bet', amount } });
    } else if (BANKER_MODE === 'banker' && hand?.status === 'running') {
      console.log('我是庄家，无需动作，等待闲家盲注');
    }

    for (let i = 0; i < 80; i += 1) {
      if (lastRoom?.hand?.status === 'finished') break;
      if (lastRoom?.hand?.status === 'running') {
        const actions = lastRoom.hand.availableActions;
        if (actions?.canBet) {
          await emit('room:action', {
            roomCode: code,
            token: 'smoke-host',
            action: { type: 'bet', amount: (actions.betOptions ?? [1])[0] },
          });
          continue;
        }
        if (actions?.canPick) {
          const me = lastRoom.players.find((p) => p.isViewer);
          const combo = findBull(me?.holeCards ?? []);
          const picked = await emit('room:action', {
            roomCode: code,
            token: 'smoke-host',
            action: combo ? { type: 'pick', cards: combo } : { type: 'nobull' },
          });
          console.log('执行选牌:', combo ? combo.join(' ') : '没牛', picked.ok ? '' : `（${picked.error}）`);
          continue;
        }
      }
      await wait(200);
    }

    const finished = lastRoom?.hand;
    console.log('终局状态:', finished?.status, '提示:', finished?.dealerMessage);
    console.log('赢家:', (finished?.winners ?? []).map((w) => `${w.name} +${w.amount}${w.payout ? `(通吃${w.payout})` : ''}`).join(' / ') || '（无）');
    console.log('结算明细:', (finished?.results ?? []).map((r) => `${r.name}${r.isBanker ? '(庄)' : ''} ${r.handLabel ?? '未发牌'} ${r.delta >= 0 ? '+' : ''}${r.delta}`).join(' | '));
    const participants = (lastRoom?.players ?? []).filter((p) => p.inHand || finished?.results?.some((r) => r.token === p.token));
    const dealtCount = participants.filter((p) => p.holeCards.filter((c) => c !== '??').length === 5).length;
    console.log('已发牌人数:', dealtCount, '/', participants.length);
    const total = (lastRoom?.players ?? []).reduce((sum, p) => sum + p.stack, 0);
    const expected = STARTING_STACK * PLAYERS;
    console.log('筹码合计:', total, total === expected ? '（守恒 ✓）' : `（不守恒 ✗，期望 ${expected}）`);

    // ===== 有庄模式：庄家决定续庄 / 移交 =====
    if (BANKER_MODE === 'banker' && finished?.status === 'finished') {
      const control = lastRoom?.bankerControl;
      if (control?.canManage) {
        const target = (control.transferCandidates ?? [])[0];
        const botToken = (lastRoom.players ?? []).find((p) => p.isBot)?.token;
        if (botToken) {
          const keepRes = await emit('room:banker', { roomCode: code, token: 'smoke-host', action: 'keep' });
          console.log('续庄:', keepRes.ok ? '✓' : `✗ ${keepRes.error}`, '决定:', keepRes.room?.hand?.bankerDecision?.action);
          // 已决定过，重复调用应被拒
          const again = await emit('room:banker', { roomCode: code, token: 'smoke-host', action: 'transfer', targetToken: botToken });
          console.log('重复移交被拒:', !again.ok ? `✓（${again.error}）` : '✗ 未被拒绝');
        }
        if (target) {
          const transferRes = await emit('room:banker', { roomCode: code, token: 'smoke-host', action: 'transfer', targetToken: target.targetToken });
          console.log('移交:', transferRes.ok ? `✓ 移交给 ${transferRes.room?.hand?.bankerDecision?.targetName}` : `✗ ${transferRes.error}`);
          console.log('下局庄家:', transferRes.room?.banker?.name ?? '（未知）');
        }
      } else {
        console.log('本局庄家不是本人，跳过移交验证');
      }
    }

    socket.close();
  } catch (error) {
    console.error('冒烟失败:', error.message);
    socket.close();
    process.exitCode = 1;
  }
});

socket.on('connect_error', (error) => {
  console.error('连接失败:', error.message);
  process.exitCode = 1;
});
