import { syncMapMode } from "./console-layout.js"; // 同步地图专属控件的可见性，保持显示与应用状态一致。
import { bytesToHex, PacketStreamDecoder, ScanAssembler } from "./protocol.js";
import { getDeviceProfile } from "./device-profile.js";
import { analyzeScan, DEFAULT_ANALYSIS_SETTINGS } from "./analysis.js";
import { DEFAULT_OCCUPANCY_CONFIG, LocalOccupancyGrid } from "./occupancy.js";
import { DEFAULT_MAPPING_CONFIG, ExperimentalMapper } from "./mapping.js";
import { SerialController } from "./serial.js";
import {
  PACKET_DIAGNOSTIC_INTERVAL_MS,
  buildStatusUiKey,
  diagnosticDue,
} from "./ui-scheduler.js";
import {
  decisionLabel,
  drawOccupancyMap,
  drawPolarScan,
  drawStaleOverlay,
  formatMappingMatchQuality,
  hitTestPolar,
  mappingStatusLabel,
  resolveDisplayDecision,
} from "./render.js";

// 集中保存页面状态，保证串口、分析算法和 Canvas 渲染之间只通过明确数据流通信。
const state = {
  settings: { ...DEFAULT_ANALYSIS_SETTINGS },
  rawFrame: null,
  frame: null,
  selectedPointIndex: -1,
  latestPacket: null,
  liveScanProgress: null,
  deviceProfile: getDeviceProfile(),
  decoderStats: { packets: 0, checksumErrors: 0, malformedPackets: 0, droppedBytes: 0, bufferedBytes: 0 },
  status: { state: "disconnected", text: "未连接" },
  lastFrameReceivedAt: 0,
  staleTimer: null,
  renderQueued: false,
  // Canvas 只有在数据/参数/尺寸真的变化时才重绘；纯状态诊断更新不触发它。
  canvasDirty: true,
  // 串口诊断采用低频定时器，避免每个字节块都造成 DOM 布局任务。
  packetDiagnosticsTimer: null,
  packetDiagnosticsLastPublishedAt: Number.NEGATIVE_INFINITY,
  statusUiKey: "",
  resizeObserver: null,
  scanPaused: false,
  scanResumeRequested: false,
  commandPending: false,
  occupancyGrid: new LocalOccupancyGrid(DEFAULT_OCCUPANCY_CONFIG),
  occupancySnapshot: null,
  occupancyDecayTimer: null,
  mapLayers: { showLiveRays: true, showClusters: true, showDecision: true },
  // 建图是独立于局部占据和避障的实验支路，默认不启动，避免用户未确认就累积移动轨迹。
  mappingMapper: new ExperimentalMapper(DEFAULT_MAPPING_CONFIG),
  mappingSnapshot: null,
  mappingMode: "local",
  mappingStarted: false,
  mappingActive: false,
  mappingLayers: { showMappingTrajectory: true, showMappingScan: true },
};

// 通过 ID 获取控件，缺少关键元素时尽早抛出错误，避免静默显示半个界面。
const elements = Object.fromEntries([
  "statusDot", "connectionState", "browserSupport", "choosePortButton", "chooseOtherPortButton", "portDescription", "baudRate", "dtrControlInput", // 注册两个串口授权入口。
  "connectButton", "startScanButton", "stopScanButton", "disconnectButton", "connectionMessage", "noDataChecklist", "polarCanvas", "mapCanvas", "polarSummary",
  "mapSummary", "scanFrequency", "clusterCount", "decisionBadge", "decisionReason", "frontClearance",
  "leftClearance", "rightClearance", "selectedPointIndex", "selectedAngle", "selectedDistance", "selectedX",
  "selectedY", "selectedPointAnnouncement", "dataAge", "validPointCount", "packetCount", "framePacketCount", "checksumErrors", "droppedBytes", "rawPacket",
  "selectedPointMeta",
  "resetParametersButton", "errorMessage", "occupancyResolutionInput", "occupancyPersistenceInput", "occupancyPersistenceValue",
  "showLiveRaysInput", "showClustersInput", "showDecisionInput", "clearOccupancyButton", "occupancyFreeCount",
  "occupancyOccupiedCount", "occupancyFrameAge", "occupancyScanFrequency",
  "mappingModeInput", "startMappingButton", "pauseMappingButton", "clearMappingButton", "showMappingTrajectoryInput", "showMappingScanInput",
  "mapModeBadge", "mappingStatusBadge", "mappingPoseX", "mappingPoseY", "mappingPoseTheta", "mappingMatchQuality", "mappingInlierCount",
  "mappingFrameCount", "mappingMapAge", "mappingTrackingState", "mappingSummary", "mapNoticeText",
  "liveAngle", "livePacket", "liveSampleCount", "liveSweep", "liveProgress", "liveDirection", "livePacketFields",
  "deviceVidPid", "measuredPacketRate", "measuredScanRate", "measuredPointStats", "deviceSpecSummary",
  "showLiveBeamInput", "showPacketEchoInput", "showSweptSectorInput", "showInvalidInput", "showCoordinateGridInput",
].map((id) => [id, document.getElementById(id)]));

const parameterControls = {
  maxRangeInput: { key: "maxRangeMm", read: (value) => Number(value) * 1000, output: "maxRangeValue", format: (value) => `${(value / 1000).toFixed(1)} m`, rebuildOccupancy: true, resetMapping: true },
  stopDistanceInput: { key: "stopDistanceMm", read: Number, output: "stopDistanceValue", format: (value) => `${value} mm` },
  turnDistanceInput: { key: "turnDistanceMm", read: Number, output: "turnDistanceValue", format: (value) => `${value} mm` },
  clusterGapInput: { key: "clusterGapMm", read: Number, output: "clusterGapValue", format: (value) => `${value} mm` },
  minClusterPointsInput: { key: "minClusterPoints", read: Number, output: "minClusterPointsValue", format: (value) => `${value} 点` },
  frontAngleInput: { key: "frontHalfAngleDeg", read: Number, output: "frontAngleValue", format: (value) => `${value}°` },
  angleOffsetInput: { key: "angleOffsetDeg", read: Number, output: "angleOffsetValue", format: (value) => `${value}°`, rebuildOccupancy: true, resetMapping: true },
};

// 只有文字真的改变时才写入 DOM，避免重复 textContent 赋值触发布局/无障碍树更新。
function setTextIfChanged(element, value) {
  if (!element) return false;
  const text = String(value);
  if (element.textContent === text) return false;
  element.textContent = text;
  return true;
}

// disabled/hidden 属性同样做差分写入，状态回调高频到达时不反复触发样式计算。
function setBooleanPropertyIfChanged(element, property, value) {
  if (!element) return false;
  const next = Boolean(value);
  if (element[property] === next) return false;
  element[property] = next;
  return true;
}

// 解析器和单圈聚合器只创建一次，断开时清空它们的状态以防止跨连接污染。
const decoder = new PacketStreamDecoder({ sampleBytes: 2, maxLsn: 40 });
const assembler = new ScanAssembler();

// 根据设备连接状态决定按钮可用性和状态点的文字/颜色语义。
function applyStatus(status) {
  state.status = status;
  syncMapMode(state.mappingMode); // 包括恢复默认在内的状态刷新都更新地图操作区，不触发设备命令。
  const controller = window.serialController;
  const connected = controller?.isConnected ?? ["connected-waiting", "streaming"].includes(status.state);
  const error = status.state === "error";
  // 打开和断开阶段也视为忙碌，避免用户在异步串口操作尚未完成时换口或重复连接。
  const busy = Boolean(controller?.isBusy) || ["connecting", "disconnecting"].includes(status.state);
  const supported = SerialController.isSupported();
  const canConnect = Boolean(controller?.canConnect);
  const nextKey = buildStatusUiKey({
    status,
    connected,
    busy,
    canConnect,
    supported,
    hasFrame: Boolean(state.frame),
    scanPaused: state.scanPaused,
    commandPending: state.commandPending,
    mappingMode: state.mappingMode,
    mappingActive: state.mappingActive,
    mappingStarted: state.mappingStarted,
  });
  // 完整扫描会再次收到相同 streaming 状态；签名未变化时直接跳过整组 DOM 写入。
  if (state.statusUiKey === nextKey) return;
  state.statusUiKey = nextKey;

  setTextIfChanged(elements.connectionState, status.text);
  setTextIfChanged(elements.connectionMessage, status.text);
  if (elements.statusDot.classList.contains("is-connected") !== connected) {
    elements.statusDot.classList.toggle("is-connected", connected);
  }
  if (elements.statusDot.classList.contains("is-error") !== error) {
    elements.statusDot.classList.toggle("is-error", error);
  }
  setBooleanPropertyIfChanged(elements.choosePortButton, "disabled", busy || !supported);
  setBooleanPropertyIfChanged(elements.chooseOtherPortButton, "disabled", busy || !supported); // 兼容入口与主入口使用相同的禁用条件。
  setBooleanPropertyIfChanged(elements.connectButton, "disabled", busy || !canConnect);
  setBooleanPropertyIfChanged(elements.baudRate, "disabled", busy);
  setBooleanPropertyIfChanged(elements.dtrControlInput, "disabled", busy);
  setBooleanPropertyIfChanged(elements.noDataChecklist, "hidden", Boolean(state.frame) && connected && !state.scanPaused);
  setBooleanPropertyIfChanged(elements.startScanButton, "disabled", !connected || state.commandPending);
  setBooleanPropertyIfChanged(elements.stopScanButton, "disabled", !connected || state.commandPending);
  // 建图按钮只依赖串口连接和建图自身状态；它不会向雷达发送运动命令。
  setBooleanPropertyIfChanged(
    elements.startMappingButton,
    "disabled",
    !connected || state.commandPending || state.mappingMode !== "mapping" || state.mappingActive || !state.frame,
  );
  setBooleanPropertyIfChanged(elements.pauseMappingButton, "disabled", !state.mappingActive);
  setTextIfChanged(elements.startMappingButton, state.mappingStarted && !state.mappingActive ? "继续建图" : "开始建图");
  // 有活动会话或正在断开时保留断开入口，让用户可以重复点击而不产生第二个清理流程。
  setBooleanPropertyIfChanged(elements.disconnectButton, "disabled", !(busy || error || Boolean(controller?.disconnectTask)));
  // 状态栏只需要刷新文字，不需要把两个 Canvas 再画一遍。
  scheduleRender({ canvas: false });
}

// 将异常显示在页面内，避免 alert 打断课堂演示或遮挡扫描图。
function showError(error) {
  const message = error instanceof Error ? error.message : String(error);
  elements.errorMessage.hidden = false;
  elements.errorMessage.textContent = message;
}

// 成功重新收到数据时清除旧错误，避免用户误以为当前仍然故障。
function clearError() {
  elements.errorMessage.hidden = true;
  elements.errorMessage.textContent = "";
}

// 把选中的点写入文字字段，让 Canvas 之外也有可访问、可复制的数值内容。
function updateSelectedPoint() {
  const point = state.frame?.points?.find((candidate) => candidate.index === state.selectedPointIndex);
  if (!point) {
    setTextIfChanged(elements.selectedPointIndex, "未选择");
    setTextIfChanged(elements.selectedAngle, "--");
    setTextIfChanged(elements.selectedDistance, "--");
    setTextIfChanged(elements.selectedX, "--");
    setTextIfChanged(elements.selectedY, "--");
    setTextIfChanged(elements.selectedPointMeta, "包号 / 采样序号 / 原始距离 / 原始角度 / 三角修正：--");
    return;
  }
  setTextIfChanged(elements.selectedPointIndex, `点 ${point.index + 1}`);
  setTextIfChanged(elements.selectedAngle, point.angleDeg.toFixed(2));
  setTextIfChanged(elements.selectedDistance, point.distanceMm.toFixed(0));
  setTextIfChanged(elements.selectedX, point.xMm.toFixed(0));
  setTextIfChanged(elements.selectedY, point.yMm.toFixed(0));
  setTextIfChanged(elements.selectedPointMeta, `包 ${(point.packetIndex ?? -1) + 1} · 采样 ${(point.sampleIndex ?? point.index ?? -1) + 1} · 原始距离 ${point.rawDistance ?? "--"} · 原始角度 ${Number(point.rawAngleDeg ?? point.angleDeg).toFixed(2)}° · 修正 ${Number(point.angleCorrectionDeg ?? 0).toFixed(2)}°${point.invalidReason ? ` · 无效：${point.invalidReason}` : ""}`);
}

// 只在用户主动选点时播报一次摘要，避免屏幕阅读器跟随每个扫描帧重复朗读。
function announceSelectedPoint() {
  const point = state.frame?.points?.find((candidate) => candidate.index === state.selectedPointIndex);
  elements.selectedPointAnnouncement.textContent = point
    ? `已选择点 ${point.index + 1}，角度 ${point.angleDeg.toFixed(1)} 度，距离 ${point.distanceMm.toFixed(0)} 毫米。`
    : "当前没有选中的有效点。";
}

// 对无穷大清距使用“无有效样本”而不是把 Infinity 直接展示给学生。
function formatClearance(value, sampleCount) {
  return sampleCount > 0 && Number.isFinite(value) ? `${Math.round(value)}` : "无样本";
}

// 定时刷新衰减后的栅格快照；只有仍存在证据时才继续计时，避免空闲页面长期轮询。
function scheduleOccupancyDecay() {
  if (state.occupancyDecayTimer || !(state.occupancySnapshot?.freeCount || state.occupancySnapshot?.occupiedCount)) return;
  state.occupancyDecayTimer = setTimeout(() => {
    state.occupancyDecayTimer = null;
    state.occupancySnapshot = state.occupancyGrid.snapshot(performance.now());
    scheduleRender();
    scheduleOccupancyDecay();
  }, 250);
}

// 清空所有历史证据；可选择把当前完整扫描作为新坐标系中的第一圈重新加入。
function resetOccupancyMap({ rebuildCurrentFrame = false } = {}) {
  if (state.occupancyDecayTimer) clearTimeout(state.occupancyDecayTimer);
  state.occupancyDecayTimer = null;
  state.occupancyGrid.clear();
  if (rebuildCurrentFrame && state.frame) {
    const timestamp = state.lastFrameReceivedAt || performance.now();
    state.occupancySnapshot = state.occupancyGrid.update(state.frame, timestamp);
  } else {
    state.occupancySnapshot = state.occupancyGrid.snapshot(performance.now());
  }
  scheduleOccupancyDecay();
  scheduleRender();
}

// 清空实验性全局地图并保留固定数组容量；坐标校准变化时由调用者选择是否保留“正在建图”状态。
function resetMappingMap({ preserveState = false } = {}) {
  const wasStarted = state.mappingStarted;
  const wasActive = state.mappingActive;
  state.mappingMapper.clear();
  // clear 后恢复为可接收首帧的 ready 状态；是否真正处理帧仍由 app 状态开关决定。
  state.mappingMapper.resume();
  state.mappingStarted = preserveState ? wasStarted : false;
  state.mappingActive = preserveState ? wasActive : false;
  state.mappingSnapshot = state.mappingMapper.snapshot();
  scheduleRender();
}

// 只有用户明确开始建图后才处理完整扫描；局部避障和历史地图不会反过来改变这个判断。
function processMappingFrame(timestamp) {
  if (!state.mappingActive || !state.frame) return;
  state.mappingSnapshot = state.mappingMapper.processFrame(state.frame, timestamp);
}

// 开始或继续实验性扫描匹配建图；第一帧只建立参考，后续帧才估计位姿并写入全局栅格。
function startMapping() {
  clearError();
  if (state.mappingActive) return;
  if (!state.frame) {
    showError(new Error("请先连接雷达并等待一圈完整扫描，再开始建图。"));
    return;
  }
  // 手动开始建图时同步切换可视模式，避免按钮动作与画面模式不一致。
  state.mappingMode = "mapping";
  elements.mappingModeInput.value = "mapping";
  if (!state.mappingStarted) {
    state.mappingMapper.clear();
    state.mappingStarted = true;
  }
  state.mappingMapper.resume();
  state.mappingActive = true;
  processMappingFrame(state.lastFrameReceivedAt || performance.now());
  applyStatus(state.status);
  scheduleRender();
}

// 暂停只冻结历史地图和位姿；恢复时丢弃旧参考帧，避免暂停期间的未知移动造成错误跳变。
function pauseMapping() {
  if (!state.mappingStarted) return;
  state.mappingActive = false;
  state.mappingSnapshot = state.mappingMapper.pause();
  applyStatus(state.status);
  scheduleRender();
}

// 坐标偏移、方向、量程或栅格分辨率变化后重建当前一圈，避免新旧坐标证据混在一起。
function rebuildOccupancyFromCurrentFrame() {
  state.occupancyGrid.configure({
    maxRangeMm: state.settings.maxRangeMm,
    resolutionMm: Number(elements.occupancyResolutionInput.value),
  });
  resetOccupancyMap({ rebuildCurrentFrame: true });
}

// 用最新完整扫描重新运行坐标、聚类和避障分析，参数拖动无需重新读取串口。
function reanalyzeCurrentFrame({ rebuildOccupancy = false, resetMapping = false } = {}) {
  state.frame = state.rawFrame ? analyzeScan(state.rawFrame, state.settings) : null;
  if (state.selectedPointIndex >= 0 && !state.frame?.points?.some((point) => point.index === state.selectedPointIndex && point.valid)) {
    state.selectedPointIndex = -1;
  }
  if (rebuildOccupancy) rebuildOccupancyFromCurrentFrame();
  // 角度/量程改变会改变世界坐标，旧位姿不能与新坐标混合。
  if (resetMapping) resetMappingMap({ preserveState: true });
  updateSelectedPoint();
  scheduleRender();
}

// 接收完整一圈后只保留最新结果，天然避免高频数据在界面队列中排队。
function handleCompletedScan(rawFrame) {
  state.rawFrame = rawFrame;
  state.lastFrameReceivedAt = performance.now();
  // 停止后只有用户明确请求重新开始，且随后收到新圈，才解除暂停保护。
  if (!state.scanPaused || state.scanResumeRequested) {
    state.scanPaused = false;
    state.scanResumeRequested = false;
  }
  if (state.staleTimer) clearTimeout(state.staleTimer);
  // 数据停止后主动刷新一次，让最后一帧在 500ms 后变成明确的过期状态。
  state.staleTimer = setTimeout(() => {
    // 数据间隔超过安全窗口后停止继续匹配；恢复建图必须由用户点击“继续建图”重新建立参考。
    if (state.mappingActive) pauseMapping();
    scheduleRender();
  }, 520);
  state.frame = analyzeScan(rawFrame, state.settings);
  // 占据证据只在新完整圈到达时累计，参数面板的重新分析不会重复加入同一帧。
  state.occupancySnapshot = state.occupancyGrid.update(state.frame, state.lastFrameReceivedAt);
  // 建图只消费新的完整扫描一次；拖动聚类或避障参数不会重复累计同一帧。
  processMappingFrame(state.lastFrameReceivedAt);
  scheduleOccupancyDecay();
  setBooleanPropertyIfChanged(elements.noDataChecklist, "hidden", true);
  // 保留学生当前选中的点，只在该点在新一圈中消失时清空选择。
  if (state.selectedPointIndex >= 0 && !state.frame.points.some((point) => point.index === state.selectedPointIndex && point.valid)) {
    state.selectedPointIndex = -1;
  }
  clearError();
  if (state.status.state !== "streaming") {
    applyStatus({ state: "streaming", text: "正在接收雷达扫描" });
  } else {
    // 即使串口状态文字没有变化，首帧到达也会改变“开始建图”按钮是否可用。
    applyStatus(state.status);
  }
  updateSelectedPoint();
  scheduleRender();
}

// 串口统计只更新文本字段，不触发 Canvas；这样高频包仍可诊断但不会造成画面抖动。
function updatePacketDiagnostics(now = performance.now()) {
  if (!diagnosticDue(state.packetDiagnosticsLastPublishedAt, now, PACKET_DIAGNOSTIC_INTERVAL_MS)) return false;
  state.packetDiagnosticsLastPublishedAt = now;
  setTextIfChanged(elements.packetCount, state.decoderStats.packets);
  setTextIfChanged(elements.checksumErrors, state.decoderStats.checksumErrors);
  setTextIfChanged(elements.droppedBytes, state.decoderStats.droppedBytes);
  setTextIfChanged(elements.rawPacket, state.latestPacket?.raw ? bytesToHex(state.latestPacket.raw) : "尚未收到数据");
  return true;
}

// 用单个低频定时器合并多个串口块的诊断更新，定时器本身不申请下一帧 Canvas 绘制。
function schedulePacketDiagnostics() {
  if (state.packetDiagnosticsTimer) return;
  const now = performance.now();
  const elapsed = now - state.packetDiagnosticsLastPublishedAt;
  const delay = Number.isFinite(elapsed)
    ? Math.max(0, PACKET_DIAGNOSTIC_INTERVAL_MS - elapsed)
    : 0;
  state.packetDiagnosticsTimer = setTimeout(() => {
    state.packetDiagnosticsTimer = null;
    updatePacketDiagnostics(performance.now());
  }, delay);
}

// 合法包到达时只请求一次浏览器帧，由统一渲染循环消费最新包覆盖层。
// 雷达约 7 圈/秒，逐包图层在 60Hz 屏幕上会跳动闪烁；未开启这些图层时 Canvas 只随完整扫描圈重绘。
function queueLiveOverlay() {
  const liveLayerOn = [elements.showLiveBeamInput, elements.showPacketEchoInput, elements.showSweptSectorInput].some((input) => input?.checked);
  scheduleRender({ canvas: liveLayerOn });
}

// 断开设备时取消待执行的诊断回调，防止旧会话在新会话建立后写回过时数字。
function cancelPacketDiagnostics() {
  if (state.packetDiagnosticsTimer) clearTimeout(state.packetDiagnosticsTimer);
  state.packetDiagnosticsTimer = null;
  state.packetDiagnosticsLastPublishedAt = Number.NEGATIVE_INFINITY;
}

// 将任意串口块交给解析器，再把完成的一圈交给分析管线。
function handleBytes(bytes) {
  const packets = decoder.push(bytes);
  // 先冻结本次串口块的诊断快照，再把它附到本块产生的完整扫描，保持 ScanFrame 可追溯。
  state.decoderStats = decoder.getStats();
  for (const packet of packets) {
    state.latestPacket = packet;
    const completed = assembler.push(packet, performance.now());
    state.liveScanProgress = assembler.getProgress();
    if (completed) {
      handleCompletedScan({
        ...completed,
        checksumErrors: state.decoderStats.checksumErrors,
        droppedBytes: state.decoderStats.droppedBytes,
      });
    }
  }
  // 没有完整扫描时只延迟刷新诊断数字；Canvas 只由 handleCompletedScan 重绘。
  schedulePacketDiagnostics();
  // 合法包只触发一次合帧调度，实时覆盖层使用最新包，不排队历史包。
  if (packets.length) queueLiveOverlay();
}

// 按浏览器帧率刷新 Canvas 和数值面板，避免每个串口包都触发一次布局。
function scheduleRender({ canvas = true } = {}) {
  if (canvas) state.canvasDirty = true;
  if (state.renderQueued) return;
  state.renderQueued = true;
  requestAnimationFrame(() => {
    state.renderQueued = false;
    render();
  });
}

// 根据最新状态绘制两个视图，并处理数据过期时的安全显示。
function render() {
  const now = performance.now();
  const ageMs = state.lastFrameReceivedAt ? Math.max(0, now - state.lastFrameReceivedAt) : Number.POSITIVE_INFINITY;
  const hasFrame = Boolean(state.frame);
  const stale = hasFrame && ageMs > 500;
  const paused = hasFrame && state.scanPaused;
  // 数据停止或被手动暂停时重新展示排错清单，帮助课堂从画面回到供电/串口检查。
  setBooleanPropertyIfChanged(elements.noDataChecklist, "hidden", hasFrame && !stale && !paused);
  const displayDecision = resolveDisplayDecision(state.frame, { stale, paused });

  // 诊断/状态栏刷新可以复用本次状态而不重画 Canvas；只有 dirty 才消费最新完整扫描。
  if (state.canvasDirty) {
    drawPolarScan(elements.polarCanvas, state.frame, state.settings, state.selectedPointIndex, {
      liveProgress: state.liveScanProgress,
      latestPacket: state.latestPacket,
      showLiveBeam: elements.showLiveBeamInput?.checked !== false,
      showPacketEcho: elements.showPacketEchoInput?.checked !== false,
      showSweptSector: elements.showSweptSectorInput?.checked !== false,
      showInvalid: elements.showInvalidInput?.checked === true,
    });
    drawOccupancyMap(
      elements.mapCanvas,
      state.occupancySnapshot,
      state.frame,
      state.settings,
      displayDecision,
      { ...state.mapLayers, ...state.mappingLayers },
      {
        now,
        ageMs,
        stale,
        paused,
        mappingMode: state.mappingMode,
        mapping: state.mappingSnapshot ?? state.mappingMapper.snapshot(),
        liveProgress: state.liveScanProgress,
        latestPacket: state.latestPacket,
        showLiveBeam: elements.showLiveBeamInput?.checked !== false,
        showPacketEcho: elements.showPacketEchoInput?.checked !== false,
        showSweptSector: elements.showSweptSectorInput?.checked !== false,
        showInvalid: elements.showInvalidInput?.checked === true,
        showCoordinateGrid: elements.showCoordinateGridInput?.checked !== false,
      },
    );
    if (stale || paused) {
      const overlayText = stale ? `数据过期 · 最后一帧 ${Math.round(ageMs)} ms 前` : "扫描已暂停 · 等待新数据";
      drawStaleOverlay(elements.polarCanvas, overlayText);
      drawStaleOverlay(elements.mapCanvas, overlayText);
    }
    state.canvasDirty = false;
  }

  const frame = state.frame;
  setTextIfChanged(elements.scanFrequency, frame?.scanHz ? `${frame.scanHz.toFixed(1)} Hz` : "-- Hz");
  const progress = state.liveScanProgress;
  setTextIfChanged(elements.liveAngle, Number.isFinite(progress?.currentAngleDeg) ? `${progress.currentAngleDeg.toFixed(1)}°` : "--");
  setTextIfChanged(elements.livePacket, progress ? String(progress.packetCount) : "--");
  setTextIfChanged(elements.liveSampleCount, progress ? `${progress.sampleCount} / ${progress.validCount} 有效` : "--");
  setTextIfChanged(elements.liveSweep, progress ? `${progress.sweptAngleDeg.toFixed(1)}°` : "--");
  setTextIfChanged(elements.liveProgress, progress ? `${(progress.progress01 * 100).toFixed(0)}%` : "--");
  setTextIfChanged(elements.liveDirection, progress?.direction === "ccw" ? "逆时针" : progress?.direction === "cw" ? "顺时针" : "方向待确定");
  const packet = progress?.currentPacket;
  setTextIfChanged(elements.livePacketFields, packet ? `CT ${packet.ct} · LSN ${packet.lsn} · FSA ${packet.fsa} (${packet.startAngle.toFixed(2)}°) · LSA ${packet.lsa} (${packet.endAngle.toFixed(2)}°) · CS ${packet.cs.toString(16).padStart(4, "0").toUpperCase()}` : "等待合法数据包");
  setTextIfChanged(elements.measuredPacketRate, state.decoderStats.packets ? `${state.decoderStats.packets}` : "0");
  setTextIfChanged(elements.measuredScanRate, frame?.measuredScanHz ? `${frame.measuredScanHz.toFixed(1)} Hz` : "-- Hz");
  setTextIfChanged(elements.measuredPointStats, frame ? `${frame.validCount} / ${frame.points.length}` : "0 / 0");
  setTextIfChanged(elements.clusterCount, frame ? `${frame.clusters.length} 个簇` : "0 个簇");
  setTextIfChanged(elements.validPointCount, frame ? String(frame.validCount) : "0");
  updatePacketDiagnostics(now);
  setTextIfChanged(elements.framePacketCount, frame ? String(frame.packetCount) : "0");
  setTextIfChanged(elements.dataAge, Number.isFinite(ageMs) ? `${Math.round(ageMs)} ms` : "-- ms");
  setTextIfChanged(elements.occupancyFreeCount, String(state.occupancySnapshot?.freeCount ?? 0));
  setTextIfChanged(elements.occupancyOccupiedCount, String(state.occupancySnapshot?.occupiedCount ?? 0));
  setTextIfChanged(elements.occupancyFrameAge, Number.isFinite(ageMs) ? `${Math.round(ageMs)} ms` : "-- ms");
  setTextIfChanged(elements.occupancyScanFrequency, frame?.scanHz ? `${frame.scanHz.toFixed(1)} Hz` : "-- Hz");

  // 建图摘要只反映扫描匹配支路，不把历史地图混入避障清距或动作判断。
  const mapping = state.mappingSnapshot ?? state.mappingMapper.snapshot();
  const mappingPose = mapping?.pose ?? {};
  const mappingMode = state.mappingStarted
    ? (stale || paused ? "paused" : (mapping?.mode ?? "ready"))
    : "disabled";
  const mappingAge = mapping?.timestamp ? Math.max(0, now - mapping.timestamp) : Number.POSITIVE_INFINITY;
  setTextIfChanged(elements.mapModeBadge, state.mappingMode === "mapping" ? "实验性增量建图" : "固定雷达局部图");
  const mapModeClass = `map-mode-badge ${state.mappingMode === "mapping" ? "map-mode-mapping" : "map-mode-local"}`;
  if (elements.mapModeBadge.className !== mapModeClass) elements.mapModeBadge.className = mapModeClass;
  setTextIfChanged(elements.mappingStatusBadge, mappingStatusLabel(mappingMode));
  const mappingStatusClass = `mapping-status-badge mapping-${mappingMode}`;
  if (elements.mappingStatusBadge.className !== mappingStatusClass) elements.mappingStatusBadge.className = mappingStatusClass;
  setTextIfChanged(elements.mappingPoseX, Number.isFinite(mappingPose.xMm) ? `${Math.round(mappingPose.xMm)} mm` : "-- mm");
  setTextIfChanged(elements.mappingPoseY, Number.isFinite(mappingPose.yMm) ? `${Math.round(mappingPose.yMm)} mm` : "-- mm");
  setTextIfChanged(elements.mappingPoseTheta, Number.isFinite(mappingPose.thetaDeg) ? `${mappingPose.thetaDeg.toFixed(1)}°` : "--°");
  setTextIfChanged(elements.mappingMatchQuality, state.mappingStarted ? formatMappingMatchQuality(mapping?.match) : "--");
  setTextIfChanged(elements.mappingInlierCount, state.mappingStarted && Number.isFinite(mapping?.match?.inliers) ? String(mapping.match.inliers) : "--");
  setTextIfChanged(elements.mappingFrameCount, String(mapping?.frameCount ?? 0));
  setTextIfChanged(elements.mappingMapAge, Number.isFinite(mappingAge) ? `${Math.round(mappingAge)} ms` : "-- ms");
  setTextIfChanged(elements.mappingTrackingState, mappingStatusLabel(mappingMode));
  // 统计数字跟随当前 Canvas 模式，避免显示全局图时仍误读为局部图数量。
  if (state.mappingMode === "mapping") {
    setTextIfChanged(elements.occupancyFreeCount, String(mapping?.freeCount ?? 0));
    setTextIfChanged(elements.occupancyOccupiedCount, String(mapping?.occupiedCount ?? 0));
    setTextIfChanged(elements.occupancyFrameAge, Number.isFinite(mappingAge) ? `${Math.round(mappingAge)} ms` : "-- ms");
  }
  if (state.mappingMode === "mapping") {
    setTextIfChanged(elements.mapSummary, state.mappingStarted
      ? `全局地图 ${mapping?.occupiedCount ?? 0} 个占据格 · 位姿 (${Math.round(mappingPose.xMm ?? 0)}, ${Math.round(mappingPose.yMm ?? 0)}) mm · ${mappingStatusLabel(mappingMode)}；避障仍只使用当前扫描。`
      : "实验性增量建图尚未开始；点击“开始建图”后第一帧作为地图原点。");
    setTextIfChanged(elements.mapNoticeText, "实验性扫描匹配建图：没有里程计、IMU、回环闭合或重定位，移动过快、空旷/对称环境和动态物体都会造成漂移或重影。");
    setTextIfChanged(elements.mappingSummary, !state.mappingStarted
      ? "连接雷达并开始扫描后，点击“开始建图”。第一帧只建立参考，后续通过相邻帧匹配估计 X/Y/θ。"
      : (stale || paused)
        ? "扫描数据已过期或暂停，建图暂不累积；历史地图保留，恢复后会重新建立匹配参考。"
      : mappingMode === "tracking"
        ? `已处理 ${mapping?.frameCount ?? 0} 帧；匹配质量 ${formatMappingMatchQuality(mapping?.match)}，当前地图仅供教学观察。`
        : mappingMode === "lost"
          ? "本帧匹配质量不足，未写入地图；请减慢移动、增加环境特征或清空后重新开始。"
          : mappingMode === "paused"
          ? "建图已暂停，历史地图和位姿保留；继续时会用新帧重新建立匹配参考。"
            : "等待完整扫描。");
  } else {
    setTextIfChanged(elements.mapSummary, frame
      ? `空闲 ${state.occupancySnapshot?.freeCount ?? 0} 格 · 占据 ${state.occupancySnapshot?.occupiedCount ?? 0} 格 · 证据保留 ${(state.occupancySnapshot?.persistenceMs ?? DEFAULT_OCCUPANCY_CONFIG.persistenceMs) / 1000} s；固定雷达局部图，不是 SLAM。`
      : "等待完整扫描；0° 位于画面正上方，+90° 位于左侧，坐标系为 lidar_link。");
    setTextIfChanged(elements.mapNoticeText, "固定雷达局部累积；移动后请清空。这里不是 SLAM，无法生成机器人轨迹。");
    setTextIfChanged(elements.mappingSummary, "当前为固定雷达局部图；切换到实验性增量建图后，点击“开始建图”才会估计位姿。");
  }

  const decision = displayDecision ?? { action: "stop", reason: "等待扫描数据" };
  setTextIfChanged(elements.decisionBadge, stale ? "数据过期" : paused ? "扫描已暂停" : hasFrame ? decisionLabel(decision.action) : "暂无决策");
  const decisionClass = `decision-badge decision-${stale || paused || !hasFrame ? "no-data" : decision.action}`;
  if (elements.decisionBadge.className !== decisionClass) elements.decisionBadge.className = decisionClass;
  setTextIfChanged(elements.decisionReason, decision.reason);
  // G1 仿真只读取同一份建议与点云，自己的帧循环负责动画；未加载完成时跳过。
  g1Sim?.update({ frame, decision: displayDecision, settings: state.settings, stale, paused, hasFrame });
  const oldPrefix = stale || paused ? "旧 " : "";
  setTextIfChanged(elements.frontClearance, frame ? `${oldPrefix}${formatClearance(frame.sectors.front.clearanceMm, frame.sectors.front.sampleCount)}` : "--");
  setTextIfChanged(elements.leftClearance, frame ? `${oldPrefix}${formatClearance(frame.sectors.left.clearanceMm, frame.sectors.left.sampleCount)}` : "--");
  setTextIfChanged(elements.rightClearance, frame ? `${oldPrefix}${formatClearance(frame.sectors.right.clearanceMm, frame.sectors.right.sampleCount)}` : "--");
  setTextIfChanged(elements.polarSummary, frame
    ? `当前 ${frame.validCount} 个有效点；点击任一点查看坐标。${stale ? "数据已过期。" : paused ? "扫描已暂停。" : ""}`
    : "等待串口数据；这里显示 0° 正前方、正角度向左的测距点。");
  updateSelectedPoint();
}

// 把参数滑块同步到算法设置和旁边的数值输出。
function bindParameterControls() {
  for (const [id, definition] of Object.entries(parameterControls)) {
    const input = document.getElementById(id);
    const output = document.getElementById(definition.output);
    input.addEventListener("input", () => {
      const value = definition.read(input.value);
      state.settings[definition.key] = value;
      output.textContent = definition.format(value);
      reanalyzeCurrentFrame({
        rebuildOccupancy: Boolean(definition.rebuildOccupancy),
        resetMapping: Boolean(definition.resetMapping),
      });
    });
  }
  const invertInput = document.getElementById("invertDirectionInput");
  invertInput.addEventListener("change", () => {
    state.settings.invertDirection = invertInput.checked;
    reanalyzeCurrentFrame({ rebuildOccupancy: true, resetMapping: true });
  });
}

// 绑定地图专用控件；图层只影响绘制，几何参数变化才清空并重建证据。
function bindOccupancyControls() {
  elements.occupancyResolutionInput.addEventListener("change", () => {
    rebuildOccupancyFromCurrentFrame();
  });
  elements.occupancyPersistenceInput.addEventListener("input", () => {
    const seconds = Number(elements.occupancyPersistenceInput.value);
    elements.occupancyPersistenceValue.textContent = `${seconds} s`;
    state.occupancyGrid.configure({ persistenceMs: seconds * 1000 });
    state.occupancySnapshot = state.occupancyGrid.snapshot(performance.now());
    scheduleOccupancyDecay();
    scheduleRender();
  });

  const layerBindings = [
    [elements.showLiveRaysInput, "showLiveRays"],
    [elements.showClustersInput, "showClusters"],
    [elements.showDecisionInput, "showDecision"],
  ];
  for (const [input, key] of layerBindings) {
    input.addEventListener("change", () => {
      state.mapLayers[key] = input.checked;
      scheduleRender();
    });
  }
  // 实时教学图层只影响覆盖层绘制，不改变分析、占据证据或避障结果。
  for (const input of [elements.showLiveBeamInput, elements.showPacketEchoInput, elements.showSweptSectorInput, elements.showInvalidInput, elements.showCoordinateGridInput]) {
    input?.addEventListener("change", () => scheduleRender());
  }
  elements.clearOccupancyButton.addEventListener("click", () => resetOccupancyMap());

  // 地图模式只切换显示；只有“开始建图”按钮才会启动扫描匹配和全局证据累计。
  elements.mappingModeInput.addEventListener("change", () => {
    state.mappingMode = elements.mappingModeInput.value === "mapping" ? "mapping" : "local";
    // 切回局部图时暂停后台匹配，避免学生看不到的历史状态继续变化；地图仍保留可供切回查看。
    if (state.mappingMode === "local" && state.mappingActive) pauseMapping();
    applyStatus(state.status);
    scheduleRender();
  });
  const mappingLayerBindings = [
    [elements.showMappingTrajectoryInput, "showMappingTrajectory"],
    [elements.showMappingScanInput, "showMappingScan"],
  ];
  for (const [input, key] of mappingLayerBindings) {
    input.addEventListener("change", () => {
      state.mappingLayers[key] = input.checked;
      scheduleRender();
    });
  }
  elements.startMappingButton.addEventListener("click", startMapping);
  elements.pauseMappingButton.addEventListener("click", pauseMapping);
  elements.clearMappingButton.addEventListener("click", () => {
    resetMappingMap();
    applyStatus(state.status);
  });
}

// 恢复课堂默认参数，确保不同学生实验后能回到同一基线。
function resetParameters() {
  state.settings = { ...DEFAULT_ANALYSIS_SETTINGS };
  for (const [id, definition] of Object.entries(parameterControls)) {
    const input = document.getElementById(id);
    const output = document.getElementById(definition.output);
    const rawValue = definition.key === "maxRangeMm" ? state.settings[definition.key] / 1000 : state.settings[definition.key];
    input.value = String(rawValue);
    output.textContent = definition.format(state.settings[definition.key]);
  }
  document.getElementById("invertDirectionInput").checked = state.settings.invertDirection;
  elements.occupancyResolutionInput.value = String(DEFAULT_OCCUPANCY_CONFIG.resolutionMm);
  elements.occupancyPersistenceInput.value = String(DEFAULT_OCCUPANCY_CONFIG.persistenceMs / 1000);
  elements.occupancyPersistenceValue.textContent = `${DEFAULT_OCCUPANCY_CONFIG.persistenceMs / 1000} s`;
  state.mapLayers = { showLiveRays: true, showClusters: true, showDecision: true };
  elements.showLiveRaysInput.checked = true;
  elements.showClustersInput.checked = true;
  elements.showDecisionInput.checked = true;
  state.mappingMode = "local";
  elements.mappingModeInput.value = "local";
  state.mappingLayers = { showMappingTrajectory: true, showMappingScan: true };
  elements.showMappingTrajectoryInput.checked = true;
  elements.showMappingScanInput.checked = true;
  state.occupancyGrid.configure({
    resolutionMm: DEFAULT_OCCUPANCY_CONFIG.resolutionMm,
    maxRangeMm: state.settings.maxRangeMm,
    persistenceMs: DEFAULT_OCCUPANCY_CONFIG.persistenceMs,
  });
  resetMappingMap();
  reanalyzeCurrentFrame({ rebuildOccupancy: true });
  // 恢复默认会同时切回局部图并停止建图；立即刷新控件状态，避免旧会话留下“继续/暂停”按钮假象。
  applyStatus(state.status);
}

// 连接按钮等待异步任务以显示错误，但读取循环仍在独立会话中运行，断开按钮不会被锁死。
async function connectSerial() {
  clearError();
  const baudRate = Number(elements.baudRate.value);
  try {
    // 等待连接任务的 Promise，让未授权或打开失败直接进入页面错误区；读取循环仍不会阻塞其他点击。
    await window.serialController.connect({ baudRate, dataTerminalReady: elements.dtrControlInput.checked });
  } catch (error) {
    showError(error);
  }
}

// 在设备已连接时手动请求开始扫描，兼容需要 A5 60 的固件，同时不自动猜测设备行为。
async function requestScan() {
  const previousResumeRequested = state.scanResumeRequested;
  state.scanResumeRequested = true;
  state.commandPending = true;
  applyStatus(state.status);
  try {
    await window.serialController.requestScan(false);
    clearError();
  } catch (error) {
    state.scanResumeRequested = previousResumeRequested;
    showError(error);
  } finally {
    state.commandPending = false;
    applyStatus(state.status);
  }
}

// 在设备已连接时手动请求停止数据流，是否停止电机由转接板和 DTR 状态决定。
async function requestStop() {
  const previousPaused = state.scanPaused;
  if (state.mappingActive) pauseMapping();
  state.scanPaused = true;
  state.scanResumeRequested = false;
  state.commandPending = true;
  applyStatus(state.status);
  scheduleRender();
  try {
    await window.serialController.requestStop();
    clearError();
  } catch (error) {
    state.scanPaused = previousPaused;
    showError(error);
  } finally {
    state.commandPending = false;
    applyStatus(state.status);
    scheduleRender();
  }
}

// 请求串口权限只在用户点击时执行，并把 USB 信息显示出来帮助排错。
async function choosePort(showOtherAdapters = false) {
  clearError();
  try {
    if (window.serialController.isBusy) await window.serialController.disconnect();
    await window.serialController.requestPort({ showOtherAdapters }); // 保留此次点击选择的筛选模式。
    // 每次重新选择设备都从空白局部图开始，防止不同雷达会话的证据混合。
    resetOccupancyMap();
    // 不同设备的安装位姿和坐标原点未知，不能继续沿用旧的全局轨迹。
    resetMappingMap();
    elements.portDescription.textContent = window.serialController.getPortDescription();
    elements.portDescription.title = elements.portDescription.textContent;
    setTextIfChanged(elements.deviceVidPid, elements.portDescription.textContent);
    elements.connectButton.disabled = false;
  } catch (error) {
    if (error?.name === "NotFoundError") {
      // 浏览器用同一种异常表示取消选择，提示同时覆盖设备未显示的情况。
      showError(new Error("未选择串口。如果列表没有雷达，请检查设备管理器是否出现 USB 串口，或尝试“其他 USB 转接板”。"));
    } else if (error?.name !== "AbortError") showError(error); // 继续显示授权失败等实际错误。
  }
}

// 断开时清理未完成扫描和选点，避免下一次连接显示上一台设备的数据。
async function disconnectSerial() {
  try {
    const result = await window.serialController.disconnect();
    // 关闭失败时保留旧帧和会话状态，用户可以再次点击断开完成重试。
    if (result?.closed === false) return;
  } catch (error) {
    showError(error);
    return;
  }
  assembler.reset();
  decoder.reset();
  state.rawFrame = null;
  state.frame = null;
  state.latestPacket = null;
  state.liveScanProgress = null;
  state.decoderStats = decoder.getStats();
  state.lastFrameReceivedAt = 0;
  state.scanPaused = false;
  state.scanResumeRequested = false;
  state.commandPending = false;
  cancelPacketDiagnostics();
  if (state.staleTimer) clearTimeout(state.staleTimer);
  state.staleTimer = null;
  state.selectedPointIndex = -1;
  resetOccupancyMap();
  resetMappingMap();
  updateSelectedPoint();
  // 串口状态先于数据结构清理发布；清理完成后再同步一次按钮，避免暂停建图按钮残留为可用。
  applyStatus(state.status);
  scheduleRender();
}

// 为 Canvas 提供鼠标、触摸和键盘入口；键盘 Enter 选择当前扫描中的第一个有效点。
function bindPointSelection() {
  const canvas = elements.polarCanvas;
  canvas.tabIndex = 0;
  canvas.addEventListener("click", (event) => {
    state.selectedPointIndex = hitTestPolar(canvas, state.frame, state.settings, event.clientX, event.clientY);
    updateSelectedPoint();
    announceSelectedPoint();
    scheduleRender();
  });
  canvas.addEventListener("keydown", (event) => {
    if (event.key !== "Enter" && event.key !== " ") return;
    event.preventDefault();
    const next = state.frame?.points?.find((point) => point.valid);
    state.selectedPointIndex = next?.index ?? -1;
    updateSelectedPoint();
    announceSelectedPoint();
    scheduleRender();
  });
}

// 初始化页面能力提示、事件绑定和串口控制器。
function initialize() {
  const supported = SerialController.isSupported();
  elements.browserSupport.textContent = supported
    ? "Edge Web Serial 可用；点击选择串口后才会请求权限。"
    : "当前浏览器不支持 Web Serial，请使用最新版 Edge。";
  elements.choosePortButton.disabled = !supported;
  elements.chooseOtherPortButton.disabled = !supported; // 不支持 Web Serial 时禁用兼容入口。
  elements.connectButton.disabled = true;

  window.serialController = new SerialController({
    onBytes: handleBytes,
    onStatus: applyStatus,
    onError: showError,
    onDisconnect: () => {
      assembler.reset();
      decoder.reset();
      state.rawFrame = null;
      state.frame = null;
      state.latestPacket = null;
      state.liveScanProgress = null;
      state.decoderStats = decoder.getStats();
      state.lastFrameReceivedAt = 0;
      state.scanPaused = false;
      state.scanResumeRequested = false;
      state.commandPending = false;
      cancelPacketDiagnostics();
      state.selectedPointIndex = -1;
      resetOccupancyMap();
      resetMappingMap();
      updateSelectedPoint();
      announceSelectedPoint();
      if (state.staleTimer) clearTimeout(state.staleTimer);
      state.staleTimer = null;
    },
  });

  elements.choosePortButton.addEventListener("click", () => choosePort()); // 默认筛选常见 USB 转接板。
  elements.chooseOtherPortButton.addEventListener("click", () => choosePort(true)); // 用户主动选择兼容入口才放开厂商筛选。
  elements.connectButton.addEventListener("click", connectSerial);
  elements.startScanButton.addEventListener("click", requestScan);
  elements.stopScanButton.addEventListener("click", requestStop);
  elements.disconnectButton.addEventListener("click", disconnectSerial);
  elements.resetParametersButton.addEventListener("click", resetParameters);
  bindParameterControls();
  bindOccupancyControls();
  bindPointSelection();
  window.addEventListener("resize", scheduleRender);
  // 观察 Canvas 的 CSS 尺寸，保证首次布局、高 DPI 和窗口旋转后 backing store 与画面同步。
  if (typeof ResizeObserver !== "undefined") {
    state.resizeObserver = new ResizeObserver(() => scheduleRender());
    state.resizeObserver.observe(elements.polarCanvas);
    state.resizeObserver.observe(elements.mapCanvas);
  }
  window.addEventListener("beforeunload", () => {
    if (state.occupancyDecayTimer) clearTimeout(state.occupancyDecayTimer);
    cancelPacketDiagnostics();
    state.resizeObserver?.disconnect();
    window.serialController.dispose();
  });
  applyStatus({ state: "disconnected", text: "未连接" });
  resetParameters();
  render();
  loadG1Sim();
}

// G1 仿真依赖 WebGL、three.js 与约 19 MB 模型，按需动态加载；失败时文字建议和双图照常工作。
let g1Sim = null;
function loadG1Sim() {
  const container = document.getElementById("g1Sim");
  if (!container) return;
  import("./g1-sim.js")
    .then(({ createG1Sim }) => {
      g1Sim = createG1Sim(container);
      scheduleRender({ canvas: false });
    })
    .catch((error) => {
      const status = container.querySelector('[data-g1="status"]');
      if (status) status.textContent = `G1 仿真不可用：${error.message}`;
    });
}

initialize();
