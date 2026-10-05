'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { accessHistory } = require('../src/verifier/engine');
const scenarios = require('../src/scenarios');

test('部分重写后：沿革按可执行次序切分为不重叠连续片段，未写入单元保持初始状态', () => {
  const r = accessHistory(scenarios.partialRewrite.input, { buffer: 'frameA', start: 0, end: 16 });
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.deepEqual(r.query, { buffer: 'frameA', start: 0, end: 16 });
  assert.deepEqual(r.initial, { owner: null, version: 0 });
  assert.deepEqual(r.executableOrder.map((x) => x.id), ['D1', 'E1']);

  // 不重叠且连续覆盖整个查询区间
  assert.equal(r.segments.length, 3);
  assert.deepEqual(r.segments.map((s) => [s.start, s.end]), [[0, 8], [8, 12], [12, 16]]);

  // 段 [0..8)：完整移交链，最终 v1，属主 encode-q
  const s1 = r.segments[0];
  assert.deepEqual(s1.final, { owner: 'encode-q', version: 1 });
  assert.deepEqual(s1.events.map((e) => e.access), ['write', 'release', 'acquire', 'read']);
  assert.deepEqual(s1.events.map((e) => e.submissionId), ['D1', 'D1', 'E1', 'E1']);
  assert.ok(s1.events.every((e) => e.version === 1));
  // 当时所有者随事件推进：decode-q 写入/释放 -> encode-q 获取/读取
  assert.deepEqual(s1.events.map((e) => e.owner), ['decode-q', 'decode-q', 'encode-q', 'encode-q']);
  // 可执行次序单调递增
  assert.ok(s1.events.every((e, i) => i === 0 || e.seq > s1.events[i - 1].seq));
  // 获取与读取携带跨队列移交证据：releaseBy / acquireBy / 信号量来源
  const acq = s1.events[2];
  assert.equal(acq.evidence.fromQueue, 'decode-q');
  assert.equal(acq.evidence.toQueue, 'encode-q');
  assert.equal(acq.evidence.releaseBy, 'D1');
  assert.equal(acq.evidence.acquireBy, 'E1');
  assert.equal(acq.evidence.via.kind, 'semaphore');
  assert.equal(acq.evidence.via.semaphore, 'timeline/decode');
  assert.equal(s1.events[3].evidence.releaseBy, 'D1');

  // 段 [8..12)：同样的移交链之后被 E1 部分重写为 v2
  const s2 = r.segments[1];
  assert.deepEqual(s2.final, { owner: 'encode-q', version: 2 });
  assert.deepEqual(s2.events.map((e) => e.access), ['write', 'release', 'acquire', 'read', 'write']);
  const rewrite = s2.events[4];
  assert.equal(rewrite.submissionId, 'E1');
  assert.equal(rewrite.version, 2);
  assert.equal(rewrite.owner, 'encode-q');

  // 段 [12..16)：从未写入，明确保持初始状态
  const s3 = r.segments[2];
  assert.deepEqual(s3.final, { owner: null, version: 0 });
  assert.deepEqual(s3.events, []);
});

test('部分移交：只有被获取的单元带移交证据，邻近单元不被覆盖', () => {
  const input = {
    queues: ['Q0', 'Q1'],
    buffers: [{ name: 'f', length: 8 }],
    submissions: [
      {
        id: 'A', queue: 'Q0', signal: { semaphore: 't' },
        operations: [
          { type: 'write', buffer: 'f', offset: 0, length: 8 },
          { type: 'release', buffer: 'f', offset: 0, length: 4 } // 只释放前 4 个单元
        ]
      },
      {
        id: 'B', queue: 'Q1', wait: { semaphore: 't', value: 1 },
        operations: [
          { type: 'acquire', buffer: 'f', offset: 0, length: 4 },
          { type: 'read', buffer: 'f', offset: 0, length: 4 }
        ]
      }
    ]
  };
  const r = accessHistory(input, { buffer: 'f', start: 0, end: 8 });
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.deepEqual(r.segments.map((s) => [s.start, s.end]), [[0, 4], [4, 8]]);

  const [moved, stayed] = r.segments;
  assert.equal(moved.final.owner, 'Q1');
  assert.deepEqual(moved.events.map((e) => e.access), ['write', 'release', 'acquire', 'read']);
  const acq = moved.events.find((e) => e.access === 'acquire');
  assert.equal(acq.evidence.releaseBy, 'A');
  assert.equal(acq.evidence.acquireBy, 'B');
  assert.equal(acq.evidence.via.kind, 'semaphore');

  // 未移交的邻近单元：属主不变、无任何移交证据
  assert.equal(stayed.final.owner, 'Q0');
  assert.equal(stayed.final.version, 1);
  assert.deepEqual(stayed.events.map((e) => e.access), ['write']);
  assert.ok(stayed.events.every((e) => e.evidence === undefined));
});

test('查询子区间：分段被裁剪到查询范围，不越界', () => {
  const r = accessHistory(scenarios.partialRewrite.input, { buffer: 'frameA', start: 6, end: 10 });
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.deepEqual(r.segments.map((s) => [s.start, s.end]), [[6, 8], [8, 10]]);
  assert.deepEqual(r.segments[0].final, { owner: 'encode-q', version: 1 });
  assert.deepEqual(r.segments[1].final, { owner: 'encode-q', version: 2 });
});

test('完整移交场景的沿革与复核结果一致（版本与移交证据保持可复核）', () => {
  const r = accessHistory(scenarios.completeTransfer.input, { buffer: 'frameA', start: 0, end: 16 });
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.deepEqual(r.segments.map((s) => [s.start, s.end]), [[0, 8], [8, 12], [12, 16]]);
  const [transferred, written, untouched] = r.segments;
  assert.equal(transferred.final.version, 1);
  assert.equal(transferred.events.find((e) => e.access === 'acquire').evidence.releaseBy, 'D1');
  assert.equal(written.final.version, 1); // E1 直接写入（本队列），v1
  assert.equal(written.events.length, 1);
  assert.deepEqual(untouched.final, { owner: null, version: 0 });
});

test('非法区间 -> RANGE_INVALID，给出可操作提示且不返回分段', () => {
  const q = (query) => accessHistory(scenarios.partialRewrite.input, query);
  for (const bad of [
    { buffer: 'frameA', start: 0, end: 99 }, // 越界
    { buffer: 'frameA', start: 4, end: 4 }, // 空区间
    { buffer: 'frameA', start: 6, end: 2 }, // 倒置
    { buffer: 'frameA', start: -1, end: 4 }, // 负起点
    { buffer: 'frameA', start: 0, end: 4.5 }, // 非整数
    { buffer: 'nope', start: 0, end: 1 }, // 未声明缓冲区
    { start: 0, end: 1 }, // 缺少缓冲区
    null // 缺少 query
  ]) {
    const r = q(bad);
    assert.equal(r.ok, false, JSON.stringify(bad));
    assert.equal(r.code, 'RANGE_INVALID', JSON.stringify(bad));
    assert.equal(r.segments, undefined);
    assert.match(r.message, /沿革区间非法/);
  }
  const r = q({ buffer: 'frameA', start: 0, end: 99 });
  assert.match(r.message, /0 ≤ start < end ≤ 16/); // 可操作提示：给出合法范围
});

test('复核未通过 -> 沿革接口原样返回拒绝，不产出任何证据', () => {
  const r = accessHistory(scenarios.missingAcquire.input, { buffer: 'frameA', start: 0, end: 8 });
  assert.equal(r.ok, false);
  assert.equal(r.code, 'MISSING_ACQUIRE');
  assert.equal(r.submissionId, 'E1');
  assert.equal(r.segments, undefined);
});

test('结构非法 -> STRUCTURE_INVALID', () => {
  const r = accessHistory({ queues: [], buffers: [], submissions: [] }, { buffer: 'f', start: 0, end: 1 });
  assert.equal(r.ok, false);
  assert.equal(r.code, 'STRUCTURE_INVALID');
});
