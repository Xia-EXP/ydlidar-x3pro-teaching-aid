import { normalizeAngle } from "./protocol.js";

// 这些参数同时服务于课堂实验和默认避障演示，界面可以实时覆盖它们。
export const DEFAULT_ANALYSIS_SETTINGS = Object.freeze({
  maxRangeMm: 8000,
  minRangeMm: 100,
  angleOffsetDeg: 0,
  invertDirection: false,
  clusterGapMm: 180,
  minClusterPoints: 3,
  stopDistanceMm: 450,
  turnDistanceMm: 800,
  minHits: 3,
  frontHalfAngleDeg: 25,
  sideLimitAngleDeg: 110,
  tieMarginMm: 50,
});

// 将角度改写为 [-180, 180)，方便用正负号表达左侧和右侧扇区。
export function toSignedAngle(angleDeg) {
  const normalized = normalizeAngle(angleDeg);
  return normalized > 180 ? normalized - 360 : normalized;
}

// 把极坐标点转换成雷达坐标系：x 向前，y 向左，单位保持为毫米。
export function polarToCartesian(angleDeg, distanceMm) {
  const radians = (angleDeg * Math.PI) / 180;
  return {
    xMm: distanceMm * Math.cos(radians),
    yMm: distanceMm * Math.sin(radians),
  };
}

// 计算一组数值的低分位数，避免单个离群点直接决定避障动作。
export function percentile(values, fraction) {
  if (!values.length) return Number.POSITIVE_INFINITY;
  const sorted = [...values].sort((left, right) => left - right);
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(fraction * sorted.length) - 1));
  return sorted[index];
}

// 计算二维点之间的距离，聚类阶段用它判断相邻回波是否属于同一物体。
function pointDistance(left, right) {
  return Math.hypot(left.xMm - right.xMm, left.yMm - right.yMm);
}

// 给原始扫描点补上校准后的角度、笛卡尔坐标和有效性标记。
export function transformScanPoints(rawPoints, inputSettings = {}) {
  const settings = { ...DEFAULT_ANALYSIS_SETTINGS, ...inputSettings };
  return rawPoints.map((rawPoint, index) => {
    const signedAngle = settings.invertDirection ? -rawPoint.angleDeg : rawPoint.angleDeg;
    const angleDeg = normalizeAngle(signedAngle + settings.angleOffsetDeg);
    const distanceMm = Number(rawPoint.distanceMm);
    const valid = Boolean(rawPoint.valid)
      && Number.isFinite(distanceMm)
      && distanceMm >= settings.minRangeMm
      && distanceMm <= settings.maxRangeMm;
    const coordinates = polarToCartesian(angleDeg, distanceMm);
    return {
      ...rawPoint,
      index,
      angleDeg,
      distanceMm,
      xMm: coordinates.xMm,
      yMm: coordinates.yMm,
      valid,
    };
  });
}

// 将一圈扫描分成几何相邻的障碍物簇，并合并跨越 0° 的首尾簇。
export function clusterScanPoints(points, inputSettings = {}) {
  const settings = { ...DEFAULT_ANALYSIS_SETTINGS, ...inputSettings };
  const sorted = points.filter((point) => point.valid).sort((left, right) => left.angleDeg - right.angleDeg);
  if (!sorted.length) return [];

  const rawClusters = [];
  let current = [sorted[0]];
  for (let index = 1; index < sorted.length; index += 1) {
    const previous = sorted[index - 1];
    const point = sorted[index];
    if (pointDistance(previous, point) <= settings.clusterGapMm) {
      current.push(point);
    } else {
      rawClusters.push(current);
      current = [point];
    }
  }
  rawClusters.push(current);

  // 角度排序把 359° 和 1° 放在两端，因此额外检查两个簇是否实际相邻。
  if (rawClusters.length > 1) {
    const first = rawClusters[0][0];
    const last = rawClusters.at(-1).at(-1);
    if (pointDistance(first, last) <= settings.clusterGapMm) {
      rawClusters[0] = [...rawClusters.at(-1), ...rawClusters[0]];
      rawClusters.pop();
    }
  }

  return rawClusters
    .filter((cluster) => cluster.length >= settings.minClusterPoints)
    .map((cluster, id) => {
      const nearestPoint = cluster.reduce((nearest, point) => (
        point.distanceMm < nearest.distanceMm ? point : nearest
      ));
      const centroid = cluster.reduce(
        (sum, point) => ({ xMm: sum.xMm + point.xMm, yMm: sum.yMm + point.yMm }),
        { xMm: 0, yMm: 0 },
      );
      centroid.xMm /= cluster.length;
      centroid.yMm /= cluster.length;
      const xValues = cluster.map((point) => point.xMm);
      const yValues = cluster.map((point) => point.yMm);
      const widthMm = Math.hypot(Math.max(...xValues) - Math.min(...xValues), Math.max(...yValues) - Math.min(...yValues));
      return {
        id: id + 1,
        pointCount: cluster.length,
        points: cluster,
        nearestDistanceMm: nearestPoint.distanceMm,
        centroid,
        widthMm,
        angleStartDeg: cluster[0].angleDeg,
        angleEndDeg: cluster.at(-1).angleDeg,
      };
    });
}

// 计算前方、左侧、右侧扇区的稳健距离和近距离命中数量。
export function calculateSectorStats(points, inputSettings = {}) {
  const settings = { ...DEFAULT_ANALYSIS_SETTINGS, ...inputSettings };
  const sectorValues = { front: [], left: [], right: [] };
  for (const point of points) {
    if (!point.valid) continue;
    const signedAngle = toSignedAngle(point.angleDeg);
    if (Math.abs(signedAngle) <= settings.frontHalfAngleDeg) {
      sectorValues.front.push(point.distanceMm);
    } else if (signedAngle > settings.frontHalfAngleDeg && signedAngle <= settings.sideLimitAngleDeg) {
      sectorValues.left.push(point.distanceMm);
    } else if (signedAngle < -settings.frontHalfAngleDeg && signedAngle >= -settings.sideLimitAngleDeg) {
      sectorValues.right.push(point.distanceMm);
    }
  }

  const makeSector = (values) => ({
    sampleCount: values.length,
    clearanceMm: percentile(values, 0.1),
    closeCount: values.filter((distance) => distance <= settings.turnDistanceMm).length,
  });
  return {
    front: makeSector(sectorValues.front),
    left: makeSector(sectorValues.left),
    right: makeSector(sectorValues.right),
  };
}

// 根据扇区安全距离生成可解释的教学决策，不向任何机器人控制接口发送数据。
export function decideAvoidance(sectors, inputSettings = {}) {
  const settings = { ...DEFAULT_ANALYSIS_SETTINGS, ...inputSettings };
  const { front, left, right } = sectors;
  const hasEnoughFrontHits = front.closeCount >= settings.minHits;
  const frontBlocked = hasEnoughFrontHits && front.clearanceMm <= settings.stopDistanceMm;
  const frontCaution = hasEnoughFrontHits && front.clearanceMm <= settings.turnDistanceMm;
  const leftOpen = left.sampleCount > 0 && left.clearanceMm > settings.turnDistanceMm;
  const rightOpen = right.sampleCount > 0 && right.clearanceMm > settings.turnDistanceMm;

  if (!front.sampleCount) {
    return {
      action: "stop",
      reason: "前方没有有效测距点，暂不输出运动建议",
      triggeredRule: "no-front-data",
      frontClearance: front.clearanceMm,
      leftClearance: left.clearanceMm,
      rightClearance: right.clearanceMm,
    };
  }

  // 前方已经阻挡时，任一侧完全没有测距数据都不能被误称为安全通道。
  if (frontCaution && (!left.sampleCount || !right.sampleCount)) {
    return {
      action: "stop",
      reason: "前方距离不足且左右扇区数据不完整，保持停止等待有效测距",
      triggeredRule: "front-caution-incomplete-side-data",
      frontClearance: front.clearanceMm,
      leftClearance: left.clearanceMm,
      rightClearance: right.clearanceMm,
    };
  }

  if (frontBlocked && !leftOpen && !rightOpen) {
    return {
      action: "stop",
      reason: "前方低于停止距离，左右两侧也没有足够空间",
      triggeredRule: "front-stop-and-both-sides-blocked",
      frontClearance: front.clearanceMm,
      leftClearance: left.clearanceMm,
      rightClearance: right.clearanceMm,
    };
  }

  // 两侧都能走但空间几乎相等时不擅自选择方向，给学生展示需要人工决策的边界。
  if (frontBlocked && leftOpen && rightOpen && Math.abs(left.clearanceMm - right.clearanceMm) <= settings.tieMarginMm) {
    return {
      action: "stop",
      reason: "前方受阻且左右空间接近，保持停止等待更高层决策",
      triggeredRule: "front-blocked-side-clearance-tie",
      frontClearance: front.clearanceMm,
      leftClearance: left.clearanceMm,
      rightClearance: right.clearanceMm,
    };
  }

  if (frontBlocked || frontCaution) {
    const action = left.clearanceMm >= right.clearanceMm ? "turn-left" : "turn-right";
    return {
      action,
      reason: `前方距离 ${Math.round(front.clearanceMm)} mm，选择${action === "turn-left" ? "左侧" : "右侧"}较开阔方向`,
      triggeredRule: frontBlocked ? "front-stop-turn-to-open-side" : "front-caution-turn-to-open-side",
      frontClearance: front.clearanceMm,
      leftClearance: left.clearanceMm,
      rightClearance: right.clearanceMm,
    };
  }

  return {
    action: "forward",
    reason: `前方距离 ${Math.round(front.clearanceMm)} mm，高于转向阈值`,
    triggeredRule: "front-clear",
    frontClearance: front.clearanceMm,
    leftClearance: left.clearanceMm,
    rightClearance: right.clearanceMm,
  };
}

// 将协议层的原始一圈封装成界面可直接消费的完整分析结果。
export function analyzeScan(rawFrame, inputSettings = {}) {
  const settings = { ...DEFAULT_ANALYSIS_SETTINGS, ...inputSettings };
  const points = transformScanPoints(rawFrame.points, settings);
  const clusters = clusterScanPoints(points, settings);
  const sectors = calculateSectorStats(points, settings);
  const decision = decideAvoidance(sectors, settings);
  return {
    ...rawFrame,
    points,
    validCount: points.filter((point) => point.valid).length,
    clusters,
    sectors,
    decision,
  };
}
