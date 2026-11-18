// 局部占据栅格只描述固定雷达坐标系中的短时几何证据，不估计位姿，也不等同于 SLAM 地图。
export const DEFAULT_OCCUPANCY_CONFIG = Object.freeze({
  resolutionMm: 50,
  maxRangeMm: 8000,
  persistenceMs: 3000,
  freeDelta: -1,
  occupiedDelta: 4,
  minScore: -20,
  maxScore: 20,
});

const MAX_GRID_CELLS = 4_194_304;
const CELL_FREE = 1;
const CELL_OCCUPIED = 2;

// 浏览器与 Node 测试都可使用同一时钟入口；调用者传入时间时则完全由调用者控制。
function currentTime() {
  return globalThis.performance?.now?.() ?? Date.now();
}

// 对半格坐标采用远离零的对称取整，避免 Math.round 对负数半格产生方向偏差。
function roundSymmetrically(value) {
  return Math.sign(value) * Math.floor(Math.abs(value) + 0.5);
}

function clamp(value, minimum, maximum) {
  return Math.min(maximum, Math.max(minimum, value));
}

function requireFinitePositive(value, name) {
  if (!Number.isFinite(value) || value <= 0) {
    throw new RangeError(`${name} 必须是大于 0 的有限数值`);
  }
  return value;
}

function normalizeConfig(input = {}) {
  const config = { ...DEFAULT_OCCUPANCY_CONFIG, ...input };
  requireFinitePositive(config.resolutionMm, "resolutionMm");
  requireFinitePositive(config.maxRangeMm, "maxRangeMm");
  requireFinitePositive(config.persistenceMs, "persistenceMs");

  for (const key of ["freeDelta", "occupiedDelta", "minScore", "maxScore"]) {
    if (!Number.isInteger(config[key])) throw new TypeError(`${key} 必须是整数`);
  }
  if (config.freeDelta >= 0) throw new RangeError("freeDelta 必须小于 0");
  if (config.occupiedDelta <= 0) throw new RangeError("occupiedDelta 必须大于 0");
  if (config.minScore < -128 || config.minScore >= 0) {
    throw new RangeError("minScore 必须位于 Int8 范围内且小于 0");
  }
  if (config.maxScore > 127 || config.maxScore <= 0) {
    throw new RangeError("maxScore 必须位于 Int8 范围内且大于 0");
  }

  const halfCells = Math.ceil(config.maxRangeMm / config.resolutionMm);
  const sideLength = halfCells * 2 + 1;
  if (!Number.isSafeInteger(sideLength) || sideLength * sideLength > MAX_GRID_CELLS) {
    throw new RangeError("占据栅格尺寸过大，请提高分辨率或降低最大距离");
  }
  return Object.freeze({ ...config });
}

// 将雷达坐标映射为栅格：x 正方向朝屏幕上方，y 正方向朝屏幕左侧。
export function worldToGridCell(xMm, yMm, geometry) {
  const resolutionMm = requireFinitePositive(Number(geometry?.resolutionMm), "resolutionMm");
  const originRow = Number(geometry?.originRow);
  const originColumn = Number(geometry?.originColumn);
  if (!Number.isInteger(originRow) || !Number.isInteger(originColumn)) {
    throw new TypeError("originRow 和 originColumn 必须是整数");
  }

  const row = originRow - roundSymmetrically(Number(xMm) / resolutionMm);
  const column = originColumn - roundSymmetrically(Number(yMm) / resolutionMm);
  const width = Number(geometry?.width);
  const height = Number(geometry?.height);
  const hasBounds = Number.isInteger(width) && Number.isInteger(height);
  const inBounds = !hasBounds || (row >= 0 && row < height && column >= 0 && column < width);
  return {
    row,
    column,
    inBounds,
    index: inBounds && hasBounds ? row * width + column : -1,
  };
}

// 从分析后的 ScanPoint 提取雷达坐标；保留角度/距离回退便于独立教学测试。
function pointCoordinates(point) {
  if (!point || point.valid !== true) return null;
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
  const radialDistanceMm = Math.hypot(xMm, yMm);
  if (!Number.isFinite(radialDistanceMm) || radialDistanceMm <= 0) return null;
  return { xMm, yMm, radialDistanceMm };
}

// Bresenham 只访问起点到终点之间的有限格子，不会产生随运行时间增长的射线缓存。
function traceGridLine(startColumn, startRow, endColumn, endRow, visit) {
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
    const doubledError = error * 2;
    if (doubledError >= deltaRow) {
      error += deltaRow;
      column += stepColumn;
    }
    if (doubledError <= deltaColumn) {
      error += deltaColumn;
      row += stepRow;
    }
  }
}

export class LocalOccupancyGrid {
  constructor(inputConfig = {}) {
    this.config = normalizeConfig(inputConfig);
    this.revision = 0;
    this.lastUpdateTimestamp = 0;
    this.lastFrameTimestamp = null;
    this.#allocateStorage();
  }

  // 只读几何属性让坐标转换函数可以直接接收栅格实例，同时避免复制配置对象。
  get resolutionMm() {
    return this.config.resolutionMm;
  }

  get maxRangeMm() {
    return this.config.maxRangeMm;
  }

  // 几何尺寸改变时必须重建并清空；其他证据参数可以在原栅格上安全更新。
  configure(partialConfig = {}) {
    const nextConfig = normalizeConfig({ ...this.config, ...partialConfig });
    const geometryChanged = nextConfig.resolutionMm !== this.config.resolutionMm
      || nextConfig.maxRangeMm !== this.config.maxRangeMm;
    const anyChanged = Object.keys(nextConfig).some((key) => nextConfig[key] !== this.config[key]);
    if (!anyChanged) return false;

    this.config = nextConfig;
    if (geometryChanged) {
      this.lastUpdateTimestamp = 0;
      this.lastFrameTimestamp = null;
      this.#allocateStorage();
    } else {
      // 收紧分值范围时直接钳制旧证据，防止 Int8 中保留超出新配置的历史值。
      for (let index = 0; index < this.cellCount; index += 1) {
        this.evidenceScores[index] = clamp(
          this.evidenceScores[index],
          this.config.minScore,
          this.config.maxScore,
        );
      }
    }
    this.revision += 1;
    return geometryChanged;
  }

  // 清空同时解除帧时间戳去重，使手动清图后可以重新加入同一帧作课堂演示。
  clear() {
    this.evidenceScores.fill(0);
    this.snapshotScores.fill(0);
    this.lastObservedAt.fill(0);
    this.frameMarks.fill(0);
    this.touchedCount = 0;
    this.lastUpdateTimestamp = 0;
    this.lastFrameTimestamp = null;
    this.revision += 1;
  }

  // 接受 ScanFrame 或 points 数组；相同时间戳的完整帧只累计一次，避免参数重算重复加证据。
  update(frameOrPoints, explicitTimestamp) {
    const isFrame = !Array.isArray(frameOrPoints) && frameOrPoints && Array.isArray(frameOrPoints.points);
    const points = isFrame ? frameOrPoints.points : frameOrPoints;
    if (!Array.isArray(points)) throw new TypeError("update 需要 ScanFrame 或 ScanPoint 数组");

    const candidateTimestamp = explicitTimestamp ?? (isFrame ? frameOrPoints.timestamp : undefined) ?? currentTime();
    const timestamp = Number(candidateTimestamp);
    if (!Number.isFinite(timestamp)) throw new TypeError("扫描时间戳必须是有限数值");
    if (this.lastFrameTimestamp !== null && timestamp === this.lastFrameTimestamp) {
      return this.snapshot(timestamp);
    }

    this.#resetFrameMarks();

    // 第一遍先登记所有回波终点，确保另一条射线穿过该格时不会把占据证据降为空闲。
    for (const point of points) {
      const coordinates = pointCoordinates(point);
      if (!coordinates || coordinates.radialDistanceMm > this.config.maxRangeMm) continue;
      const endpoint = worldToGridCell(coordinates.xMm, coordinates.yMm, this);
      if (endpoint.inBounds) this.#markFrameCell(endpoint.index, CELL_OCCUPIED);
    }

    // 第二遍追踪射线；超出局部图范围的有效回波只证明边界之前为空闲，不在边界制造假障碍。
    for (const point of points) {
      const coordinates = pointCoordinates(point);
      if (!coordinates) continue;
      const endpointIsOccupied = coordinates.radialDistanceMm <= this.config.maxRangeMm;
      const scale = endpointIsOccupied ? 1 : this.config.maxRangeMm / coordinates.radialDistanceMm;
      const endpoint = worldToGridCell(coordinates.xMm * scale, coordinates.yMm * scale, this);
      if (!endpoint.inBounds) continue;

      traceGridLine(
        this.originColumn,
        this.originRow,
        endpoint.column,
        endpoint.row,
        (column, row, isEnd) => {
          if (isEnd && endpointIsOccupied) return;
          const index = row * this.width + column;
          this.#markFrameCell(index, CELL_FREE);
        },
      );
    }

    // 同一圈内每个格子只应用一次增量，避免高密度角度区域被重复采样次数放大。
    for (let offset = 0; offset < this.touchedCount; offset += 1) {
      const index = this.touchedIndices[offset];
      const mark = this.frameMarks[index];
      const delta = mark === CELL_OCCUPIED ? this.config.occupiedDelta : this.config.freeDelta;
      const decayedScore = this.#scoreAt(index, timestamp, false);
      const nextScore = clamp(decayedScore + delta, this.config.minScore, this.config.maxScore);
      this.evidenceScores[index] = nextScore;
      this.lastObservedAt[index] = nextScore === 0 ? 0 : timestamp;
    }

    this.lastFrameTimestamp = timestamp;
    this.lastUpdateTimestamp = timestamp;
    this.revision += 1;
    return this.snapshot(timestamp);
  }

  // 快照复用固定大小的 Int8Array；调用者应把 typed array 当作只读的当前视图使用。
  snapshot(now = currentTime()) {
    const timestamp = Number(now);
    if (!Number.isFinite(timestamp)) throw new TypeError("快照时间戳必须是有限数值");
    let freeCount = 0;
    let occupiedCount = 0;
    for (let index = 0; index < this.cellCount; index += 1) {
      const score = this.#scoreAt(index, timestamp, true);
      this.snapshotScores[index] = score;
      if (score < 0) freeCount += 1;
      else if (score > 0) occupiedCount += 1;
    }

    return {
      timestamp: this.lastUpdateTimestamp,
      frameId: "lidar_link",
      width: this.width,
      height: this.height,
      originRow: this.originRow,
      originColumn: this.originColumn,
      resolutionMm: this.config.resolutionMm,
      maxRangeMm: this.config.maxRangeMm,
      persistenceMs: this.config.persistenceMs,
      scores: this.snapshotScores,
      lastObservedAt: this.lastObservedAt,
      freeCount,
      occupiedCount,
      revision: this.revision,
    };
  }

  #allocateStorage() {
    const halfCells = Math.ceil(this.config.maxRangeMm / this.config.resolutionMm);
    this.width = halfCells * 2 + 1;
    this.height = this.width;
    this.originRow = halfCells;
    this.originColumn = halfCells;
    this.cellCount = this.width * this.height;
    this.evidenceScores = new Int8Array(this.cellCount);
    this.snapshotScores = new Int8Array(this.cellCount);
    this.lastObservedAt = new Float64Array(this.cellCount);
    this.frameMarks = new Uint8Array(this.cellCount);
    this.touchedIndices = new Uint32Array(this.cellCount);
    this.touchedCount = 0;
  }

  #resetFrameMarks() {
    for (let offset = 0; offset < this.touchedCount; offset += 1) {
      this.frameMarks[this.touchedIndices[offset]] = 0;
    }
    this.touchedCount = 0;
  }

  #markFrameCell(index, mark) {
    const previous = this.frameMarks[index];
    if (previous === 0) {
      this.touchedIndices[this.touchedCount] = index;
      this.touchedCount += 1;
    }
    if (mark === CELL_OCCUPIED || previous === 0) this.frameMarks[index] = mark;
  }

  // 分值按剩余寿命线性趋近 0；Int8 无小数，因此非零证据在到期前至少保留一级。
  #scoreAt(index, timestamp, expireCell) {
    const score = this.evidenceScores[index];
    if (score === 0) return 0;
    const ageMs = Math.max(0, timestamp - this.lastObservedAt[index]);
    if (ageMs >= this.config.persistenceMs) {
      if (expireCell) {
        this.evidenceScores[index] = 0;
        this.lastObservedAt[index] = 0;
      }
      return 0;
    }
    const remainingFraction = 1 - ageMs / this.config.persistenceMs;
    const magnitude = Math.max(1, Math.ceil(Math.abs(score) * remainingFraction));
    return Math.sign(score) * magnitude;
  }
}
