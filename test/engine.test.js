'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { analyze, buildRangeHistory } = require('../src/verifier/engine');
const scenarios = require('../src/scenarios');

const base = (submissions, extra = {}) => ({
  queues: ['Q0', 'Q1', 'Q2'],
  buffers: [{ name: 'f', length: 16 }],
  submissions,
  ...extra
});

test('缺少获取的跨队列读取 -> MISSING_ACQUIRE（422 类拒绝）', () => {
  const r = analyze(scenarios.missingAcquire.input);
  assert.equal(r.ok, false);
  assert.equal(r.code, 'MISSING_ACQUIRE');
  assert.equal(r.submissionId, 'E1');
  assert.equal(r.buffer, 'frameA');
  assert.equal(r.currentOwner, 'decode-q');
});

test('完整移交（释放+信号量+获取）后读取 -> 通过，呈现版本与移交证据', () => {
  const r = analyze(scenarios.completeTransfer.input);
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.deepEqual(r.executableOrder.map((x) => x.id), ['D1', 'E1']);

  const e1 = r.affectedRanges.E1;
  const read = e1.reads[0];
  assert.equal(read.buffer, 'frameA');
  assert.deepEqual([read.start, read.end], [0, 8]);
  assert.equal(read.version, 1);
  assert.ok(read.evidence, '跨队列取得的读必须携带移交证据');
  assert.equal(read.evidence.fromQueue, 'decode-q');
  assert.equal(read.evidence.toQueue, 'encode-q');
  assert.equal(read.evidence.releaseBy, 'D1');
  assert.equal(read.evidence.acquireBy, 'E1');
  assert.equal(read.evidence.via.kind, 'semaphore');

  assert.equal(r.transfers.length, 1);
  assert.deepEqual([r.transfers[0].start, r.transfers[0].end], [0, 8]);
});

test('同队列顺序读：后者可见前者的写，无需移交', () => {
  const r = analyze(base([
    { id: 'A', queue: 'Q0', operations: [{ type: 'write', buffer: 'f', offset: 0, length: 4 }] },
    { id: 'B', queue: 'Q0', operations: [{ type: 'read', buffer: 'f', offset: 0, length: 4 }] }
  ]));
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.deepEqual(r.executableOrder.map((x) => x.id), ['A', 'B']);
  assert.equal(r.affectedRanges.B.reads[0].version, 1);
});

test('等待无满足来源 -> UNSATISFIED_WAIT', () => {
  const r = analyze(base([
    { id: 'A', queue: 'Q1', wait: { semaphore: 't', value: 2 }, operations: [{ type: 'read', buffer: 'f', offset: 0, length: 1 }] }
  ]));
  assert.equal(r.ok, false);
  assert.equal(r.code, 'UNSATISFIED_WAIT');
  assert.equal(r.available, 0);
});

test('信号量等待成环 -> DEADLOCK_CYCLE，环中提交与区间被定位', () => {
  const r = analyze(scenarios.deadlock.input);
  assert.equal(r.ok, false);
  assert.equal(r.code, 'DEADLOCK_CYCLE');
  assert.deepEqual(new Set(r.cycle), new Set(['D1', 'D2']));
  assert.ok(r.touchedRanges.D1.some((x) => x.buffer === 'frameA'));
});

test('跨队列无释放的读取 -> MISSING_RELEASE', () => {
  const r = analyze(base([
    { id: 'A', queue: 'Q0', signal: { semaphore: 't' }, operations: [{ type: 'write', buffer: 'f', offset: 0, length: 2 }] },
    { id: 'B', queue: 'Q1', wait: { semaphore: 't', value: 1 }, operations: [{ type: 'read', buffer: 'f', offset: 0, length: 2 }] }
  ]));
  assert.equal(r.ok, false);
  assert.equal(r.code, 'MISSING_RELEASE');
  assert.equal(r.submissionId, 'B');
});

test('非属主写入 -> WRONG_OWNER', () => {
  const r = analyze(base([
    { id: 'A', queue: 'Q0', signal: { semaphore: 't' }, operations: [{ type: 'write', buffer: 'f', offset: 0, length: 2 }] },
    { id: 'B', queue: 'Q1', wait: { semaphore: 't', value: 1 }, operations: [{ type: 'write', buffer: 'f', offset: 0, length: 2 }] }
  ]));
  assert.equal(r.ok, false);
  assert.equal(r.code, 'WRONG_OWNER');
  assert.equal(r.currentOwner, 'Q0');
});

test('过期版本获取：释放后属主又写新版本 -> STALE_VERSION', () => {
  const r = analyze(base([
    {
      id: 'A', queue: 'Q0', signal: { semaphore: 't' },
      operations: [
        { type: 'write', buffer: 'f', offset: 0, length: 2 },
        { type: 'release', buffer: 'f', offset: 0, length: 2 },
        { type: 'write', buffer: 'f', offset: 0, length: 2 }
      ]
    },
    { id: 'B', queue: 'Q1', wait: { semaphore: 't', value: 1 }, operations: [{ type: 'acquire', buffer: 'f', offset: 0, length: 2 }] }
  ]));
  assert.equal(r.ok, false);
  assert.equal(r.code, 'STALE_VERSION');
  assert.equal(r.observedVersion, 1);
  assert.equal(r.expectedVersion, 2);
});

test('信号量传递先后（Q0→Q1→Q2）支撑跨队列完整移交链', () => {
  const r = analyze(base([
    {
      id: 'A', queue: 'Q0', signal: { semaphore: 'a' },
      operations: [{ type: 'write', buffer: 'f', offset: 0, length: 2 }, { type: 'release', buffer: 'f', offset: 0, length: 2 }]
    },
    {
      id: 'B', queue: 'Q1', wait: { semaphore: 'a', value: 1 }, signal: { semaphore: 'b' },
      operations: [
        { type: 'acquire', buffer: 'f', offset: 0, length: 2 },
        { type: 'read', buffer: 'f', offset: 0, length: 2 },
        { type: 'release', buffer: 'f', offset: 0, length: 2 }
      ]
    },
    {
      id: 'C', queue: 'Q2', wait: { semaphore: 'b', value: 1 },
      operations: [{ type: 'acquire', buffer: 'f', offset: 0, length: 2 }, { type: 'read', buffer: 'f', offset: 0, length: 2 }]
    }
  ]));
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.deepEqual(r.executableOrder.map((x) => x.id), ['A', 'B', 'C']);
  assert.equal(r.affectedRanges.C.reads[0].version, 1);
});

test('等待的信号量与释放提交无先后关系 -> ORDERING_MISSING（首个无序读写）', () => {
  const r = analyze(base([
    // S1 发出被等待的信号，但只操作无关单元
    { id: 'S1', queue: 'Q0', signal: { semaphore: 't' }, operations: [{ type: 'write', buffer: 'f', offset: 10, length: 1 }] },
    // S2 之后才写并释放，未与 S1 建立信号关系
    {
      id: 'S2', queue: 'Q0',
      operations: [{ type: 'write', buffer: 'f', offset: 0, length: 2 }, { type: 'release', buffer: 'f', offset: 0, length: 2 }]
    },
    // S3 等到的是 S1 的信号，释放方 S2 并不先于 S3 -> 无序
    { id: 'S3', queue: 'Q1', wait: { semaphore: 't', value: 1 }, operations: [{ type: 'read', buffer: 'f', offset: 0, length: 2 }] }
  ]));
  assert.equal(r.ok, false);
  assert.equal(r.code, 'ORDERING_MISSING');
  assert.equal(r.submissionId, 'S3');
  assert.equal(r.releaseBy, 'S2');
});

test('读取从未写入的单元 -> NO_OWNER', () => {
  const r = analyze(base([
    { id: 'A', queue: 'Q0', operations: [{ type: 'read', buffer: 'f', offset: 3, length: 1 }] }
  ]));
  assert.equal(r.ok, false);
  assert.equal(r.code, 'NO_OWNER');
});

test('结构校验：超上限与越界区间被拒绝', () => {
  const tooManyQueues = {
    queues: ['a', 'b', 'c', 'd'],
    buffers: [{ name: 'f', length: 4 }],
    submissions: []
  };
  assert.equal(analyze(tooManyQueues).code, 'STRUCTURE_INVALID');

  const overrun = base([
    { id: 'A', queue: 'Q0', operations: [{ type: 'write', buffer: 'f', offset: 14, length: 4 }] }
  ]);
  assert.equal(analyze(overrun).code, 'STRUCTURE_INVALID');
});

// ---- 区间访问证据沿革 ----

test('部分重写：通过复核后整段沿革切分为不重叠连续片段，未写入单元保持初始状态', () => {
  const r = analyze(scenarios.partialRewrite.input);
  assert.equal(r.ok, true, JSON.stringify(r));

  const h = buildRangeHistory(r, { buffer: 'frameB', start: 0, end: 8 });
  assert.equal(h.ok, true, JSON.stringify(h));
  assert.deepEqual(h.segments.map((s) => [s.start, s.end]), [[0, 4], [4, 6], [6, 8]]);

  // 片段必须互不重叠且恰好覆盖所选区间
  let covered = 0;
  h.segments.forEach((s, i) => {
    if (i > 0) assert.equal(s.start, h.segments[i - 1].end, '片段必须首尾相接、不重叠');
    covered += s.end - s.start;
  });
  assert.equal(covered, 8);

  const [stay, rewritten, untouched] = h.segments;
  assert.equal(stay.finalVersion, 1);
  assert.equal(stay.finalOwner, 'encode-q');
  assert.equal(stay.initial, undefined);
  assert.deepEqual(stay.events.map((e) => e.kind), ['write', 'release', 'acquire', 'read']);
  // 移交证据：releaseBy/acquireBy/信号量来源完整
  const acquireEv = stay.events.find((e) => e.kind === 'acquire');
  assert.equal(acquireEv.evidence.releaseBy, 'D1');
  assert.equal(acquireEv.evidence.acquireBy, 'E1');
  assert.equal(acquireEv.evidence.via.kind, 'semaphore');
  assert.equal(acquireEv.evidence.via.semaphore, 'timeline/decode');
  // release 事件携带 releaseBy
  assert.equal(stay.events.find((e) => e.kind === 'release').releaseBy, 'D1');

  // 只有部分单元被后来写入：[4,6) 为 v2，不能用邻段 v1 证据覆盖
  assert.equal(rewritten.finalVersion, 2);
  assert.deepEqual(rewritten.events.map((e) => e.kind), ['write', 'release', 'acquire', 'read', 'write']);
  assert.equal(rewritten.events[4].submissionId, 'E1');

  // 未写入单元明确保持初始状态
  assert.equal(untouched.initial, true);
  assert.equal(untouched.written, false);
  assert.equal(untouched.finalOwner, null);
  assert.equal(untouched.finalVersion, 0);
  assert.deepEqual(untouched.events, []);
});

test('沿革：证据完全相同的连续单元合并为一段', () => {
  const r = analyze(scenarios.completeTransfer.input);
  assert.equal(r.ok, true);
  const h = buildRangeHistory(r, { buffer: 'frameA', start: 0, end: 12 });
  // [0,8) 证据完全一致合并；[8,12) 仅被 E1 写过 v1，另成一段
  assert.deepEqual(h.segments.map((s) => [s.start, s.end]), [[0, 8], [8, 12]]);
  const first = h.segments[0];
  assert.deepEqual(first.events.map((e) => e.kind), ['write', 'release', 'acquire', 'read']);
  // 事件按可执行序排列
  assert.deepEqual(first.events.map((e) => e.order), [0, 0, 1, 1]);
  const second = h.segments[1];
  assert.deepEqual(second.events.map((e) => e.kind), ['write']);
  assert.equal(second.finalOwner, 'encode-q');
});

test('沿革：事件按可执行次序记录写入/释放/获取/读取', () => {
  const r = analyze(base([
    { id: 'A', queue: 'Q0', signal: { semaphore: 't' }, operations: [{ type: 'write', buffer: 'f', offset: 0, length: 1 }] },
    { id: 'B', queue: 'Q0', operations: [
      { type: 'release', buffer: 'f', offset: 0, length: 1 },
      { type: 'write', buffer: 'f', offset: 1, length: 1 }
    ] }
  ]));
  assert.equal(r.ok, true, JSON.stringify(r));
  const h = buildRangeHistory(r, { buffer: 'f', start: 0, end: 2 });
  assert.deepEqual(h.segments.map((s) => [s.start, s.end]), [[0, 1], [1, 2]]);
  assert.deepEqual(h.segments[0].events.map((e) => `${e.kind}@${e.submissionId}`), ['write@A', 'release@B']);
  assert.deepEqual(h.segments[1].events.map((e) => `${e.kind}@${e.submissionId}`), ['write@B']);
});

test('沿革：非法区间与未知缓冲区给出可操作错误码', () => {
  const r = analyze(scenarios.partialRewrite.input);
  assert.equal(buildRangeHistory(r, { buffer: 'frameB', start: -1, end: 4 }).code, 'INVALID_RANGE');
  assert.equal(buildRangeHistory(r, { buffer: 'frameB', start: 0, end: 9 }).code, 'INVALID_RANGE');
  assert.equal(buildRangeHistory(r, { buffer: 'frameB', start: 4, end: 4 }).code, 'INVALID_RANGE');
  assert.equal(buildRangeHistory(r, { buffer: 'nope', start: 0, end: 1 }).code, 'UNKNOWN_BUFFER');
});

test('沿革：尚无成功复核结论时拒绝并提示，不展示任何旧证据', () => {
  const rejected = analyze(scenarios.missingAcquire.input);
  const h = buildRangeHistory(rejected, { buffer: 'frameA', start: 0, end: 8 });
  assert.equal(h.ok, false);
  assert.equal(h.code, 'NO_SUCCESSFUL_REVIEW');
  assert.equal(h.segments, undefined);
});

test('沿革：默认区间为整个声明的缓冲区', () => {
  const r = analyze(scenarios.completeTransfer.input);
  const h = buildRangeHistory(r, { buffer: 'frameA' });
  assert.equal(h.ok, true);
  assert.deepEqual([h.start, h.end], [0, 16]);
});
