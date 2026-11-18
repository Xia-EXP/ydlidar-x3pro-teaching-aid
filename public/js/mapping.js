// 实验性单雷达建图核心：用相邻扫描的几何匹配估计相对位姿，再把点投影到固定大小的栅格。
// 这里没有里程计、IMU、回环检测或全局优化，因此只能用于教学演示，不能称为完整 SLAM。

export const DEFAULT_MAPPING_CONFIG = Object.freeze({
  // 地图每个格子的边长；分辨率越小细节越多，但固定内存中的覆盖范围会缩小。
  resolutionMm: 100,
  // 地图以首次雷达位置为中心的单边物理尺寸，确保数组大小固定。
  mapSizeMm: 20_000,
  // 匹配时最多保留的点数，避免高频串口下计算量随设备点数无限上升。
  maxMatchPoints: 160,
  // 相邻帧允许的最大平移和旋转；超出范围应重新初始化，而不是硬猜位姿。
  maxTranslationMm: 500,
  maxRotationDeg: 25,
  // 粗搜索步长先找候选盆地，随后用细搜索降低量化误差。
  coarseTranslationMm: 100,
  coarseRotationDeg: 5,
  refineTranslationMm: 25,
  refineRotationDeg: 1,
  refineRounds: 2,
  // 最近邻误差阈值和最低匹配质量，用于阻止无关帧造成位姿跳变。
  maxMatchDistanceMm: 220,
  minInliers: 8,
  minInlierRatio: 0.25,
  maxRmseMm: 180,
  // 建图射线的证据增量和饱和值；这是教学证据，不是概率。
  freeDelta: -1,
  occupiedDelta: 3,
  minScore: -20,
  maxScore: 20,
  // 路径采用环形缓存，防止长时间演示导致数组无限增长。
  maxPathLength: 2000,
  // 每次追加路径至少移动该距离或该角度，减少静止扫描的重复轨迹点。
  pathMinTranslationMm: 10,
  pathMinRotationDeg: 1,
});

const MAX_MAP_CELLS = 1_048_576;
const MARK_FREE = 1;
const MARK_OCCUPIED = 2;

// 采用远离零点的对称取整，使地图左右两侧在半格边界拥有一致的量化规则。
function roundSymmetric(value) {
  return Math.sign(value) * Math.floor(Math.abs(value) + 0.5);
}

// 把角度标准化到 [-180, 180)，让旋转误差和路径显示不发生 360°跳变。
export function normalizeHeadingDeg(angleDeg) {
  return ((Number(angleDeg) + 180) % 360 + 360) % 360 - 180;
}

// 用统一结构表示雷达在初始地图坐标系中的姿态：平移单位为毫米，角度为逆时针度数。
export function normalizePose(pose = {}) {
  const xMm = Number(pose.xMm ?? 0);
  const yMm = Number(pose.yMm ?? 0);
  const thetaDeg = Number(pose.thetaDeg ?? 0);
  if (![xMm, yMm, thetaDeg].every(Number.isFinite)) {
    throw new TypeError("位姿必须包含有限的 xMm、yMm、thetaDeg");
  }
  return { xMm, yMm, thetaDeg: normalizeHeadingDeg(thetaDeg) };
}

// SE(2) 合成：delta 表示“当前雷达坐标到上一帧坐标”的变换，再旋转到全局坐标后相加。
export function composePose(basePose, deltaPose) {
  const base = normalizePose(basePose);
  const delta = normalizePose(deltaPose);
  const radians = (base.thetaDeg * Math.PI) / 180;
  return normalizePose({
    xMm: base.xMm + Math.cos(radians) * delta.xMm - Math.sin(radians) * delta.yMm,
    yMm: base.yMm + Math.sin(radians) * delta.xMm + Math.cos(radians) * delta.yMm,
    thetaDeg: base.thetaDeg + delta.thetaDeg,
  });
}

// 把当前雷达坐标中的点转换到地图坐标，供建图射线和课堂坐标演示复用。
export function transformPointToWorld(point, pose) {
  const normalizedPose = normalizePose(pose);
  const xMm = Number(point?.xMm);
  const yMm = Number(point?.yMm);
  if (![xMm, yMm].every(Number.isFinite)) return null;
  const radians = (normalizedPose.thetaDeg * Math.PI) / 180;
  return {
    xMm: normalizedPose.xMm + Math.cos(radians) * xMm - Math.sin(radians) * yMm,
    yMm: normalizedPose.yMm + Math.sin(radians) * xMm + Math.cos(radians) * yMm,
  };
}

// 把世界点转换回雷达坐标，测试夹具和后续教学示例可用它生成可控扫描。
export function transformPointToLocal(point, pose) {
  const normalizedPose = normalizePose(pose);
  const dx = Number(point?.xMm) - normalizedPose.xMm;
  const dy = Number(point?.yMm) - normalizedPose.yMm;
  if (![dx, dy].every(Number.isFinite)) return null;
  const radians = (-normalizedPose.thetaDeg * Math.PI) / 180;
  return {
    xMm: Math.cos(radians) * dx - Math.sin(radians) * dy,
    yMm: Math.sin(radians) * dx + Math.cos(radians) * dy,
  };
}

// 统一读取局部点坐标，让全局栅格既能接收 analysis.js 点，也能直接接收角度/距离点。
function readLocalPoint(point) {
  if (point?.valid !== true) return null;
  let xMm = Number(point.xMm);
  let yMm = Number(point.yMm);
  if (!Number.isFinite(xMm) || !Number.isFinite(yMm)) {
    const angleDeg = Number(point.angleDeg);
    const distanceMm = Number(point.distanceMm);
    if (!Number.isFinite(angleDeg) || !Number.isFinite(distanceMm) || distanceMm <= 0) return null;
    const radians = (angleDeg * Math.PI) / 180;
    xMm = Math.cos(radians) * distanceMm;
    yMm = Math.sin(radians) * distanceMm;
  }
  if (![xMm, yMm].every(Number.isFinite) || Math.hypot(xMm, yMm) <= 1) return null;
  return { xMm, yMm };
}

// 校验并合并匹配/栅格配置，主动拒绝会造成无穷搜索或超大数组的参数。
function normalizeMappingConfig(input = {}) {
  const config = { ...DEFAULT_MAPPING_CONFIG, ...input };
  const positiveKeys = [
    "resolutionMm", "mapSizeMm", "maxMatchPoints", "maxTranslationMm", "maxRotationDeg",
    "coarseTranslationMm", "coarseRotationDeg", "refineTranslationMm", "refineRotationDeg",
    "maxMatchDistanceMm", "maxRmseMm", "maxPathLength",
  ];
  for (const key of positiveKeys) {
    if (!Number.isFinite(Number(config[key])) || Number(config[key]) <= 0) {
      throw new RangeError(`${key} 必须是大于 0 的有限数值`);
    }
  }
  for (const key of ["maxMatchPoints", "refineRounds", "minInliers", "maxPathLength"]) {
    if (!Number.isInteger(Number(config[key])) || Number(config[key]) < 1) {
      throw new RangeError(`${key} 必须是正整数`);
    }
  }
  for (const key of ["pathMinTranslationMm", "pathMinRotationDeg"]) {
    if (!Number.isFinite(Number(config[key])) || Number(config[key]) < 0) {
      throw new RangeError(`${key} 必须是非负有限数值`);
    }
  }
  if (!Number.isInteger(config.refineRounds) || config.refineRounds < 0) {
    throw new RangeError("refineRounds 必须是非负整数");
  }
  if (!(config.minInlierRatio > 0 && config.minInlierRatio <= 1)) {
    throw new RangeError("minInlierRatio 必须位于 (0, 1] 区间");
  }
  if (!Number.isInteger(config.freeDelta) || config.freeDelta >= 0) {
    throw new RangeError("freeDelta 必须是负整数");
  }
  if (!Number.isInteger(config.occupiedDelta) || config.occupiedDelta <= 0) {
    throw new RangeError("occupiedDelta 必须是正整数");
  }
  if (!Number.isInteger(config.minScore) || !Number.isInteger(config.maxScore)
    || config.minScore >= 0 || config.maxScore <= 0
    || config.minScore < -128 || config.maxScore > 127) {
    throw new RangeError("证据分值必须位于 Int8 范围，且 minScore < 0 < maxScore");
  }
  const halfCells = Math.ceil(config.mapSizeMm / (2 * config.resolutionMm));
  const sideLength = halfCells * 2 + 1;
  if (!Number.isSafeInteger(sideLength) || sideLength * sideLength > MAX_MAP_CELLS) {
    throw new RangeError("地图栅格过大，请提高分辨率或缩小 mapSizeMm");
  }
  return Object.freeze({ ...config, halfCells, sideLength });
}

// 从 ScanFrame 或点数组抽取有效笛卡尔点，兼容分析层已经生成 xMm/yMm 的格式。
export function extractMappingPoints(frameOrPoints, inputConfig = {}) {
  const config = { ...DEFAULT_MAPPING_CONFIG, ...inputConfig };
  const source = Array.isArray(frameOrPoints) ? frameOrPoints : frameOrPoints?.points;
  if (!Array.isArray(source)) throw new TypeError("扫描输入必须是点数组或包含 points 的 ScanFrame");
  const points = [];
  for (const point of source) {
    if (point?.valid !== true) continue;
    let xMm = Number(point.xMm);
    let yMm = Number(point.yMm);
    if (!Number.isFinite(xMm) || !Number.isFinite(yMm)) {
      const angleDeg = Number(point.angleDeg);
      const distanceMm = Number(point.distanceMm);
      if (!Number.isFinite(angleDeg) || !Number.isFinite(distanceMm) || distanceMm <= 0) continue;
      const radians = (angleDeg * Math.PI) / 180;
      xMm = Math.cos(radians) * distanceMm;
      yMm = Math.sin(radians) * distanceMm;
    }
    if (![xMm, yMm].every(Number.isFinite) || Math.hypot(xMm, yMm) <= 1) continue;
    // 保留 valid 标记，使抽样后的内部点集再次进入 matcher 时不会被当成无效点丢弃。
    points.push({ xMm, yMm, valid: true });
  }
  // 均匀抽样而非截取前缀，防止某一角度区域独占匹配输入。
  if (points.length <= config.maxMatchPoints) return points;
  const stride = points.length / config.maxMatchPoints;
  return Array.from({ length: config.maxMatchPoints }, (_, index) => points[Math.floor(index * stride)]);
}

// 为最近邻查询建立固定点集的空间哈希；每个候选只检查邻近格子，降低浏览器端匹配开销。
function buildSpatialIndex(points, cellSizeMm) {
  const index = new Map();
  for (let pointIndex = 0; pointIndex < points.length; pointIndex += 1) {
    const point = points[pointIndex];
    const cellX = Math.floor(point.xMm / cellSizeMm);
    const cellY = Math.floor(point.yMm / cellSizeMm);
    const key = `${cellX},${cellY}`;
    const bucket = index.get(key);
    if (bucket) bucket.push(pointIndex);
    else index.set(key, [pointIndex]);
  }
  return index;
}

// 查询某个候选点在上一帧点云中的最近距离；超出阈值时及时返回，避免无意义计算。
function nearestDistanceSquared(point, previousPoints, spatialIndex, cellSizeMm, thresholdSquared) {
  const cellX = Math.floor(point.xMm / cellSizeMm);
  const cellY = Math.floor(point.yMm / cellSizeMm);
  let best = thresholdSquared;
  for (let offsetX = -1; offsetX <= 1; offsetX += 1) {
    for (let offsetY = -1; offsetY <= 1; offsetY += 1) {
      const bucket = spatialIndex.get(`${cellX + offsetX},${cellY + offsetY}`);
      if (!bucket) continue;
      for (const pointIndex of bucket) {
        const previous = previousPoints[pointIndex];
        const dx = point.xMm - previous.xMm;
        const dy = point.yMm - previous.yMm;
        const distanceSquared = dx * dx + dy * dy;
        if (distanceSquared < best) best = distanceSquared;
      }
    }
  }
  return best;
}

// 评价一个候选相对位姿：优先最大化内点数，再最小化内点均方误差和运动量。
function scoreCandidate(previousPoints, currentPoints, spatialIndex, candidate, config) {
  const radians = (candidate.thetaDeg * Math.PI) / 180;
  const cosine = Math.cos(radians);
  const sine = Math.sin(radians);
  const thresholdSquared = config.maxMatchDistanceMm ** 2;
  let inliers = 0;
  let errorSquared = 0;
  for (const current of currentPoints) {
    const transformed = {
      xMm: cosine * current.xMm - sine * current.yMm + candidate.xMm,
      yMm: sine * current.xMm + cosine * current.yMm + candidate.yMm,
    };
    const distanceSquared = nearestDistanceSquared(
      transformed,
      previousPoints,
      spatialIndex,
      config.maxMatchDistanceMm,
      thresholdSquared,
    );
    if (distanceSquared < thresholdSquared) {
      inliers += 1;
      errorSquared += distanceSquared;
    }
  }
  const denominator = Math.min(previousPoints.length, currentPoints.length);
  const inlierRatio = denominator ? inliers / denominator : 0;
  const rmseMm = inliers ? Math.sqrt(errorSquared / inliers) : Number.POSITIVE_INFINITY;
  const motionMagnitude = Math.hypot(candidate.xMm, candidate.yMm) + Math.abs(candidate.thetaDeg) * 5;
  return {
    ...candidate,
    inliers,
    inlierRatio,
    rmseMm,
    motionMagnitude,
  };
}

// 比较两个候选，明确用质量排序而不是“最后搜索到的结果”，减少扫描顺序造成的漂移。
function isBetterCandidate(candidate, best) {
  if (!best) return true;
  if (candidate.inliers !== best.inliers) return candidate.inliers > best.inliers;
  if (Math.abs(candidate.rmseMm - best.rmseMm) > 1e-6) return candidate.rmseMm < best.rmseMm;
  return candidate.motionMagnitude < best.motionMagnitude;
}

// 在候选范围内进行有限次数的粗到细网格搜索，不使用会随时间增长的历史点缓存。
export function estimateScanMatch(previousInput, currentInput, inputConfig = {}) {
  const config = normalizeMappingConfig(inputConfig);
  const previousPoints = extractMappingPoints(previousInput, config);
  const currentPoints = extractMappingPoints(currentInput, config);
  const emptyResult = (reason) => ({
    accepted: false,
    reason,
    delta: { xMm: 0, yMm: 0, thetaDeg: 0 },
    inliers: 0,
    inlierRatio: 0,
    // ratio/quality 是渲染层的兼容别名，数值统一为 0～1 的匹配置信度。
    ratio: 0,
    quality: 0,
    matchQuality: 0,
    rmseMm: Number.POSITIVE_INFINITY,
    confidence: 0,
    previousCount: previousPoints.length,
    currentCount: currentPoints.length,
    evaluatedCandidates: 0,
  });
  if (previousPoints.length < config.minInliers || currentPoints.length < config.minInliers) {
    return emptyResult("insufficient-points");
  }

  const spatialIndex = buildSpatialIndex(previousPoints, config.maxMatchDistanceMm);
  let best = null;
  let evaluatedCandidates = 0;
  const evaluate = (xMm, yMm, thetaDeg) => {
    const candidate = scoreCandidate(
      previousPoints,
      currentPoints,
      spatialIndex,
      { xMm, yMm, thetaDeg: normalizeHeadingDeg(thetaDeg) },
      config,
    );
    evaluatedCandidates += 1;
    if (isBetterCandidate(candidate, best)) best = candidate;
  };

  // 先覆盖整个允许运动范围，保证小范围运动不会因初值偏差被漏掉。
  for (let theta = -config.maxRotationDeg; theta <= config.maxRotationDeg + 1e-9; theta += config.coarseRotationDeg) {
    for (let xMm = -config.maxTranslationMm; xMm <= config.maxTranslationMm + 1e-9; xMm += config.coarseTranslationMm) {
      for (let yMm = -config.maxTranslationMm; yMm <= config.maxTranslationMm + 1e-9; yMm += config.coarseTranslationMm) {
        // maxTranslationMm 表示平移向量长度上限，而不是两个轴分别放大后的正方形上限。
        if (Math.hypot(xMm, yMm) <= config.maxTranslationMm + 1e-9) evaluate(xMm, yMm, theta);
      }
    }
  }

  // 在粗搜索最佳点附近做有限轮细化，避免高分辨率搜索造成 UI 卡顿。
  let translationStep = config.refineTranslationMm;
  let rotationStep = config.refineRotationDeg;
  for (let round = 0; round < config.refineRounds; round += 1) {
    const center = best;
    if (!center) break;
    for (let theta = center.thetaDeg - rotationStep * 2; theta <= center.thetaDeg + rotationStep * 2 + 1e-9; theta += rotationStep) {
      for (let xMm = center.xMm - translationStep * 2; xMm <= center.xMm + translationStep * 2 + 1e-9; xMm += translationStep) {
        for (let yMm = center.yMm - translationStep * 2; yMm <= center.yMm + translationStep * 2 + 1e-9; yMm += translationStep) {
          if (Math.abs(xMm) <= config.maxTranslationMm + 1e-9
            && Math.abs(yMm) <= config.maxTranslationMm + 1e-9
            && Math.hypot(xMm, yMm) <= config.maxTranslationMm + 1e-9
            && Math.abs(theta) <= config.maxRotationDeg + 1e-9) {
            evaluate(xMm, yMm, theta);
          }
        }
      }
    }
    translationStep /= 2;
    rotationStep /= 2;
  }

  if (!best || best.inliers < config.minInliers || best.inlierRatio < config.minInlierRatio || best.rmseMm > config.maxRmseMm) {
    return {
      ...emptyResult("low-confidence"),
      inliers: best?.inliers ?? 0,
      inlierRatio: best?.inlierRatio ?? 0,
      ratio: 0,
      quality: 0,
      matchQuality: 0,
      rmseMm: best?.rmseMm ?? Number.POSITIVE_INFINITY,
      evaluatedCandidates,
    };
  }
  const confidence = Math.max(0, Math.min(1, best.inlierRatio * Math.exp(-best.rmseMm / Math.max(1, config.maxRmseMm))));
  return {
    accepted: true,
    reason: "matched",
    delta: { xMm: best.xMm, yMm: best.yMm, thetaDeg: normalizeHeadingDeg(best.thetaDeg) },
    inliers: best.inliers,
    inlierRatio: best.inlierRatio,
    ratio: confidence,
    quality: confidence,
    matchQuality: confidence,
    rmseMm: best.rmseMm,
    confidence,
    previousCount: previousPoints.length,
    currentCount: currentPoints.length,
    evaluatedCandidates,
  };
}

// 用世界坐标将毫米位置映射到固定栅格，0°前方对应栅格上方，y 正方向对应左侧。
export function worldToMapCell(xMm, yMm, geometry) {
  const row = geometry.originRow - roundSymmetric(Number(xMm) / geometry.resolutionMm);
  const column = geometry.originColumn - roundSymmetric(Number(yMm) / geometry.resolutionMm);
  const inBounds = row >= 0 && row < geometry.height && column >= 0 && column < geometry.width;
  return { row, column, inBounds, index: inBounds ? row * geometry.width + column : -1 };
}

// Bresenham 只遍历当前射线的有限格子，避免保存每条历史射线导致内存增长。
function traceLine(startColumn, startRow, endColumn, endRow, visit) {
  let column = startColumn;
  let row = startRow;
  const deltaColumn = Math.abs(endColumn - startColumn);
  const stepColumn = startColumn < endColumn ? 1 : -1;
  const deltaRow = -Math.abs(endRow - startRow);
  const stepRow = startRow < endRow ? 1 : -1;
  let error = deltaColumn + deltaRow;
  while (true) {
    const isEnd = column === endColumn && row === endRow;
    visit(column, row, isEnd);
    if (isEnd) return;
    const doubled = error * 2;
    if (doubled >= deltaRow) {
      error += deltaRow;
      column += stepColumn;
    }
    if (doubled <= deltaColumn) {
      error += deltaColumn;
      row += stepRow;
    }
  }
}

// 固定容量全局占据栅格：证据锚定在首次雷达坐标系，移动越出边界会被裁剪而不会扩容。
export class GlobalOccupancyGrid {
  constructor(inputConfig = {}) {
    this.config = normalizeMappingConfig(inputConfig);
    this.revision = 0;
    this.lastTimestamp = 0;
    this.lastFrameTimestamp = null;
    this.#allocate();
  }

  // 只读几何属性便于渲染层将地图快照直接变换到 Canvas。
  get width() { return this.sideLength; }
  get height() { return this.sideLength; }
  get resolutionMm() { return this.config.resolutionMm; }

  // 清空分值但保留固定数组容量，reset 后不会把旧设备或旧位姿证据带入新地图。
  clear() {
    this.scores.fill(0);
    this.snapshotScores.fill(0);
    this.lastObservedAt.fill(0);
    this.frameMarks.fill(0);
    this.touchedIndices.fill(0);
    this.touchedCount = 0;
    this.lastTimestamp = 0;
    this.lastFrameTimestamp = null;
    this.revision += 1;
  }

  // 修改分辨率或地图尺寸时重建固定数组；只改变证据增量时沿用现有几何。
  configure(partial = {}) {
    const next = normalizeMappingConfig({ ...this.config, ...partial });
    const geometryChanged = next.resolutionMm !== this.config.resolutionMm || next.mapSizeMm !== this.config.mapSizeMm;
    const changed = Object.keys(next).some((key) => next[key] !== this.config[key]);
    if (!changed) return false;
    this.config = next;
    if (geometryChanged) this.#allocate();
    else {
      for (let index = 0; index < this.cellCount; index += 1) {
        this.scores[index] = Math.min(next.maxScore, Math.max(next.minScore, this.scores[index]));
      }
    }
    this.revision += 1;
    return geometryChanged;
  }

  // 将一帧局部点按指定位姿写入地图，同一帧内占据终点优先于空闲射线。
  updateScan(frameOrPoints, pose, explicitTimestamp) {
    const points = Array.isArray(frameOrPoints) ? frameOrPoints : frameOrPoints?.points;
    if (!Array.isArray(points)) throw new TypeError("updateScan 需要点数组或包含 points 的帧");
    const timestamp = Number(explicitTimestamp ?? frameOrPoints?.timestamp ?? Date.now());
    if (!Number.isFinite(timestamp)) throw new TypeError("地图时间戳必须是有限数值");
    // 串口重连或异步回调可能把旧帧晚到；时间不前进时不重复写入历史地图。
    if (this.lastFrameTimestamp !== null && timestamp <= this.lastFrameTimestamp) return this.snapshot();
    const normalizedPose = normalizePose(pose);
    const origin = worldToMapCell(normalizedPose.xMm, normalizedPose.yMm, this);
    if (!origin.inBounds) {
      // 雷达本体越出固定范围时不能安全投影射线，保留旧图并返回诊断状态。
      this.lastFrameTimestamp = timestamp;
      this.lastTimestamp = timestamp;
      this.revision += 1;
      return this.snapshot();
    }
    this.#resetMarks();

    // 第一遍登记落在地图内的终点，保障同圈另一束射线不会把占据格改成空闲。
    for (const point of points) {
      const localPoint = readLocalPoint(point);
      if (!localPoint) continue;
      const worldPoint = transformPointToWorld(localPoint, normalizedPose);
      if (!worldPoint) continue;
      const endpoint = worldToMapCell(worldPoint.xMm, worldPoint.yMm, this);
      if (endpoint.inBounds) this.#mark(endpoint.index, MARK_OCCUPIED);
    }

    // 第二遍从雷达原点到回波终点追踪空闲射线；越出边界的点只更新到边界而不伪造占据。
    for (const point of points) {
      const localPoint = readLocalPoint(point);
      if (!localPoint) continue;
      const worldPoint = transformPointToWorld(localPoint, normalizedPose);
      if (!worldPoint) continue;
      let endpoint = worldToMapCell(worldPoint.xMm, worldPoint.yMm, this);
      const endpointOccupied = endpoint.inBounds;
      if (!endpointOccupied) {
        // 按从雷达到回波的比例逐步收缩，找到地图边界附近的最后一格。
        const scale = this.#clipScale(normalizedPose.xMm, normalizedPose.yMm, worldPoint.xMm, worldPoint.yMm);
        if (!(scale > 0)) continue;
        endpoint = worldToMapCell(
          normalizedPose.xMm + (worldPoint.xMm - normalizedPose.xMm) * scale,
          normalizedPose.yMm + (worldPoint.yMm - normalizedPose.yMm) * scale,
          this,
        );
        if (!endpoint.inBounds) continue;
      }
      traceLine(origin.column, origin.row, endpoint.column, endpoint.row, (column, row, isEnd) => {
        if (isEnd && endpointOccupied) return;
        this.#mark(row * this.width + column, MARK_FREE);
      });
    }

    // 每个格子每帧只应用一次增量，避免点密度把某一方向证据不合理地放大。
    for (let offset = 0; offset < this.touchedCount; offset += 1) {
      const index = this.touchedIndices[offset];
      const delta = this.frameMarks[index] === MARK_OCCUPIED ? this.config.occupiedDelta : this.config.freeDelta;
      this.scores[index] = Math.min(this.config.maxScore, Math.max(this.config.minScore, this.scores[index] + delta));
      this.lastObservedAt[index] = timestamp;
    }
    this.lastFrameTimestamp = timestamp;
    this.lastTimestamp = timestamp;
    this.revision += 1;
    return this.snapshot();
  }

  // 兼容占据栅格和上层状态机常用的 update 命名，但仍要求调用者显式提供当前位姿。
  update(frameOrPoints, pose, explicitTimestamp) {
    return this.updateScan(frameOrPoints, pose, explicitTimestamp);
  }

  // 返回复用 typed array 的地图快照；调用者应把 scores 当作只读当前视图。
  snapshot() {
    let freeCount = 0;
    let occupiedCount = 0;
    for (let index = 0; index < this.cellCount; index += 1) {
      const score = this.scores[index];
      this.snapshotScores[index] = score;
      if (score < 0) freeCount += 1;
      else if (score > 0) occupiedCount += 1;
    }
    return {
      frameId: "map",
      timestamp: this.lastTimestamp,
      width: this.width,
      height: this.height,
      originRow: this.originRow,
      originColumn: this.originColumn,
      resolutionMm: this.config.resolutionMm,
      mapSizeMm: this.config.mapSizeMm,
      // 全局建图证据默认不按局部图的短时窗口衰减；清空或重新建图才会移除它。
      persistenceMs: Number.POSITIVE_INFINITY,
      scores: this.snapshotScores,
      lastObservedAt: this.lastObservedAt,
      freeCount,
      occupiedCount,
      revision: this.revision,
    };
  }

  #allocate() {
    this.sideLength = this.config.sideLength;
    this.originRow = this.config.halfCells;
    this.originColumn = this.config.halfCells;
    this.cellCount = this.width * this.height;
    this.scores = new Int8Array(this.cellCount);
    this.snapshotScores = new Int8Array(this.cellCount);
    this.lastObservedAt = new Float64Array(this.cellCount);
    this.frameMarks = new Uint8Array(this.cellCount);
    this.touchedIndices = new Uint32Array(this.cellCount);
    this.touchedCount = 0;
    this.lastTimestamp = 0;
    this.lastFrameTimestamp = null;
  }

  #resetMarks() {
    for (let offset = 0; offset < this.touchedCount; offset += 1) this.frameMarks[this.touchedIndices[offset]] = 0;
    this.touchedCount = 0;
  }

  #mark(index, mark) {
    if (index < 0 || index >= this.cellCount) return;
    const previous = this.frameMarks[index];
    if (previous === 0) {
      this.touchedIndices[this.touchedCount] = index;
      this.touchedCount += 1;
    }
    if (mark === MARK_OCCUPIED || previous === 0) this.frameMarks[index] = mark;
  }

  #clipScale(startX, startY, endX, endY) {
    const half = (this.width - 1) * this.config.resolutionMm / 2;
    const dx = endX - startX;
    const dy = endY - startY;
    let low = 0;
    let high = 1;
    for (const [start, delta] of [[startX, dx], [startY, dy]]) {
      if (Math.abs(delta) < 1e-9) {
        if (Math.abs(start) > half) return 0;
        continue;
      }
      const first = (-half - start) / delta;
      const second = (half - start) / delta;
      low = Math.max(low, Math.min(first, second));
      high = Math.min(high, Math.max(first, second));
    }
    return high >= low ? Math.min(1, high) : 0;
  }
}

// 将扫描、匹配、位姿、栅格和路径封装成 app.js 可在每个完整 ScanFrame 调用一次的教学状态机。
export class ExperimentalMapper {
  constructor(inputConfig = {}) {
    this.config = normalizeMappingConfig(inputConfig);
    this.grid = new GlobalOccupancyGrid(this.config);
    this.pose = normalizePose();
    this.previousPoints = null;
    this.lastFrameTimestamp = null;
    this.lastTimestamp = 0;
    this.frameCount = 0;
    this.paused = false;
    this.mode = "ready";
    this.lastMatch = this.#initialMatch("等待第一帧");
    this.#allocatePath();
  }

  // 读取当前位姿但返回新对象，避免渲染层改写内部状态。
  get currentPose() { return { ...this.pose }; }

  // 暂停只停止累计；恢复时丢弃旧参考帧，防止暂停期间的未知移动造成大幅跳变。
  setPaused(paused) {
    this.paused = Boolean(paused);
    if (!this.paused) this.previousPoints = null;
    this.mode = this.paused ? "paused" : "ready";
    return this.snapshot();
  }

  pause() { return this.setPaused(true); }
  resume() { return this.setPaused(false); }

  // 清空地图、路径和参考帧；默认回到初始坐标原点，适合作为课堂“重新建图”按钮。
  clear({ keepPose = false } = {}) {
    this.grid.clear();
    this.previousPoints = null;
    this.lastFrameTimestamp = null;
    this.lastTimestamp = 0;
    this.frameCount = 0;
    this.mode = "ready";
    this.lastMatch = this.#initialMatch("已清空，等待第一帧");
    if (!keepPose) this.pose = normalizePose();
    this.#clearPath();
    return this.snapshot();
  }

  reset(options = {}) { return this.clear(options); }

  // 处理一帧完整扫描；匹配失败时保持旧位姿和旧地图，不把低置信结果写入安全相关数据。
  processFrame(frameOrPoints, explicitTimestamp) {
    const timestamp = Number(explicitTimestamp ?? frameOrPoints?.timestamp ?? Date.now());
    if (!Number.isFinite(timestamp)) throw new TypeError("扫描时间戳必须是有限数值");
    // 相同或倒退的时间戳不代表新的完整扫描，避免旧回调覆盖当前匹配参考。
    if (this.lastFrameTimestamp !== null && timestamp <= this.lastFrameTimestamp) return this.snapshot();
    if (this.paused) {
      this.mode = "paused";
      this.lastTimestamp = timestamp;
      return this.snapshot();
    }

    const points = extractMappingPoints(frameOrPoints, this.config);
    if (!this.previousPoints) {
      if (points.length < this.config.minInliers) {
        this.mode = "lost";
        this.lastMatch = this.#initialMatch("首帧有效点不足");
        this.lastTimestamp = timestamp;
        this.lastFrameTimestamp = timestamp;
        return this.snapshot();
      }
      this.previousPoints = points;
      this.lastMatch = {
        ...this.#initialMatch("首帧建立地图参考"),
        accepted: true,
        confidence: 1,
        inliers: points.length,
        inlierRatio: 1,
        ratio: 1,
        quality: 1,
        matchQuality: 1,
        previousCount: points.length,
        currentCount: points.length,
      };
      this.mode = "tracking";
      this.grid.updateScan(points, this.pose, timestamp);
      this.#appendPath(this.pose);
      this.#finishFrame(timestamp);
      return this.snapshot();
    }

    const match = estimateScanMatch(this.previousPoints, points, this.config);
    this.lastMatch = match;
    if (!match.accepted) {
      this.mode = "lost";
      this.lastTimestamp = timestamp;
      this.lastFrameTimestamp = timestamp;
      return this.snapshot();
    }

    // 只有通过置信度门槛的相对位姿才更新全局姿态和地图，避免失败匹配“乱跳”。
    this.pose = composePose(this.pose, match.delta);
    this.previousPoints = points;
    this.grid.updateScan(points, this.pose, timestamp);
    this.#appendPath(this.pose);
    this.mode = "tracking";
    this.#finishFrame(timestamp);
    return this.snapshot();
  }

  update(frameOrPoints, explicitTimestamp) { return this.processFrame(frameOrPoints, explicitTimestamp); }

  // 课堂代码有时把完整扫描称为 scan；该别名不改变“每帧最多累计一次”的语义。
  processScan(frameOrPoints, explicitTimestamp) {
    return this.processFrame(frameOrPoints, explicitTimestamp);
  }

  // 输出渲染层所需的固定地图、位姿、路径和匹配质量摘要；不暴露匹配缓存本身。
  snapshot() {
    const map = this.grid.snapshot();
    const path = this.#snapshotPath();
    return {
      frameId: "map",
      timestamp: this.lastTimestamp,
      width: map.width,
      height: map.height,
      originRow: map.originRow,
      originColumn: map.originColumn,
      resolutionMm: map.resolutionMm,
      scores: map.scores,
      lastObservedAt: map.lastObservedAt,
      freeCount: map.freeCount,
      occupiedCount: map.occupiedCount,
      revision: map.revision,
      map,
      pose: { ...this.pose },
      path,
      // trajectory/trackingState 是渲染和课堂脚本的兼容别名，仍受同一固定容量约束。
      trajectory: path,
      match: { ...this.lastMatch, delta: { ...this.lastMatch.delta } },
      matchQuality: this.lastMatch.confidence,
      mode: this.mode,
      trackingState: this.mode,
      mappingActive: !this.paused,
      paused: this.paused,
      frameCount: this.frameCount,
    };
  }

  getState() { return this.snapshot(); }

  #finishFrame(timestamp) {
    this.lastTimestamp = timestamp;
    this.lastFrameTimestamp = timestamp;
    this.frameCount += 1;
  }

  #initialMatch(reason) {
    return {
      accepted: false,
      reason,
      delta: { xMm: 0, yMm: 0, thetaDeg: 0 },
      inliers: 0,
      inlierRatio: 0,
      ratio: 0,
      quality: 0,
      matchQuality: 0,
      rmseMm: Number.POSITIVE_INFINITY,
      confidence: 0,
      previousCount: 0,
      currentCount: 0,
      evaluatedCandidates: 0,
    };
  }

  #allocatePath() {
    this.pathX = new Float64Array(this.config.maxPathLength);
    this.pathY = new Float64Array(this.config.maxPathLength);
    this.pathTheta = new Float64Array(this.config.maxPathLength);
    this.pathStart = 0;
    this.pathCount = 0;
  }

  #clearPath() {
    this.pathX.fill(0);
    this.pathY.fill(0);
    this.pathTheta.fill(0);
    this.pathStart = 0;
    this.pathCount = 0;
  }

  #appendPath(pose) {
    if (this.pathCount > 0) {
      const lastIndex = (this.pathStart + this.pathCount - 1) % this.config.maxPathLength;
      const distance = Math.hypot(pose.xMm - this.pathX[lastIndex], pose.yMm - this.pathY[lastIndex]);
      const angle = Math.abs(normalizeHeadingDeg(pose.thetaDeg - this.pathTheta[lastIndex]));
      if (distance < this.config.pathMinTranslationMm && angle < this.config.pathMinRotationDeg) return;
    }
    let index;
    if (this.pathCount < this.config.maxPathLength) {
      index = (this.pathStart + this.pathCount) % this.config.maxPathLength;
      this.pathCount += 1;
    } else {
      index = this.pathStart;
      this.pathStart = (this.pathStart + 1) % this.config.maxPathLength;
    }
    this.pathX[index] = pose.xMm;
    this.pathY[index] = pose.yMm;
    this.pathTheta[index] = pose.thetaDeg;
  }

  #snapshotPath() {
    const path = [];
    for (let offset = 0; offset < this.pathCount; offset += 1) {
      const index = (this.pathStart + offset) % this.config.maxPathLength;
      path.push({ xMm: this.pathX[index], yMm: this.pathY[index], thetaDeg: this.pathTheta[index] });
    }
    return path;
  }
}

// 语义别名便于不同课堂代码按“地图引擎”或“实验映射器”理解同一实现。
export const MappingEngine = ExperimentalMapper;
export const matchScans = estimateScanMatch;
