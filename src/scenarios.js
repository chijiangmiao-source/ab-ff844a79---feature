'use strict';

// 标准复核场景，供操作页与 HTTP 冒烟共用
const scenarios = {
  // 场景一：跨队列读取缺少获取 —— 必须被拒绝（MISSING_ACQUIRE）
  missingAcquire: {
    title: '缺少获取的跨队列读取（应拒绝）',
    input: {
      queues: ['decode-q', 'encode-q'],
      buffers: [{ name: 'frameA', length: 16 }],
      submissions: [
        {
          id: 'D1',
          queue: 'decode-q',
          signal: { semaphore: 'timeline/decode' },
          operations: [
            { type: 'write', buffer: 'frameA', offset: 0, length: 8 },
            { type: 'release', buffer: 'frameA', offset: 0, length: 8 }
          ]
        },
        {
          id: 'E1',
          queue: 'encode-q',
          wait: { semaphore: 'timeline/decode', value: 1 },
          operations: [
            // 只有信号量等待，没有 acquire 就读
            { type: 'read', buffer: 'frameA', offset: 0, length: 8 }
          ]
        }
      ]
    }
  },

  // 场景二：释放 -> 信号量 -> 获取 证据完整后读取 —— 应通过并呈现版本与移交证据
  completeTransfer: {
    title: '完整移交后读取（应通过）',
    input: {
      queues: ['decode-q', 'encode-q'],
      buffers: [{ name: 'frameA', length: 16 }],
      submissions: [
        {
          id: 'D1',
          queue: 'decode-q',
          signal: { semaphore: 'timeline/decode' },
          operations: [
            { type: 'write', buffer: 'frameA', offset: 0, length: 8 },
            { type: 'release', buffer: 'frameA', offset: 0, length: 8 }
          ]
        },
        {
          id: 'E1',
          queue: 'encode-q',
          wait: { semaphore: 'timeline/decode', value: 1 },
          operations: [
            { type: 'acquire', buffer: 'frameA', offset: 0, length: 8 },
            { type: 'read', buffer: 'frameA', offset: 0, length: 8 },
            { type: 'write', buffer: 'frameA', offset: 8, length: 4 }
          ]
        }
      ]
    }
  },

  // 场景三：部分重写后的分段沿革 —— 应通过；查询 frameA[0..16) 时沿革切分为
  // [0..8) 完整移交 v1 / [8..12) 被 E1 重写为 v2 / [12..16) 保持初始状态 三段
  partialRewrite: {
    title: '部分重写后的分段沿革（应通过）',
    input: {
      queues: ['decode-q', 'encode-q'],
      buffers: [{ name: 'frameA', length: 16 }],
      submissions: [
        {
          id: 'D1',
          queue: 'decode-q',
          signal: { semaphore: 'timeline/decode' },
          operations: [
            { type: 'write', buffer: 'frameA', offset: 0, length: 12 },
            { type: 'release', buffer: 'frameA', offset: 0, length: 12 }
          ]
        },
        {
          id: 'E1',
          queue: 'encode-q',
          wait: { semaphore: 'timeline/decode', value: 1 },
          operations: [
            { type: 'acquire', buffer: 'frameA', offset: 0, length: 12 },
            { type: 'read', buffer: 'frameA', offset: 0, length: 12 },
            // 只重写 [8..12) 四个单元：部分单元被后来写入，沿革必须分段
            { type: 'write', buffer: 'frameA', offset: 8, length: 4 }
          ]
        }
      ]
    },
    // 推荐的沿革查询区间（半开 [start, end)）
    query: { buffer: 'frameA', start: 0, end: 16 }
  },

  // 场景四：同队列互相等待对方的时间线 —— 死锁环
  deadlock: {    title: '信号量等待成环（死锁，应拒绝）',
    input: {
      queues: ['decode-q'],
      buffers: [{ name: 'frameA', length: 4 }],
      submissions: [
        {
          id: 'D1',
          queue: 'decode-q',
          wait: { semaphore: 'timeline/a', value: 1 },
          signal: { semaphore: 'timeline/b' },
          operations: [{ type: 'write', buffer: 'frameA', offset: 0, length: 2 }]
        },
        {
          id: 'D2',
          queue: 'decode-q',
          wait: { semaphore: 'timeline/b', value: 1 },
          signal: { semaphore: 'timeline/a' },
          operations: [{ type: 'write', buffer: 'frameA', offset: 2, length: 2 }]
        }
      ]
    }
  }
};

module.exports = scenarios;
