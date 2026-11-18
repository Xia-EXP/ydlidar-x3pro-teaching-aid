import test from "node:test";
import assert from "node:assert/strict";
import { resolveDisplayDecision } from "../public/js/render.js";

// 显示层安全状态使用最小帧夹具，避免把 Canvas 或浏览器环境带入纯逻辑测试。
const liveFrame = {
  decision: { action: "forward", reason: "前方安全", triggeredRule: "front-clear" },
};

test("没有完整扫描时不生成运动建议", () => {
  assert.equal(resolveDisplayDecision(null), null);
});

test("数据过期时强制停止而不是沿用前进建议", () => {
  const decision = resolveDisplayDecision(liveFrame, { stale: true });
  assert.equal(decision.action, "stop");
  assert.match(decision.reason, /超过 500ms/);
});

test("扫描暂停时强制停止而不是沿用前进建议", () => {
  const decision = resolveDisplayDecision(liveFrame, { paused: true });
  assert.equal(decision.action, "stop");
  assert.match(decision.reason, /停止扫描/);
});

test("实时数据保持最新一圈的避障建议", () => {
  assert.equal(resolveDisplayDecision(liveFrame), liveFrame.decision);
});
