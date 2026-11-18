// Web Serial 的固定参数与浏览器状态文本集中在一个模块，便于教学文档对照。
export const SERIAL_DEFAULTS = Object.freeze({
  baudRate: 115200,
  dataBits: 8,
  stopBits: 1,
  parity: "none",
  flowControl: "none",
});

// 使用 USB 厂商标识筛选常见转接板，避免把主板串口混入默认列表。
const USB_SERIAL_FILTERS = [
  { usbVendorId: 0x10c4 }, // Silicon Labs CP210x。
  { usbVendorId: 0x1a86 }, // WCH CH34x / CH91xx。
  { usbVendorId: 0x0403 }, // FTDI USB 转串口。
  { usbVendorId: 0x067b }, // Prolific PL2303。
];

// 封装串口生命周期，向上层只报告状态和原始字节，不混入协议解析逻辑。
export class SerialController {
  constructor({ onBytes, onStatus, onError, onDisconnect } = {}) {
    this.onBytes = onBytes ?? (() => {});
    this.onStatus = onStatus ?? (() => {});
    this.onError = onError ?? (() => {});
    this.onDisconnect = onDisconnect ?? (() => {});
    this.port = null;
    this.openedPort = null;
    this.reader = null;
    this.reading = false;
    this.stopRequested = false;
    this.dtrEnabled = false;
    this.phase = "idle";
    this.session = null;
    this.connectionTask = null;
    this.disconnectTask = null;
    this.sessionSequence = 0;
    this.disconnectHandler = (event) => {
      // 只有当前打开/正在打开的端口才需要响应拔线事件，避免旧端口事件覆盖新状态。
      if (event.port !== this.openedPort && event.port !== this.session?.port) return;
      void this.handleUnexpectedDisconnect().catch((error) => this.reportError(error));
    };
    if (typeof navigator !== "undefined" && "serial" in navigator) {
      navigator.serial.addEventListener("disconnect", this.disconnectHandler);
    }
  }

  // 检查 Web Serial 能力，错误文字直接面向使用者而不是暴露浏览器异常堆栈。
  static isSupported() {
    return typeof navigator !== "undefined" && "serial" in navigator;
  }

  // 让界面能够在打开或关闭阶段禁用会引发竞态的按钮。
  get isBusy() {
    return Boolean(this.session && !this.session.closed);
  }

  // 只把已经完成 open 且读取任务仍有效的会话视为已连接。
  get isConnected() {
    return this.phase === "open" && Boolean(this.session?.opened) && !this.session?.stopRequested;
  }

  // 端口已授权且没有活动会话时才允许再次连接。
  get canConnect() {
    return Boolean(this.port) && !this.isBusy && !this.disconnectTask;
  }

  // 统一把异常送到页面回调，避免异步拔线事件产生未处理 Promise 拒绝。
  reportError(error) {
    try {
      this.onError(error);
    } catch {
      // 页面回调异常不能反过来破坏串口清理流程。
    }
  }

  // 必须由按钮点击触发浏览器授权对话框，不能在页面加载时偷偷请求串口。
  async requestPort({ showOtherAdapters = false } = {}) {
    if (!SerialController.isSupported()) {
      throw new Error("当前浏览器不支持 Web Serial，请使用最新版 Edge。\n");
    }
    if (this.isBusy || this.disconnectTask) {
      throw new Error("串口正在连接或断开，请等待当前操作完成。");
    }
    // 兼容入口允许选择其他厂商的转接板，授权后仍核验 USB 标识。
    const selectedPort = await navigator.serial.requestPort(showOtherAdapters ? undefined : { filters: USB_SERIAL_FILTERS });
    // 用户在授权对话框期间可能触发了其他操作，此时不能覆盖活动会话的端口引用。
    if (this.isBusy || this.disconnectTask) {
      throw new Error("串口连接状态已改变，请先完成当前操作。");
    }
    // USB 转接板可以被分配为任意 COM 号，设备标识才是这里的判断依据。
    if (selectedPort.getInfo().usbVendorId == null) {
      throw new Error("所选串口没有可识别的 USB 设备标识。请重新选择雷达的 USB 转接板。");
    }
    this.port = selectedPort;
    this.phase = "selected";
    this.onStatus({ state: "port-selected", text: "已选择串口，等待连接" });
    return this.port;
  }

  // 返回浏览器提供的 USB 产品信息，缺失时显示为未知而不是阻断连接。
  getPortDescription() {
    if (!this.port) return "未选择串口";
    const info = this.port.getInfo?.() ?? {};
    const vendor = info.usbVendorId ? `VID ${info.usbVendorId.toString(16).toUpperCase()}` : "未知 VID";
    const product = info.usbProductId ? `PID ${info.usbProductId.toString(16).toUpperCase()}` : "未知 PID";
    return `${vendor} / ${product}`;
  }

  // 打开串口并启动异步读取循环；在第一个 await 前登记会话，防止双击和换端口竞态。
  async connect(options = {}) {
    if (!this.port) throw new Error("请先点击“选择串口”并授权一个 COM 口。");
    if (this.disconnectTask) await this.disconnectTask;
    if (this.isBusy) return this.connectionTask ?? Promise.resolve();

    const port = this.port;
    const settings = { ...SERIAL_DEFAULTS, ...options };
    const { dataTerminalReady, ...serialSettings } = settings;
    const session = {
      id: ++this.sessionSequence,
      port,
      opened: false,
      closed: false,
      stopRequested: false,
      teardownRequested: false,
      dtrRequested: Boolean(dataTerminalReady && typeof port.setSignals === "function"),
      openPromise: null,
      signalPromise: null,
      reader: null,
      readLoopPromise: null,
      commandTail: Promise.resolve(),
      teardownPromise: null,
    };
    this.session = session;
    this.stopRequested = false;
    this.dtrEnabled = session.dtrRequested;
    this.reading = true;
    this.phase = "opening";
    this.onStatus({ state: "connecting", text: "正在打开串口" });

    const task = this.runSession(session, serialSettings);
    this.connectionTask = task;
    // 只清理属于当前会话的任务引用；拒绝由 connect 调用方负责消费。
    void task.then(
      () => this.clearConnectionTask(session, task),
      () => this.clearConnectionTask(session, task),
    );
    return task;
  }

  // 会话结束后清除任务引用，避免旧会话阻止下一次连接。
  clearConnectionTask(session, task) {
    if (this.connectionTask === task && session.closed) {
      this.connectionTask = null;
    }
  }

  // 判断会话是否仍可接收数据或发布“已连接”状态。
  isSessionActive(session) {
    return this.session === session
      && !session.closed
      && !session.stopRequested
      && !session.teardownRequested
      && !this.stopRequested;
  }

  // 运行单个串口会话；任何异常都先走统一清理，再把错误交给页面。
  async runSession(session, serialSettings) {
    let failure = null;
    try {
      session.openPromise = session.port.open(serialSettings);
      await session.openPromise;
      session.opened = true;
      if (!this.isSessionActive(session)) return;

      // 某些转接板依赖 DTR 控制电机；默认关闭，只有用户明确勾选才请求。
      if (session.dtrRequested) {
        session.signalPromise = session.port.setSignals({ dataTerminalReady: true });
        try {
          await session.signalPromise;
        } finally {
          session.signalPromise = null;
        }
        if (!this.isSessionActive(session)) return;
      }

      this.openedPort = session.port;
      this.phase = "open";
      this.onStatus({ state: "connected-waiting", text: "串口已打开，等待雷达数据" });
      session.readLoopPromise = this.readLoop(session);
      await session.readLoopPromise;
      if (this.isSessionActive(session)) {
        throw new Error("串口数据流已结束，设备可能已断开。");
      }
    } catch (error) {
      failure = error;
    }

    const canceled = session.stopRequested || session.teardownRequested || this.session !== session;
    if (failure && !canceled) {
      const cleanup = await this.teardownSession(session, "error");
      this.reportError(failure);
      if (cleanup.error && cleanup.error !== failure) this.reportError(cleanup.error);
       this.onStatus({ state: "error", text: `串口会话失败：${failure.message}` });
      throw failure;
    }

    // 人工断开或拔线已经请求停止时，确保 runSession 不会留下半开的端口。
    if (failure || canceled) await this.teardownSession(session, "cancel");
    if (failure) throw failure;
  }

  // 持续读取字节；使用局部 reader 并在 finally 中释放，避免清理流程置空共享引用后崩溃。
  async readLoop(session) {
    if (!session.port.readable) throw new Error("串口已打开但没有可读数据流。");
    while (this.isSessionActive(session) && session.port.readable) {
      const reader = session.port.readable.getReader();
      session.reader = reader;
      this.reader = reader;
      let streamDone = false;
      try {
        while (this.isSessionActive(session)) {
          const { value, done } = await reader.read();
          if (done) {
            streamDone = true;
            break;
          }
          if (value?.length && this.isSessionActive(session)) this.onBytes(value);
        }
      } finally {
        if (session.reader === reader) session.reader = null;
        if (this.reader === reader) this.reader = null;
        try {
          reader.releaseLock();
        } catch {
          // 拔线时浏览器可能已经自动释放锁，不能阻断后续端口清理。
        }
      }
      if (streamDone) break;
    }
    if (this.isSessionActive(session)) {
      throw new Error("串口数据流已结束，设备可能已断开。");
    }
  }

  // 取消 reader、等待读取/写入完成、撤销 DTR，最后才关闭端口；整个过程可重复调用。
  async teardownSession(session, reason = "manual") {
    if (!session) return { closed: true, error: null };
    if (session.closed) return { closed: true, error: null };
    if (session.teardownPromise) return session.teardownPromise;

    session.stopRequested = true;
    session.teardownRequested = true;
    if (this.session === session) {
      this.stopRequested = true;
      this.phase = "closing";
    }

    const task = (async () => {
      let firstError = null;
      let closeFailed = false;
      const remember = (error) => {
        if (!firstError && error) firstError = error;
      };

      // 即使断开发生在 open 尚未完成时，也要等 open settled 后再尝试 close。
      if (session.openPromise) {
        try {
          await session.openPromise;
          session.opened = true;
        } catch {
          // open 失败时没有可关闭的端口，原始错误由 runSession 报告。
        }
      }
      if (session.signalPromise) {
        try {
          await session.signalPromise;
        } catch (error) {
          remember(error);
        }
      }

      const reader = session.reader;
      if (reader) {
        try {
          await reader.cancel();
        } catch (error) {
          // 读取流已因拔线进入 errored 状态时 cancel 可能失败，但仍须继续等待循环结束。
          remember(reason === "error" ? error : null);
        }
      }
      if (session.readLoopPromise) {
        try {
          await session.readLoopPromise;
        } catch (error) {
          remember(reason === "error" ? error : null);
        }
      }

      // 等待所有写命令结束，确保 writer 锁在 close 前已经释放。
      try {
        await session.commandTail;
      } catch (error) {
        remember(error);
      }

      if (session.dtrRequested && typeof session.port.setSignals === "function") {
        let dtrDisabled = false;
        try {
          await session.port.setSignals({ dataTerminalReady: false });
          dtrDisabled = true;
        } catch (error) {
          remember(error);
        }
        if (dtrDisabled) {
          session.dtrRequested = false;
          session.dtrEnabled = false;
        }
      }

      if (session.opened && typeof session.port.close === "function") {
        try {
          await session.port.close();
        } catch (error) {
          closeFailed = true;
          remember(error);
        }
      }

      if (this.session === session && !closeFailed) {
        session.closed = true;
        this.session = null;
        this.openedPort = null;
        this.reader = null;
        this.reading = false;
        this.dtrEnabled = false;
        this.phase = this.port ? "selected" : "idle";
      } else if (this.session === session) {
        // 关闭失败时不能谎报“已断开”，保留会话供用户再次点击断开重试。
        this.reader = null;
        this.reading = false;
        this.phase = "error";
        this.openedPort = session.opened ? session.port : null;
        this.dtrEnabled = session.dtrRequested;
      }
      return { closed: !closeFailed, error: firstError };
    })();

    session.teardownPromise = task;
    try {
      return await task;
    } finally {
      if (session.teardownPromise === task) session.teardownPromise = null;
    }
  }

  // 取消当前会话并发布人工断开状态；同一时间的重复调用共享一个 Promise。
  async disconnect() {
    if (this.disconnectTask) return this.disconnectTask;
    const task = (async () => {
      const session = this.session;
      if (session) {
        session.stopRequested = true;
        session.teardownRequested = true;
        this.onStatus({ state: "disconnecting", text: "正在断开串口" });
        const result = await this.teardownSession(session, "manual");
        if (result.error) this.reportError(result.error);
        if (!result.closed) {
          this.onStatus({ state: "error", text: "串口未能完全断开，请再次点击断开" });
          return result;
        }
      } else {
        this.stopRequested = true;
        this.phase = this.port ? "selected" : "idle";
        this.reading = false;
      }
      this.onStatus({ state: "disconnected", text: "串口已断开" });
      return { closed: true, error: null };
    })();
    this.disconnectTask = task;
    try {
      return await task;
    } finally {
      if (this.disconnectTask === task) this.disconnectTask = null;
    }
  }

  // 将拔线事件纳入同一幂等清理流程，并给出比普通断开更明确的教学提示。
  async handleUnexpectedDisconnect() {
    if (this.disconnectTask) return this.disconnectTask;
    const task = (async () => {
      const session = this.session;
      if (session) {
        session.stopRequested = true;
        session.teardownRequested = true;
        const result = await this.teardownSession(session, "unexpected");
        if (result.error) this.reportError(result.error);
        if (result.error && !result.closed) {
          this.onStatus({ state: "error", text: "设备已拔出，但串口资源未完全释放" });
          return result;
        }
      }
      try {
        this.onDisconnect();
      } catch (error) {
        this.reportError(error);
      }
      this.onStatus({ state: "disconnected", text: "设备已拔出，请检查 USB 线和供电" });
      return { closed: true, error: null };
    })();
    this.disconnectTask = task;
    try {
      return await task;
    } finally {
      if (this.disconnectTask === task) this.disconnectTask = null;
    }
  }

  // 把写命令放进串行队列，避免开始/停止按钮争用 writer 锁。
  enqueueCommand(bytes, status) {
    const session = this.session;
    if (!session || !session.opened || session.stopRequested || this.phase !== "open" || !session.port.writable) {
      return Promise.reject(new Error("串口尚未连接，无法发送扫描命令。"));
    }
    const previous = session.commandTail;
    const task = previous.then(async () => {
      if (!this.isSessionActive(session) || !session.port.writable) {
        throw new Error("串口正在断开，取消发送扫描命令。");
      }
      const writer = session.port.writable.getWriter();
      session.writer = writer;
      try {
        await writer.write(bytes);
      } finally {
        try {
          writer.releaseLock();
        } finally {
          if (session.writer === writer) session.writer = null;
        }
      }
      if (this.isSessionActive(session)) this.onStatus(status);
    });
    // 队列尾部永远保持 resolved，后续命令和 teardown 不会被前一条失败命令卡死。
    session.commandTail = task.catch(() => {});
    return task;
  }

  // 手动发送标准 YDLIDAR 扫描命令，默认不自动调用，避免误用其他型号固件。
  requestScan(force = false) {
    return this.enqueueCommand(
      Uint8Array.from([0xa5, force ? 0x61 : 0x60]),
      { state: "connected-waiting", text: "已发送扫描请求，等待雷达数据" },
    );
  }

  // 手动发送停止采集命令，说明它只停止数据流，不保证自转模块断电。
  requestStop() {
    return this.enqueueCommand(
      Uint8Array.from([0xa5, 0x65]),
      { state: "connected-waiting", text: "已发送停止请求；必要时请断开 USB 供电" },
    );
  }

  // 页面销毁时移除全局事件监听，并尽力释放端口和 DTR 信号。
  dispose() {
    if (typeof navigator !== "undefined" && "serial" in navigator) {
      navigator.serial.removeEventListener("disconnect", this.disconnectHandler);
    }
    void this.disconnect().catch((error) => this.reportError(error));
  }
}
