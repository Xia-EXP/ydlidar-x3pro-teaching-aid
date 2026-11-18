import test from "node:test";
import assert from "node:assert/strict";
import {
  analyzeScan,
  calculateSectorStats,
  clusterScanPoints,
  decideAvoidance,
  polarToCartesian,
  transformScanPoints,
} from "../public/js/analysis.js";

// 生成不依赖协议角度修正的教学点，专门验证坐标和几何算法。
function point(angleDeg, distanceMm, valid = true) {
  return { angleDeg, distanceMm, valid };
}

test("极坐标转换遵守 0°向前、正角向左", () => {
  assert.deepEqual(polarToCartesian(0, 1000), { xMm: 1000, yMm: 0 });
  const left = polarToCartesian(90, 1000);
  assert.ok(Math.abs(left.xMm) < 1e-9);
  assert.equal(left.yMm, 1000);
});

test("无效距离被过滤，偏移和反向只影响分析坐标", () => {
  const transformed = transformScanPoints([
    point(0, 1000),
    point(90, 0, false),
    point(45, 9000),
    point(30, Number.NaN),
  ], { angleOffsetDeg: 10, invertDirection: true });
  assert.equal(transformed[0].angleDeg, 10);
  assert.equal(transformed[0].valid, true);
  assert.equal(transformed[1].valid, false);
  assert.equal(transformed[2].valid, false);
  assert.equal(transformed[3].valid, false);
});

test("相邻点聚类并合并跨 0° 的首尾点", () => {
  const points = transformScanPoints([
    point(359, 1000),
    point(359.5, 1050),
    point(0.5, 1050),
    point(1, 3000),
    point(90, 3000),
  ]);
  const clusters = clusterScanPoints(points, { clusterGapMm: 120, minClusterPoints: 2 });
  assert.equal(clusters.length, 1);
  assert.equal(clusters[0].pointCount, 3);
  assert.ok(clusters[0].nearestDistanceMm <= 1000);
  assert.ok(Number.isFinite(clusters[0].centroid.xMm));
});

test("前方清晰时给出前进建议", () => {
  const points = transformScanPoints([
    point(-10, 1800), point(0, 1900), point(10, 1800),
    point(-60, 1600), point(60, 1600),
  ]);
  const sectors = calculateSectorStats(points, { minHits: 2 });
  const decision = decideAvoidance(sectors, { minHits: 2 });
  assert.equal(decision.action, "forward");
});

test("前方受阻且左侧更开阔时建议左转", () => {
  const points = transformScanPoints([
    point(-10, 300), point(0, 350), point(10, 400),
    point(60, 1800), point(70, 1900),
    point(-60, 700), point(-70, 750),
  ]);
  const sectors = calculateSectorStats(points, { minHits: 2 });
  const decision = decideAvoidance(sectors, { minHits: 2 });
  assert.equal(decision.action, "turn-left");
});

test("前方受阻且右侧更开阔时建议右转", () => {
  const points = transformScanPoints([
    point(-10, 300), point(0, 350), point(10, 400),
    point(60, 700), point(70, 750),
    point(-60, 1800), point(-70, 1900),
  ]);
  const sectors = calculateSectorStats(points, { minHits: 2 });
  const decision = decideAvoidance(sectors, { minHits: 2 });
  assert.equal(decision.action, "turn-right");
});

test("前方受阻且左右清距接近时停止等待更高层决策", () => {
  const points = transformScanPoints([
    point(-10, 300), point(0, 350), point(10, 400),
    point(60, 1500), point(70, 1500),
    point(-60, 1500), point(-70, 1500),
  ]);
  const sectors = calculateSectorStats(points, { minHits: 2 });
  const decision = decideAvoidance(sectors, { minHits: 2 });
  assert.equal(decision.action, "stop");
  assert.equal(decision.triggeredRule, "front-blocked-side-clearance-tie");
});

test("前方受阻但侧面无数据时停止而不是假设通道开阔", () => {
  const points = transformScanPoints([
    point(-10, 300), point(0, 350), point(10, 400),
  ]);
  const sectors = calculateSectorStats(points, { minHits: 2 });
  const decision = decideAvoidance(sectors, { minHits: 2 });
  assert.equal(decision.action, "stop");
  assert.equal(decision.triggeredRule, "front-caution-incomplete-side-data");
});

test("前方和两侧都受阻时停止", () => {
  const points = transformScanPoints([
    point(-10, 300), point(0, 350), point(10, 400),
    point(60, 500), point(70, 550),
    point(-60, 500), point(-70, 550),
  ]);
  const sectors = calculateSectorStats(points, { minHits: 2 });
  const decision = decideAvoidance(sectors, { minHits: 2 });
  assert.equal(decision.action, "stop");
});

test("单个前方离群点不触发停止", () => {
  const points = transformScanPoints([
    point(-10, 1800), point(0, 100), point(10, 1800),
    point(-60, 1600), point(60, 1600),
  ]);
  const sectors = calculateSectorStats(points, { minHits: 2 });
  const decision = decideAvoidance(sectors, { minHits: 2 });
  assert.equal(decision.action, "forward");
});

test("没有前方数据时使用安全停止状态", () => {
  const decision = decideAvoidance({
    front: { sampleCount: 0, clearanceMm: Infinity, closeCount: 0 },
    left: { sampleCount: 0, clearanceMm: Infinity, closeCount: 0 },
    right: { sampleCount: 0, clearanceMm: Infinity, closeCount: 0 },
  });
  assert.equal(decision.action, "stop");
  assert.equal(decision.triggeredRule, "no-front-data");
});

test("完整分析结果包含簇、扇区和决策", () => {
  const result = analyzeScan({
    timestamp: 123,
    scanHz: 6,
    packetCount: 2,
    points: [point(0, 1000), point(1, 1010), point(-1, 990)],
  }, { minClusterPoints: 2 });
  assert.equal(result.validCount, 3);
  assert.equal(result.clusters.length, 1);
  assert.ok(result.decision.action);
});
