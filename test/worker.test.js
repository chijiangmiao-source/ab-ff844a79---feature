'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const scenarios = require('../src/scenarios');
const { accessHistory } = require('../src/verifier/engine');

// 在模拟的 Web Worker 全局（self / importScripts）中加载复核引擎
function loadWorker() {
  const dir = path.join(__dirname, '..', 'src', 'verifier');
  const sandbox = {};
  sandbox.self = sandbox;
  sandbox.importScripts = (...names) => {
    for (const name of names) {
      const code = fs.readFileSync(path.join(dir, name), 'utf8');
      vm.runInNewContext(code, sandbox, { filename: name });
    }
  };
  vm.createContext(sandbox);
  vm.runInNewContext(
    fs.readFileSync(path.join(dir, 'worker.js'), 'utf8'),
    sandbox,
    { filename: 'worker.js' }
  );
  const messages = [];
  sandbox.self.postMessage = (m) => messages.push(m);
  return { sandbox, messages };
}

// 验证 worker.js 的消息协议：postMessage({input}) -> onmessage -> postMessage(result)
test('Worker 入口在 Worker 全局中完成偏序复核并回传结果', () => {
  const { sandbox, messages } = loadWorker();

  assert.equal(typeof sandbox.self.analyze, 'function');
  assert.equal(typeof sandbox.self.accessHistory, 'function');
  assert.equal(typeof sandbox.self.onmessage, 'function');

  sandbox.self.onmessage({ data: { input: scenarios.missingAcquire.input } });
  assert.equal(messages.length, 1);
  assert.equal(messages[0].ok, false);
  assert.equal(messages[0].code, 'MISSING_ACQUIRE');

  sandbox.self.onmessage({ data: { input: scenarios.completeTransfer.input } });
  assert.equal(messages.length, 2);
  assert.equal(messages[1].ok, true);
  // 结果来自独立 VM realm，用 JSON 做结构化比较
  assert.deepEqual(JSON.parse(JSON.stringify(messages[1].executableOrder.map((x) => x.id))), ['D1', 'E1']);
  assert.equal(messages[1].affectedRanges.E1.reads[0].evidence.acquireBy, 'E1');
});

// Worker 沿革查询（{input, query} 消息）必须与 Node/HTTP 同构实现给出相同沿革
test('Worker 沿革查询与 HTTP 同构实现结果一致', () => {
  const { sandbox, messages } = loadWorker();
  const query = { buffer: 'frameA', start: 0, end: 16 };

  sandbox.self.onmessage({ data: { input: scenarios.partialRewrite.input, query } });
  assert.equal(messages.length, 1);
  const viaWorker = messages[0];
  assert.equal(viaWorker.ok, true, JSON.stringify(viaWorker));

  const viaNode = accessHistory(scenarios.partialRewrite.input, query);
  // 独立 VM realm 的结果经 JSON 结构化比较：分段、事件、证据逐项一致
  assert.deepEqual(JSON.parse(JSON.stringify(viaWorker)), JSON.parse(JSON.stringify(viaNode)));
  assert.equal(viaWorker.segments.length, 3);
  assert.deepEqual(JSON.parse(JSON.stringify(viaWorker.segments.map((s) => [s.start, s.end]))), [[0, 8], [8, 12], [12, 16]]);

  // 复核未通过：Worker 同样返回拒绝而非沿革
  sandbox.self.onmessage({ data: { input: scenarios.missingAcquire.input, query: { buffer: 'frameA', start: 0, end: 8 } } });
  assert.equal(messages.length, 2);
  assert.equal(messages[1].ok, false);
  assert.equal(messages[1].code, 'MISSING_ACQUIRE');
  assert.equal(messages[1].segments, undefined);

  // 非法区间：Worker 与 HTTP 同构实现返回相同的 RANGE_INVALID
  sandbox.self.onmessage({ data: { input: scenarios.partialRewrite.input, query: { buffer: 'frameA', start: 0, end: 99 } } });
  assert.equal(messages.length, 3);
  assert.equal(messages[2].ok, false);
  assert.equal(messages[2].code, 'RANGE_INVALID');
});
