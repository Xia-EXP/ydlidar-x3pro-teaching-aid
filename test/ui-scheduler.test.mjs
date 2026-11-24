import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  PACKET_DIAGNOSTIC_INTERVAL_MS,
  buildStatusUiKey,
  diagnosticDue,
} from "../public/js/ui-scheduler.js";

// 状态签名测试保证同一 streaming 状态不会反复驱动按钮和状态栏布局。
test("相同状态签名稳定，只有影响 UI 的字段变化才产生新签名", () => {
  const base = {
    status: { state: "streaming", text: "正在接收雷达扫描" },
    connected: true,
    busy: false,
    canConnect: false,
    supported: true,
    hasFrame: true,
    scanPaused: false,
    commandPending: false,
    mappingMode: "local",
    mappingActive: false,
    mappingStarted: false,
  };
  assert.equal(buildStatusUiKey(base), buildStatusUiKey({ ...base }));
  assert.notEqual(buildStatusUiKey(base), buildStatusUiKey({ ...base, scanPaused: true }));
  assert.notEqual(buildStatusUiKey(base), buildStatusUiKey({ ...base, mappingActive: true }));
});

// 诊断节流测试保证包速率不会直接转化为 DOM 更新速率。
test("诊断更新在时间窗内合并，达到时间窗后才允许发布", () => {
  assert.equal(diagnosticDue(Number.NEGATIVE_INFINITY, 0), true);
  assert.equal(diagnosticDue(0, PACKET_DIAGNOSTIC_INTERVAL_MS - 1), false);
  assert.equal(diagnosticDue(0, PACKET_DIAGNOSTIC_INTERVAL_MS), true);
  assert.equal(diagnosticDue(100, 90), false);
  assert.equal(diagnosticDue(0, 100, 0), true);
});

// 静态回归测试保证串口小块路径不直接申请 Canvas 帧，完整扫描路径仍保留刷新入口。
test("串口块路径不触发 Canvas 重绘，完整扫描路径负责刷新", () => {
  const appPath = fileURLToPath(new URL("../public/js/app.js", import.meta.url));
  const source = readFileSync(appPath, "utf8").replaceAll("\r\n", "\n");
  const handleBytesBody = source.match(/function handleBytes\(bytes\) \{([\s\S]*?)\n\}\n\n\/\/ 按浏览器帧率/);
  assert.ok(handleBytesBody, "找不到 handleBytes 函数边界");
  assert.doesNotMatch(handleBytesBody[1], /scheduleRender\s*\(/);
  const completedBody = source.match(/function handleCompletedScan\(rawFrame\) \{([\s\S]*?)\n\}\n\n\/\/ 串口统计/);
  assert.ok(completedBody, "找不到 handleCompletedScan 函数边界");
  assert.match(completedBody[1], /scheduleRender\s*\(/);
});
