import test from "node:test";
import assert from "node:assert/strict";
import { SerialController } from "../public/js/serial.js";

// 用可控 Promise 模拟打开或写入被浏览器暂挂的时刻，专门覆盖生命周期竞态。
function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

// 等待一个异步状态，不使用固定长 sleep，避免测试在不同机器上偶发超时。
async function waitFor(predicate, timeoutMs = 500) {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error("等待串口 mock 状态超时");
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
}

// 构造只实现本工具所需 Web Serial 方法的 mock 端口，不依赖真实 COM 设备。
function makeMockPort({ openGate = null, readError = null, dtrOffError = null, closeError = null, writeGate = null } = {}) {
  let pendingRead = null;
  let readErrorSent = false;
  let writerLocked = false;
  const port = {
    readable: null,
    writable: null,
    openCalls: 0,
    closeCalls: 0,
    releaseCalls: 0,
    signalCalls: [],
    writes: [],
    async open() {
      this.openCalls += 1;
      if (openGate) await openGate.promise;
      this.readable = {
        getReader: () => ({
          read: () => {
            if (readError && !readErrorSent) {
              readErrorSent = true;
              return Promise.reject(readError);
            }
            return new Promise((resolve) => {
              pendingRead = resolve;
            });
          },
          cancel: async () => {
            pendingRead?.({ value: undefined, done: true });
            pendingRead = null;
          },
          releaseLock: () => {
            this.releaseCalls += 1;
          },
        }),
      };
      this.writable = {
        getWriter: () => {
          if (writerLocked) throw new Error("writer lock 被重复获取");
          writerLocked = true;
          return {
            write: async (bytes) => {
              this.writes.push([...bytes]);
              if (writeGate) await writeGate.promise;
            },
            releaseLock: () => {
              writerLocked = false;
            },
          };
        },
      };
    },
    async setSignals({ dataTerminalReady }) {
      this.signalCalls.push(dataTerminalReady);
      if (!dataTerminalReady && dtrOffError) throw dtrOffError;
    },
    async close() {
      this.closeCalls += 1;
      if (closeError) throw closeError;
      this.readable = null;
      this.writable = null;
    },
    getInfo: () => ({ usbVendorId: 0x1234, usbProductId: 0x5678 }),
  };
  return port;
}

// 直接注入已授权端口，等价于用户已经点击“选择串口”并完成权限授权。
function makeController(port, callbacks = {}) {
  const statuses = [];
  const errors = [];
  const controller = new SerialController({
    onBytes: callbacks.onBytes,
    onStatus: (status) => statuses.push(status),
    onError: (error) => errors.push(error),
    onDisconnect: callbacks.onDisconnect,
  });
  controller.port = port;
  controller.phase = "selected";
  return { controller, statuses, errors };
}

// 启动持续读取会话，同时返回“已连接”哨兵和连接 Promise 供测试分别控制时序。
function startReading(controller, options = {}) {
  const connection = controller.connect(options);
  const ready = waitFor(() => controller.isConnected);
  return { connection, ready };
}

test("断开会等待 reader 释放，并在 DTR 关闭后关闭端口", async () => {
  const port = makeMockPort();
  const { controller } = makeController(port);
  const { connection, ready } = startReading(controller, { dataTerminalReady: true });
  await ready;
  const disconnectResult = await controller.disconnect();

  assert.equal(disconnectResult.closed, true);
  assert.deepEqual(port.signalCalls, [true, false]);
  assert.equal(port.releaseCalls, 1);
  assert.equal(port.closeCalls, 1);
  await connection;
  assert.equal(controller.isBusy, false);
});

test("DTR 撤销失败仍然会继续 close，并把错误交给页面", async () => {
  const dtrError = new Error("DTR off failed");
  const port = makeMockPort({ dtrOffError: dtrError });
  const { controller, errors } = makeController(port);
  const { connection, ready } = startReading(controller, { dataTerminalReady: true });
  await ready;
  const result = await controller.disconnect();

  assert.equal(result.closed, true);
  assert.equal(port.closeCalls, 1);
  assert.ok(errors.includes(dtrError));
  await connection;
});

test("连接尚未完成时重复 connect 只打开一次，断开会等待 open 完成", async () => {
  const openGate = deferred();
  const port = makeMockPort({ openGate });
  const { controller } = makeController(port);
  const first = controller.connect();
  await waitFor(() => controller.phase === "opening");
  const second = controller.connect();
  assert.equal(port.openCalls, 1);

  const disconnect = controller.disconnect();
  openGate.resolve();
  await disconnect;
  await Promise.all([first, second]);
  assert.equal(port.closeCalls, 1);
  assert.equal(controller.isBusy, false);
});

test("读取异常会先清理端口，再报告 error 状态", async () => {
  const readError = new Error("read failed");
  const port = makeMockPort({ readError });
  const { controller, statuses, errors } = makeController(port);
  await assert.rejects(controller.connect(), /read failed/);

  assert.equal(port.closeCalls, 1);
  assert.ok(errors.includes(readError));
  assert.equal(statuses.at(-1).state, "error");
  assert.equal(controller.isBusy, false);
});

test("开始/停止命令串行化，断开不会被 writer 锁阻塞或被晚到状态覆盖", async () => {
  const writeGate = deferred();
  const port = makeMockPort({ writeGate });
  const { controller, statuses } = makeController(port);
  const { connection, ready } = startReading(controller);
  await ready;
  const start = controller.requestScan();
  await waitFor(() => port.writes.length === 1);
  const stop = controller.requestStop();
  const disconnect = controller.disconnect();

  assert.equal(port.closeCalls, 0);
  writeGate.resolve();
  const results = await Promise.allSettled([start, stop, disconnect, connection]);

  assert.equal(port.writes[0][0], 0xa5);
  assert.equal(port.writes[0][1], 0x60);
  assert.equal(port.closeCalls, 1);
  assert.equal(statuses.at(-1).state, "disconnected");
  assert.equal(results.filter((result) => result.status === "rejected").length, 1);
});

test("拔线清理具有幂等性，只通知一次断开", async () => {
  const port = makeMockPort();
  let disconnectNotifications = 0;
  const { controller } = makeController(port, { onDisconnect: () => { disconnectNotifications += 1; } });
  const { connection, ready } = startReading(controller);
  await ready;
  const first = controller.handleUnexpectedDisconnect();
  const second = controller.handleUnexpectedDisconnect();
  await Promise.all([first, second, connection]);

  assert.equal(disconnectNotifications, 1);
  assert.equal(port.closeCalls, 1);
  assert.equal(controller.isBusy, false);
});

test("close 失败时不宣称断开，下一次断开可以重试", async () => {
  const port = makeMockPort();
  let failClose = true;
  const originalClose = port.close.bind(port);
  port.close = async () => {
    if (failClose) {
      port.closeCalls += 1;
      throw new Error("close failed");
    }
    return originalClose();
  };
  const { controller, statuses } = makeController(port);
  const { connection, ready } = startReading(controller);
  await ready;

  const first = await controller.disconnect();
  assert.equal(first.closed, false);
  assert.equal(controller.isBusy, true);
  assert.equal(statuses.at(-1).state, "error");

  failClose = false;
  const second = await controller.disconnect();
  assert.equal(second.closed, true);
  await connection;
  assert.equal(controller.isBusy, false);
  assert.equal(statuses.at(-1).state, "disconnected");
});
