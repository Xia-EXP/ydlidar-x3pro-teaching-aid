// 高频串口数据只应推动“最新状态”而不是把每个小块都变成一次布局任务。
export const PACKET_DIAGNOSTIC_INTERVAL_MS = 200;

// 用影响按钮和状态文字的字段生成稳定签名；相同签名无需再次写 DOM。
export function buildStatusUiKey({
  status = {},
  connected = false,
  busy = false,
  canConnect = false,
  supported = false,
  hasFrame = false,
  scanPaused = false,
  commandPending = false,
  mappingMode = "local",
  mappingActive = false,
  mappingStarted = false,
} = {}) {
  return [
    status.state ?? "",
    status.text ?? "",
    connected ? 1 : 0,
    busy ? 1 : 0,
    canConnect ? 1 : 0,
    supported ? 1 : 0,
    hasFrame ? 1 : 0,
    scanPaused ? 1 : 0,
    commandPending ? 1 : 0,
    mappingMode,
    mappingActive ? 1 : 0,
    mappingStarted ? 1 : 0,
  ].join("|");
}

// 诊断文本按固定时间窗发布，避免串口包速率直接变成 DOM 更新速率。
export function diagnosticDue(lastPublishedAt, now, intervalMs = PACKET_DIAGNOSTIC_INTERVAL_MS) {
  const last = Number(lastPublishedAt);
  const current = Number(now);
  const interval = Number(intervalMs);
  if (!Number.isFinite(current) || !Number.isFinite(interval) || interval < 0) return false;
  return !Number.isFinite(last) || current - last >= interval;
}
