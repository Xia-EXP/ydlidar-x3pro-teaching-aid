import test from "node:test";
import assert from "node:assert/strict";
import {
  ExperimentalMapper,
  GlobalOccupancyGrid,
  composePose,
  estimateScanMatch,
  transformPointToLocal,
  transformPointToWorld,
  worldToMapCell,
} from "../public/js/mapping.js";

// 用一组不对称的静态地标生成可重复扫描，避免把算法误测成只会匹配对称墙面。
const LANDMARKS = [
  { xMm: 900, yMm: -1000 },
  { xMm: 1100, yMm: -350 },
  { xMm: 1350, yMm: 500 },
  { xMm: 850, yMm: 900 },
  { xMm: 1650, yMm: -720 },
  { xMm: 1950, yMm: 180 },
  { xMm: 1250, yMm: 1050 },
  { xMm: 700, yMm: -1250 },
  { xMm: 2250, yMm: -950 },
  { xMm: 2450, yMm: 700 },
];

// 把世界地标反变换到某个位姿下的雷达点，输入格式与 analysis.js 的 ScanPoint 兼容。
function scanAtPose(pose, landmarks = LANDMARKS) {
  return landmarks.map((landmark) => {
    const local = transformPointToLocal(landmark, pose);
    const distanceMm = Math.hypot(local.xMm, local.yMm);
    return {
      ...local,
      distanceMm,
      angleDeg: (Math.atan2(local.yMm, local.xMm) * 180) / Math.PI,
      valid: true,
    };
  });
}

// 测试用配置缩小地图和搜索范围，让测试快速运行，同时保留真实算法的相对关系。
const MATCH_CONFIG = {
  mapSizeMm: 6000,
  resolutionMm: 100,
  maxMatchPoints: 100,
  maxTranslationMm: 300,
  maxRotationDeg: 20,
  coarseTranslationMm: 50,
  coarseRotationDeg: 2,
  refineTranslationMm: 10,
  refineRotationDeg: 0.5,
  refineRounds: 2,
  maxMatchDistanceMm: 80,
  minInliers: 5,
  minInlierRatio: 0.5,
  maxRmseMm: 80,
  maxPathLength: 5,
  pathMinTranslationMm: 0,
  pathMinRotationDeg: 0,
};

test("坐标变换遵守 x 向前、y 向左和 theta 逆时针约定", () => {
  const world = transformPointToWorld({ xMm: 1000, yMm: 0 }, { xMm: 0, yMm: 0, thetaDeg: 0 });
  assert.deepEqual(world, { xMm: 1000, yMm: 0 });
  const local = transformPointToLocal({ xMm: 0, yMm: 1000 }, { xMm: 0, yMm: 0, thetaDeg: 90 });
  assert.ok(Math.abs(local.xMm - 1000) < 1e-9);
  assert.ok(Math.abs(local.yMm) < 1e-9);
  const composed = composePose({ xMm: 100, yMm: 0, thetaDeg: 90 }, { xMm: 100, yMm: 0, thetaDeg: 0 });
  assert.ok(Math.abs(composed.xMm - 100) < 1e-9);
  assert.ok(Math.abs(composed.yMm - 100) < 1e-9);
});

test("相邻静态扫描匹配为零运动且相同时间戳不重复累计", () => {
  const mapper = new ExperimentalMapper(MATCH_CONFIG);
  const frame = { timestamp: 100, points: scanAtPose({ xMm: 0, yMm: 0, thetaDeg: 0 }) };
  const first = mapper.processFrame(frame);
  assert.equal(first.mode, "tracking");
  const revision = first.revision;
  const duplicate = mapper.processFrame(frame);
  assert.equal(duplicate.revision, revision);
  const second = mapper.processFrame({ timestamp: 200, points: frame.points });
  assert.equal(second.match.accepted, true);
  assert.ok(Math.abs(second.pose.xMm) <= 10);
  assert.ok(Math.abs(second.pose.yMm) <= 10);
  assert.ok(Math.abs(second.pose.thetaDeg) <= 1);
});

test("平移地标扫描可估计相邻位姿并累积全局 pose", () => {
  const mapper = new ExperimentalMapper(MATCH_CONFIG);
  mapper.processFrame({ timestamp: 100, points: scanAtPose({ xMm: 0, yMm: 0, thetaDeg: 0 }) });
  const moved = mapper.processFrame({
    timestamp: 200,
    points: scanAtPose({ xMm: 120, yMm: -60, thetaDeg: 0 }),
  });
  assert.equal(moved.match.accepted, true);
  assert.ok(Math.abs(moved.pose.xMm - 120) <= 20, `x=${moved.pose.xMm}`);
  assert.ok(Math.abs(moved.pose.yMm + 60) <= 20, `y=${moved.pose.yMm}`);
});

test("旋转地标扫描可估计逆时针角度而不改变错误方向", () => {
  const mapper = new ExperimentalMapper(MATCH_CONFIG);
  mapper.processFrame({ timestamp: 100, points: scanAtPose({ xMm: 0, yMm: 0, thetaDeg: 0 }) });
  const rotated = mapper.processFrame({
    timestamp: 200,
    points: scanAtPose({ xMm: 0, yMm: 0, thetaDeg: 8 }),
  });
  assert.equal(rotated.match.accepted, true);
  assert.ok(Math.abs(rotated.pose.thetaDeg - 8) <= 1.5, `theta=${rotated.pose.thetaDeg}`);
});

test("无关扫描匹配失败时保持旧位姿和旧地图，不发生跳变", () => {
  const mapper = new ExperimentalMapper(MATCH_CONFIG);
  mapper.processFrame({ timestamp: 100, points: scanAtPose({ xMm: 0, yMm: 0, thetaDeg: 0 }) });
  const before = mapper.snapshot();
  const unrelated = scanAtPose({ xMm: 0, yMm: 0, thetaDeg: 0 }, LANDMARKS.map((point) => ({
    xMm: point.xMm + 5000,
    yMm: point.yMm + 5000,
  })));
  const after = mapper.processFrame({ timestamp: 200, points: unrelated });
  assert.equal(after.mode, "lost");
  assert.equal(after.match.accepted, false);
  assert.deepEqual(after.pose, before.pose);
  assert.equal(after.revision, before.revision);
});

test("全局栅格射线中间为空闲、终点为占据且越界不会扩容", () => {
  const grid = new GlobalOccupancyGrid({ mapSizeMm: 2000, resolutionMm: 100 });
  const pose = { xMm: 0, yMm: 0, thetaDeg: 0 };
  const snapshot = grid.updateScan([{ xMm: 500, yMm: 0, valid: true }], pose, 100);
  const middle = worldToMapCell(200, 0, snapshot);
  const endpoint = worldToMapCell(500, 0, snapshot);
  assert.ok(snapshot.scores[middle.index] < 0);
  assert.ok(snapshot.scores[endpoint.index] > 0);
  const width = snapshot.width;
  const outside = grid.updateScan([{ xMm: 5000, yMm: 0, valid: true }], pose, 200);
  assert.equal(outside.width, width);
  assert.equal(outside.height, width);
  assert.equal(outside.scores.length, width * width);
});

test("独立 scan matcher 在低重叠时返回低置信而不是伪造位姿", () => {
  const previous = scanAtPose({ xMm: 0, yMm: 0, thetaDeg: 0 });
  const current = scanAtPose({ xMm: 0, yMm: 0, thetaDeg: 0 }, LANDMARKS.map((point) => ({
    xMm: point.xMm + 4500,
    yMm: point.yMm - 3500,
  })));
  const result = estimateScanMatch(previous, current, MATCH_CONFIG);
  assert.equal(result.accepted, false);
  assert.equal(result.delta.xMm, 0);
  assert.equal(result.delta.yMm, 0);
});

test("暂停保留地图和位姿，恢复后以新帧重新建立匹配参考", () => {
  const mapper = new ExperimentalMapper(MATCH_CONFIG);
  mapper.processFrame({ timestamp: 100, points: scanAtPose({ xMm: 0, yMm: 0, thetaDeg: 0 }) });
  const before = mapper.snapshot();
  mapper.pause();
  const paused = mapper.processFrame({ timestamp: 200, points: scanAtPose({ xMm: 200, yMm: 0, thetaDeg: 0 }) });
  assert.equal(paused.mode, "paused");
  assert.deepEqual(paused.pose, before.pose);
  assert.equal(paused.revision, before.revision);
  mapper.resume();
  const resumed = mapper.processFrame({ timestamp: 300, points: scanAtPose({ xMm: 200, yMm: 0, thetaDeg: 0 }) });
  assert.equal(resumed.mode, "tracking");
  assert.deepEqual(resumed.pose, before.pose);
});

test("清空会清除地图、路径和参考帧，路径容量固定不增长", () => {
  const mapper = new ExperimentalMapper(MATCH_CONFIG);
  const frame = scanAtPose({ xMm: 0, yMm: 0, thetaDeg: 0 });
  for (let index = 0; index < 20; index += 1) {
    mapper.processFrame({ timestamp: 100 + index, points: frame });
  }
  const beforeClear = mapper.snapshot();
  assert.equal(beforeClear.path.length, MATCH_CONFIG.maxPathLength);
  assert.equal(beforeClear.scores.length, beforeClear.width * beforeClear.height);
  const cleared = mapper.clear();
  assert.equal(cleared.path.length, 0);
  assert.equal(cleared.occupiedCount, 0);
  assert.equal(cleared.freeCount, 0);
  assert.equal(cleared.mode, "ready");
});

