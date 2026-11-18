import test from "node:test";
import assert from "node:assert/strict";
import {
  DEFAULT_OCCUPANCY_CONFIG,
  LocalOccupancyGrid,
  worldToGridCell,
} from "../public/js/occupancy.js";

// 构造分析层已经补全坐标的扫描点，测试只关注局部栅格的证据语义。
function point(xMm, yMm, valid = true) {
  return {
    xMm,
    yMm,
    distanceMm: Math.hypot(xMm, yMm),
    valid,
  };
}

function scoreAt(snapshot, xMm, yMm) {
  const cell = worldToGridCell(xMm, yMm, snapshot);
  assert.equal(cell.inBounds, true);
  return snapshot.scores[cell.index];
}

test("默认配置生成 321×321 的固定 Int8 栅格", () => {
  const grid = new LocalOccupancyGrid();
  const snapshot = grid.snapshot(0);
  assert.equal(DEFAULT_OCCUPANCY_CONFIG.resolutionMm, 50);
  assert.equal(snapshot.width, 321);
  assert.equal(snapshot.height, 321);
  assert.equal(snapshot.originRow, 160);
  assert.equal(snapshot.originColumn, 160);
  assert.ok(snapshot.scores instanceof Int8Array);
  assert.equal(snapshot.scores.length, 321 * 321);
});

test("坐标映射让 0°朝上且正 90°朝左", () => {
  const geometry = {
    resolutionMm: 50,
    originRow: 20,
    originColumn: 20,
    width: 41,
    height: 41,
  };
  const forward = worldToGridCell(1000, 0, geometry);
  const left = worldToGridCell(0, 1000, geometry);
  assert.equal(forward.row, 0);
  assert.equal(forward.column, 20);
  assert.equal(left.row, 20);
  assert.equal(left.column, 0);
});

test("射线中间为空闲、回波终点为占据、旁侧保持未知", () => {
  const grid = new LocalOccupancyGrid({ resolutionMm: 100, maxRangeMm: 1000 });
  const snapshot = grid.update({ timestamp: 100, points: [point(500, 0)] });
  assert.ok(scoreAt(snapshot, 200, 0) < 0);
  assert.ok(scoreAt(snapshot, 500, 0) > 0);
  assert.equal(scoreAt(snapshot, 0, 500), 0);
  assert.ok(snapshot.freeCount > 0);
  assert.equal(snapshot.occupiedCount, 1);
});

test("同圈回波终点优先于穿过该格的空闲射线", () => {
  const grid = new LocalOccupancyGrid({ resolutionMm: 100, maxRangeMm: 1500 });
  const snapshot = grid.update({
    timestamp: 100,
    points: [point(500, 0), point(1000, 0)],
  });
  assert.equal(scoreAt(snapshot, 500, 0), 4);
  assert.equal(scoreAt(snapshot, 1000, 0), 4);
});

test("重复静态扫描增强证据并在配置上下限处饱和", () => {
  const grid = new LocalOccupancyGrid({ resolutionMm: 100, maxRangeMm: 1000, persistenceMs: 10_000 });
  for (let frame = 0; frame < 30; frame += 1) {
    grid.update({ timestamp: frame, points: [point(500, 0)] });
  }
  const snapshot = grid.snapshot(29);
  assert.equal(scoreAt(snapshot, 500, 0), 20);
  assert.equal(scoreAt(snapshot, 200, 0), -20);
});

test("相同完整帧时间戳不会因参数重算而重复累计", () => {
  const grid = new LocalOccupancyGrid({ resolutionMm: 100, maxRangeMm: 1000 });
  const frame = { timestamp: 100, points: [point(500, 0)] };
  grid.update(frame);
  const revision = grid.revision;
  const second = grid.update(frame);
  assert.equal(scoreAt(second, 500, 0), 4);
  assert.equal(grid.revision, revision);
});

test("证据在保存期内阶梯渐隐并在到期后恢复未知", () => {
  const grid = new LocalOccupancyGrid({ resolutionMm: 100, maxRangeMm: 1000, persistenceMs: 2000 });
  grid.update({ timestamp: 100, points: [point(500, 0)] });
  assert.equal(scoreAt(grid.snapshot(1100), 500, 0), 2);
  const expired = grid.snapshot(2100);
  assert.equal(scoreAt(expired, 500, 0), 0);
  assert.equal(expired.occupiedCount, 0);
});

test("超出局部图的回波会裁剪为空闲射线且不会在边界制造假障碍", () => {
  const grid = new LocalOccupancyGrid({ resolutionMm: 100, maxRangeMm: 1000 });
  const snapshot = grid.update({ timestamp: 100, points: [point(5000, 0)] });
  assert.ok(scoreAt(snapshot, 1000, 0) < 0);
  assert.equal(snapshot.occupiedCount, 0);
});

test("快照复用固定缓存，运行时间不会增加栅格容量", () => {
  const grid = new LocalOccupancyGrid({ resolutionMm: 100, maxRangeMm: 1000 });
  const first = grid.snapshot(0);
  const scoresBuffer = first.scores.buffer;
  const observedBuffer = first.lastObservedAt.buffer;
  for (let frame = 1; frame <= 100; frame += 1) {
    grid.update({ timestamp: frame, points: [point(500, frame % 2 ? 100 : -100)] });
  }
  const last = grid.snapshot(100);
  assert.equal(last.scores.buffer, scoresBuffer);
  assert.equal(last.lastObservedAt.buffer, observedBuffer);
  assert.equal(last.scores.length, first.width * first.height);
});

test("清空和几何配置变化都会移除旧证据", () => {
  const grid = new LocalOccupancyGrid({ resolutionMm: 100, maxRangeMm: 1000 });
  grid.update({ timestamp: 100, points: [point(500, 0)] });
  grid.clear();
  assert.equal(grid.snapshot(100).occupiedCount, 0);

  grid.update({ timestamp: 100, points: [point(500, 0)] });
  const wasReallocated = grid.configure({ resolutionMm: 200 });
  const snapshot = grid.snapshot(100);
  assert.equal(wasReallocated, true);
  assert.equal(snapshot.occupiedCount, 0);
  assert.equal(snapshot.width, 11);
});

test("无效点不推断为空闲或占据", () => {
  const grid = new LocalOccupancyGrid({ resolutionMm: 100, maxRangeMm: 1000 });
  const snapshot = grid.update({ timestamp: 100, points: [point(500, 0, false)] });
  assert.equal(snapshot.freeCount, 0);
  assert.equal(snapshot.occupiedCount, 0);
});
