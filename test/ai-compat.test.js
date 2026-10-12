import assert from 'node:assert/strict';
import test from 'node:test';
import {
  LEVEL_PROFILE,
  TEXAS_LEVELS,
  TEXAS_LEVEL_LABELS,
  botLevelLabel,
  botThinkTuning,
  getProfile,
  levelRank,
  normalizeBotLevel,
  thinkDelay,
} from '../src/bot-ai.js';
import { derivePersona, personaCacheSize } from '../src/ai/persona.js';
import { normalizeBotLevel as legacyNormalize } from '../src/legacy-bot-levels.js';

test('等级枚举为五档，且不含旧 id', () => {
  assert.equal(TEXAS_LEVELS.length, 5);
  assert.deepEqual(TEXAS_LEVELS, ['fish', 'regular', 'lag', 'tag', 'gto']);
  for (const legacyId of ['beginner', 'intermediate', 'advanced']) {
    assert.ok(!TEXAS_LEVELS.includes(legacyId), `UI 不应暴露旧 id ${legacyId}`);
  }
  for (const id of TEXAS_LEVELS) {
    assert.ok(TEXAS_LEVEL_LABELS[id], `${id} 缺少中文标签`);
  }
});

test('旧等级 id 自动映射到新档位（旧存档无需数据迁移）', () => {
  assert.equal(normalizeBotLevel('beginner'), 'fish');
  assert.equal(normalizeBotLevel('intermediate'), 'regular');
  assert.equal(normalizeBotLevel('advanced'), 'tag');
  assert.equal(normalizeBotLevel('初级'), 'fish');
  assert.equal(normalizeBotLevel('中级'), 'regular');
  assert.equal(normalizeBotLevel('高级'), 'tag');
  assert.equal(normalizeBotLevel('pro'), 'gto');
  assert.equal(normalizeBotLevel('  GTO  '), 'gto', '应容忍空格与大小写');
  assert.equal(normalizeBotLevel(undefined), 'fish', '未知输入兜底为最弱档');
  assert.equal(normalizeBotLevel('乱七八糟'), 'fish');
});

test('新旧 8 个 id 都能拿到非空中文标签', () => {
  const ids = [...TEXAS_LEVELS, 'beginner', 'intermediate', 'advanced'];
  for (const id of ids) {
    const label = botLevelLabel(id);
    assert.ok(label && label.length > 0, `${id} 的标签为空`);
    assert.ok(/[一-龥]/.test(label), `${id} 的标签应含中文，实际为 ${label}`);
  }
});

test('炸金花/干瞪眼的等级枚举与德州完全隔离', () => {
  // legacy 只认三档，收到新 id 一律兜底为 beginner —— 即使漏改 import 也不会崩
  assert.equal(legacyNormalize('gto'), 'beginner');
  assert.equal(legacyNormalize('fish'), 'beginner');
  assert.equal(legacyNormalize('advanced'), 'advanced');
  assert.equal(legacyNormalize('beginner'), 'beginner');
});

test('每档配置完整且强弱有序', () => {
  const requiredAbilities = [
    'position', 'rangeTable', 'potOdds', 'blockers',
    'mixedFreq', 'preciseRiver', 'pushFold', 'allowOverbet', 'rangeAdv',
  ];
  const requiredLeak = [
    'equityNoise', 'overcall', 'overfold', 'passivity',
    'noBluffMult', 'sizeBias', 'temperature', 'multiwayTight',
  ];
  const requiredLines = [
    'valueBetLine', 'valueRaiseLine', 'bluffRaiseLine',
    'semiBluffFreq', 'bluffFreq', 'raiseFreq', 'trapMax',
  ];

  let previousRank = -1;
  for (const id of TEXAS_LEVELS) {
    const profile = LEVEL_PROFILE[id];
    assert.ok(profile, `${id} 缺少配置`);
    assert.equal(profile.id, id);
    assert.ok(profile.think[0] < profile.think[1], `${id} 的思考区间无效`);
    assert.ok(profile.mcSamples > 0, `${id} 的样本量应大于 0`);
    assert.ok(profile.budgetMs > 0, `${id} 应有计算预算`);

    for (const key of requiredAbilities) {
      assert.equal(typeof profile.abilities[key], 'boolean', `${id}.abilities.${key} 缺失`);
    }
    for (const key of requiredLeak) {
      assert.equal(typeof profile.leak[key], 'number', `${id}.leak.${key} 缺失`);
    }
    for (const key of requiredLines) {
      assert.equal(typeof profile.lines[key], 'number', `${id}.lines.${key} 缺失`);
    }

    assert.equal(profile.rank, previousRank + 1, `${id} 的强弱序号应连续递增`);
    previousRank = profile.rank;
  }

  assert.equal(levelRank('fish'), 0);
  assert.equal(levelRank('gto'), 4);
  assert.ok(levelRank('gto') > levelRank('fish'));
});

test('能力开关随档位单调增强（不会越级倒退）', () => {
  const order = TEXAS_LEVELS.map((id) => LEVEL_PROFILE[id]);
  for (let i = 1; i < order.length; i += 1) {
    const prev = order[i - 1];
    const next = order[i];
    for (const key of Object.keys(prev.abilities)) {
      // 低档位开启的能力，高档位不能关掉
      if (prev.abilities[key]) {
        assert.ok(next.abilities[key], `${next.id} 不应关闭 ${key}（${prev.id} 已开启）`);
      }
    }
    // 权益噪声必须单调下降：越强的档位看得越准
    assert.ok(
      next.leak.equityNoise <= prev.leak.equityNoise,
      `${next.id} 的权益噪声不应高于 ${prev.id}`,
    );
  }
  assert.equal(LEVEL_PROFILE.gto.leak.equityNoise, 0, 'GTO大师不应有权益噪声');
});

test('getProfile 对任意输入都返回有效配置', () => {
  for (const input of ['gto', 'beginner', undefined, null, '', '未知', 42]) {
    const profile = getProfile(input);
    assert.ok(profile, `getProfile(${String(input)}) 返回空`);
    assert.ok(TEXAS_LEVELS.includes(profile.id));
  }
});

test('思考时长落在引擎允许的区间内', () => {
  const { minMs, maxMs } = botThinkTuning();
  for (const id of TEXAS_LEVELS) {
    for (const difficulty of [0, 0.25, 0.5, 0.75, 1]) {
      for (let i = 0; i < 20; i += 1) {
        const delay = thinkDelay(id, difficulty);
        assert.ok(delay >= minMs && delay <= maxMs, `${id} 在 ${difficulty} 下延迟越界: ${delay}`);
      }
    }
  }
});

test('思考时长对难度单调（越难的决策想得越久）', () => {
  for (const id of TEXAS_LEVELS) {
    let previous = 0;
    for (const difficulty of [0, 0.5, 1]) {
      // 取多次的中位数以消除抖动
      const samples = Array.from({ length: 200 }, () => thinkDelay(id, difficulty)).sort((a, b) => a - b);
      const median = samples[100];
      assert.ok(median > previous, `${id} 的思考时长应随难度递增`);
      previous = median;
    }
  }
});

test('人格系统稳定、有区分度、且字段满足策略需要', () => {
  const a1 = derivePersona('compat-token-a');
  const a2 = derivePersona('compat-token-a');
  assert.deepEqual(a1, a2, '同一 token 的人格必须稳定');

  const required = [
    'aggression', 'bluff', 'tightness', 'trap', 'cbet',
    'thinkScale', 'callStation', 'sizeBias', 'showdownCurious',
  ];
  for (const key of required) {
    assert.equal(typeof a1[key], 'number', `人格字段 ${key} 缺失`);
    assert.ok(Number.isFinite(a1[key]), `${key} 应为有限数`);
  }

  const distinct = new Set();
  for (let i = 0; i < 12; i += 1) {
    distinct.add(JSON.stringify(derivePersona(`compat-token-${i}`)));
  }
  assert.ok(distinct.size > 6, `人格区分度不足: ${distinct.size}`);

  // 人格取值应在合理范围内
  for (let i = 0; i < 50; i += 1) {
    const persona = derivePersona(`range-check-${i}`);
    assert.ok(persona.aggression >= 0.85 && persona.aggression <= 1.15);
    assert.ok(persona.bluff >= 0.6 && persona.bluff <= 1.4);
    assert.ok(persona.tightness >= -0.03 && persona.tightness <= 0.03);
    assert.ok(persona.trap >= 0 && persona.trap <= 0.35);
    assert.ok(persona.thinkScale >= 0.85 && persona.thinkScale <= 1.25);
    assert.ok(persona.callStation >= 0 && persona.callStation <= 0.3);
  }
});

test('人格缓存有上界，长期运行不会无限增长', () => {
  for (let i = 0; i < 1500; i += 1) {
    derivePersona(`cache-pressure-${i}`);
  }
  assert.ok(personaCacheSize() <= 1000, `人格缓存超过上界: ${personaCacheSize()}`);
});
