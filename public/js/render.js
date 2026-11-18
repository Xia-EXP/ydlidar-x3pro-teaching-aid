// 解析 CSS 变量供 Canvas 使用，保证绘图颜色随系统浅色/深色主题同步。
let themeColorsCache = null;
let themeColorsCacheExpiresAt = 0;

// 同一批绘制在短时间内共享颜色快照，避免两个 Canvas 每帧重复触发 getComputedStyle。
function themeColors() {
  const now = globalThis.performance?.now?.() ?? Date.now();
  if (themeColorsCache && now < themeColorsCacheExpiresAt) return themeColorsCache;
  const styles = getComputedStyle(document.documentElement);
  const read = (name, fallback) => styles.getPropertyValue(name).trim() || fallback;
  themeColorsCache = {
    text: read("--text", "#edf4f7"),
    muted: read("--muted-text", "#9eafb9"),
    grid: read("--canvas-grid", "#334552"),
    accent: read("--accent", "#57d6e7"),
    point: read("--point", "#57d6e7"),
    pointFar: read("--point-far", "#6edb9a"),
    pointNear: read("--point-near", "#f4a261"),
    cluster: read("--cluster", "#f4d35e"),
    danger: read("--danger", "#ff6b70"),
    safe: read("--safe", "#6edb9a"),
    warning: read("--warning", "#f4a261"),
    overlay: read("--canvas-overlay", "rgba(15, 21, 27, 0.68)"),
    mapUnknown: read("--map-unknown", "#596166"),
    mapFree: read("--map-free", "#e7ecee"),
    mapOccupied: read("--map-occupied", "#111517"),
    mapLiveHit: read("--map-live", "#ff5f57"),
    mapOrigin: read("--map-origin", "#70dc9b"),
    mapRay: read("--map-ray", "#ffffff"),
    mapGridMajor: read("--map-grid-major", "rgba(18, 27, 31, 0.42)"),
  };
  // 250ms 过期窗口足以跟随系统主题变化，同时避免持续扫描时反复读取 CSSOM。
  themeColorsCacheExpiresAt = now + 250;
  return themeColorsCache;
}

// 外部主题切换时可主动清除快照；当前页面没有强制主题按钮，保留接口供后续教学皮肤使用。
export function invalidateThemeColors() {
  themeColorsCache = null;
  themeColorsCacheExpiresAt = 0;
}

// 每个 Canvas 独立缓存栅格位图，避免在同一次界面刷新中重复转换上万个单元颜色。
const occupancyRasterCache = new WeakMap();
const colorRgbCache = new Map();
let colorProbeContext = null;

// 借助 Canvas 规范化 CSS 颜色，再转换成 ImageData 可以直接写入的 RGB 数组。
function colorToRgb(color, fallback) {
  const cacheKey = `${color}|${fallback}`;
  const cached = colorRgbCache.get(cacheKey);
  if (cached) return cached;
  colorProbeContext ??= document.createElement("canvas").getContext("2d");
  const probe = colorProbeContext;
  probe.fillStyle = fallback;
  probe.fillStyle = color;
  const normalized = probe.fillStyle;
  const hexMatch = /^#([0-9a-f]{6})$/i.exec(normalized);
  if (hexMatch) {
    const value = Number.parseInt(hexMatch[1], 16);
    const rgb = [(value >> 16) & 0xff, (value >> 8) & 0xff, value & 0xff];
    colorRgbCache.set(cacheKey, rgb);
    return rgb;
  }
  const shortHexMatch = /^#([0-9a-f]{3})$/i.exec(normalized);
  if (shortHexMatch) {
    const rgb = [...shortHexMatch[1]].map((digit) => Number.parseInt(`${digit}${digit}`, 16));
    colorRgbCache.set(cacheKey, rgb);
    return rgb;
  }
  const rgbMatch = /rgba?\(\s*(\d+)\D+(\d+)\D+(\d+)/i.exec(normalized);
  const rgb = rgbMatch ? rgbMatch.slice(1, 4).map(Number) : [89, 97, 102];
  colorRgbCache.set(cacheKey, rgb);
  return rgb;
}

// 按时间衰减比例把空闲/占据颜色混回未知色，让旧证据连续淡出而不是突然闪烁消失。
function blendRgb(background, foreground, ratio) {
  const amount = Math.max(0, Math.min(1, ratio));
  return background.map((channel, index) => Math.round(channel + (foreground[index] - channel) * amount));
}

// 把当前栅格快照生成一个一格一像素的缓存图，最终再无平滑缩放到可见 Canvas。
function getOccupancyRaster(canvas, snapshot, colors, now) {
  if (!snapshot?.scores?.length) return null;
  // 全局建图证据不衰减时不需要按时间重建位图；局部图仍按 250ms 桶刷新渐隐颜色。
  const persistenceMs = Number(snapshot.persistenceMs ?? 3000);
  const ageBucket = Number.isFinite(persistenceMs) ? Math.floor(now / 250) : 0;
  const colorKey = `${colors.mapUnknown}|${colors.mapFree}|${colors.mapOccupied}`;
  // 同一个 Canvas 会在局部图/全局建图模式之间复用；把 frameId 纳入缓存键，避免两张同尺寸栅格串图。
  const key = `${snapshot.frameId ?? ""}|${snapshot.revision}|${snapshot.width}x${snapshot.height}|${ageBucket}|${colorKey}`;
  const cached = occupancyRasterCache.get(canvas);
  if (cached?.key === key) return cached.canvas;

  const raster = cached?.canvas ?? document.createElement("canvas");
  raster.width = snapshot.width;
  raster.height = snapshot.height;
  const rasterContext = raster.getContext("2d", { alpha: false });
  const image = rasterContext.createImageData(snapshot.width, snapshot.height);
  const unknown = colorToRgb(colors.mapUnknown, "#596166");
  const free = colorToRgb(colors.mapFree, "#e7ecee");
  const occupied = colorToRgb(colors.mapOccupied, "#111517");
  const fadeWindowMs = Math.max(1, persistenceMs);

  for (let index = 0; index < snapshot.scores.length; index += 1) {
    const score = snapshot.scores[index];
    const observedAt = snapshot.lastObservedAt?.[index] ?? 0;
    const ageMs = observedAt > 0 ? Math.max(0, now - observedAt) : fadeWindowMs;
    const fade = score === 0 ? 0 : Math.max(0, 1 - ageMs / fadeWindowMs);
    const target = score > 0 ? occupied : free;
    const [red, green, blue] = blendRgb(unknown, target, fade);
    const offset = index * 4;
    image.data[offset] = red;
    image.data[offset + 1] = green;
    image.data[offset + 2] = blue;
    image.data[offset + 3] = 255;
  }
  rasterContext.putImageData(image, 0, 0);
  occupancyRasterCache.set(canvas, { key, canvas: raster });
  return raster;
}

// 将 CSS 尺寸映射到高 DPI backing store，避免 Windows 缩放后 Canvas 模糊。
export function resizeCanvas(canvas) {
  const rect = canvas.getBoundingClientRect();
  if (rect.width <= 0 || rect.height <= 0) return null;
  const dpr = window.devicePixelRatio || 1;
  const width = Math.round(rect.width * dpr);
  const height = Math.round(rect.height * dpr);
  if (canvas.width !== width || canvas.height !== height) {
    canvas.width = width;
    canvas.height = height;
  }
  const context = canvas.getContext("2d");
  context.setTransform(dpr, 0, 0, dpr, 0, 0);
  return { context, width: rect.width, height: rect.height };
}

// 让距离越近的点越醒目，同时保留文字和形状作为颜色之外的语义提示。
function pointColor(distanceMm, maxRangeMm, colors) {
  if (distanceMm < maxRangeMm * 0.2) return colors.pointNear;
  if (distanceMm > maxRangeMm * 0.7) return colors.pointFar;
  return colors.point;
}

// 将雷达角度投影到屏幕：0°朝上，正角度朝屏幕左侧。
function polarToScreen(angleDeg, distanceMm, centerX, centerY, scale) {
  const radians = (angleDeg * Math.PI) / 180;
  return {
    x: centerX - Math.sin(radians) * distanceMm * scale,
    y: centerY - Math.cos(radians) * distanceMm * scale,
  };
}

// 绘制极坐标实时扫描图和基础方向标记。
export function drawPolarScan(canvas, frame, settings, selectedPointIndex = -1, live = {}) {
  const layout = resizeCanvas(canvas);
  if (!layout) return;
  const { context, width, height } = layout;
  const colors = themeColors();
  const centerX = width / 2;
  const centerY = height / 2;
  const radius = Math.max(20, Math.min(width, height) / 2 - 28);
  const maxRange = Math.max(1, settings.maxRangeMm);
  const scale = radius / maxRange;

  context.clearRect(0, 0, width, height);
  context.lineWidth = 1;
  context.strokeStyle = colors.grid;
  context.fillStyle = colors.muted;
  context.font = "12px Segoe UI, sans-serif";
  context.textAlign = "center";
  context.textBaseline = "middle";

  // 三个距离环帮助学生把点的半径和毫米单位对应起来。
  for (const fraction of [0.25, 0.5, 0.75, 1]) {
    context.beginPath();
    context.arc(centerX, centerY, radius * fraction, 0, Math.PI * 2);
    context.stroke();
    context.fillText(`${(maxRange * fraction / 1000).toFixed(1)}m`, centerX + 22, centerY - radius * fraction);
  }
  context.beginPath();
  context.moveTo(centerX, centerY - radius);
  context.lineTo(centerX, centerY + radius);
  context.moveTo(centerX - radius, centerY);
  context.lineTo(centerX + radius, centerY);
  context.stroke();
  context.fillText("前 0°", centerX, centerY - radius - 14);
  context.fillText("左 +90°", centerX - radius + 34, centerY);
  context.fillText("右 -90°", centerX + radius - 34, centerY);

  // 实时波束覆盖层只读取最新合法包，最多随浏览器帧刷新，不保留包历史。
  const progress = live.liveProgress;
  const packet = live.latestPacket;
  // 用最新包中最后一个有效采样作为当前回波，避免把历史完整点云误认为正在测量的位置。
  const currentEcho = [...(packet?.points ?? [])].reverse().find((point) => point.valid) ?? null;
  // 进度弧每圈从空到满，按圈刷新时会闪烁，因此只随逐包图层一起显示。
  if (progress && (live.showLiveBeam === true || live.showSweptSector === true)) {
    // 外圈进度弧把实际扫过角度变成连续的视觉反馈，不伪造固定包数进度。
    const progressAngle = Math.max(0, Math.min(1, progress.progress01 ?? 0)) * Math.PI * 2;
    context.save();
    context.strokeStyle = colors.accent;
    context.globalAlpha = 0.9;
    context.lineWidth = 4;
    context.beginPath();
    context.arc(centerX, centerY, radius + 10, -Math.PI / 2, -Math.PI / 2 + progressAngle);
    context.stroke();
    context.restore();
  }
  if (packet && progress && live.showSweptSector !== false) {
    const start = (progress.packetStartAngleDeg * Math.PI) / 180 - Math.PI / 2;
    let sweep = ScanAngleDelta(progress.packetStartAngleDeg, progress.packetEndAngleDeg);
    if (progress.direction === "cw") sweep = -Math.abs(sweep); else sweep = Math.abs(sweep);
    context.save();
    context.globalAlpha = 0.12;
    context.fillStyle = colors.accent;
    context.beginPath();
    context.moveTo(centerX, centerY);
    context.arc(centerX, centerY, radius, start, start + (sweep * Math.PI) / 180, sweep < 0);
    context.closePath();
    context.fill();
    context.restore();
  }
  if (packet && progress && live.showLiveBeam !== false) {
    const beam = polarToScreen(progress.currentAngleDeg, maxRange, centerX, centerY, scale);
    context.save();
    context.globalAlpha = 0.75;
    context.strokeStyle = colors.accent;
    context.lineWidth = 2;
    context.beginPath(); context.moveTo(centerX, centerY); context.lineTo(beam.x, beam.y); context.stroke();
    context.restore();
  }
  if (packet && currentEcho && live.showPacketEcho !== false) {
    // 当前包回波使用白色外圈和标注线，和完整扫描的彩色点云保持明确区分。
    const echo = polarToScreen(currentEcho.angleDeg, currentEcho.distanceMm, centerX, centerY, scale);
    const labelX = echo.x + (echo.x >= centerX ? 10 : -10);
    const labelY = echo.y + (echo.y >= centerY ? 16 : -16);
    context.save();
    context.strokeStyle = colors.text;
    context.fillStyle = colors.text;
    context.lineWidth = 2;
    context.beginPath(); context.arc(echo.x, echo.y, 7, 0, Math.PI * 2); context.stroke();
    context.beginPath(); context.moveTo(echo.x, echo.y); context.lineTo(labelX, labelY); context.stroke();
    context.font = "600 11px Consolas, monospace";
    context.textAlign = echo.x >= centerX ? "left" : "right";
    context.fillText(`${currentEcho.angleDeg.toFixed(1)}° · ${(currentEcho.distanceMm / 1000).toFixed(2)}m`, labelX, labelY);
    context.restore();
  }
  if (packet && live.showPacketEcho !== false) {
    context.fillStyle = colors.mapLiveHit;
    context.beginPath();
    for (const point of packet.points ?? []) {
      if (!point.valid) continue;
      const position = polarToScreen(point.angleDeg, point.distanceMm, centerX, centerY, scale);
      context.moveTo(position.x + 3, position.y); context.arc(position.x, position.y, 3, 0, Math.PI * 2);
    }
    context.fill();
  }

  if (!frame?.points?.length) {
    context.fillStyle = colors.muted;
    context.fillText("等待串口数据", centerX, centerY);
    return;
  }

  // 按近/中/远三种颜色批量填充点云，把数百次 fill 压缩为最多三次 Canvas 提交。
  const pointGroups = [...new Set([colors.pointNear, colors.point, colors.pointFar])];
  for (const groupColor of pointGroups) {
    let hasPoints = false;
    context.fillStyle = groupColor;
    context.beginPath();
    for (const point of frame.points) {
      if (!point.valid || pointColor(point.distanceMm, maxRange, colors) !== groupColor) continue;
      const position = polarToScreen(point.angleDeg, point.distanceMm, centerX, centerY, scale);
      const pointRadius = point.index === selectedPointIndex ? 5 : 2.2;
      context.moveTo(position.x + pointRadius, position.y);
      context.arc(position.x, position.y, pointRadius, 0, Math.PI * 2);
      hasPoints = true;
    }
    if (hasPoints) context.fill();
  }
  if (selectedPointIndex >= 0) {
    const point = frame.points.find((candidate) => candidate.index === selectedPointIndex);
    if (point?.valid) {
      const position = polarToScreen(point.angleDeg, point.distanceMm, centerX, centerY, scale);
      context.strokeStyle = colors.text;
      context.lineWidth = 2;
      context.beginPath();
      context.arc(position.x, position.y, 9, 0, Math.PI * 2);
      context.stroke();
    }
  }

  if (live.showInvalid === true) {
    context.strokeStyle = colors.warning;
    context.lineWidth = 1;
    for (const point of frame.points) {
      if (point.valid) continue;
      const distance = Math.min(maxRange, Math.max(0, point.distanceMm || maxRange * 0.96));
      const position = polarToScreen(point.angleDeg, distance, centerX, centerY, scale);
      context.beginPath(); context.moveTo(position.x - 3, position.y - 3); context.lineTo(position.x + 3, position.y + 3); context.stroke();
    }
  }
  // HUD 固定在图内角落，集中解释当前包、当前角度和本圈进度；属于逐包信息，随逐包图层一起显示。
  if (progress && (live.showLiveBeam === true || live.showSweptSector === true || live.showPacketEcho === true)) {
    context.save();
    context.fillStyle = colors.text;
    context.font = "600 11px Consolas, monospace";
    context.textAlign = "left";
    context.fillText(`PKT ${progress.packetCount} · ${progress.direction === "ccw" ? "CCW" : progress.direction === "cw" ? "CW" : "?"}`, 12, 16);
    context.fillText(`SWEEP ${progress.sweptAngleDeg.toFixed(1)}° · ${(progress.progress01 * 100).toFixed(0)}%`, 12, 32);
    if (currentEcho) context.fillText(`ECHO ${(currentEcho.distanceMm / 1000).toFixed(2)} m`, 12, 48);
    context.restore();
  }
}

// 计算跨 0/360 度的有向扇区宽度，保证实时覆盖层不在北向跳变。
function ScanAngleDelta(start, end) {
  let delta = ((end - start + 540) % 360) - 180;
  if (delta === -180) delta = 180;
  return delta;
}

// 将雷达坐标换算到方形地图区域：X 向前对应屏幕向上，Y 向左对应屏幕向左。
function mapPointToScreen(point, snapshot, mapLeft, mapTop, mapSize) {
  const column = snapshot.originColumn - point.yMm / snapshot.resolutionMm;
  const row = snapshot.originRow - point.xMm / snapshot.resolutionMm;
  return {
    x: mapLeft + (column / Math.max(1, snapshot.width - 1)) * mapSize,
    y: mapTop + (row / Math.max(1, snapshot.height - 1)) * mapSize,
  };
}

// 把全局地图中的 X 前/Y 左坐标映射到 Canvas；建图地图与局部图共用同一栅格坐标约定。
function worldPointToScreen(xMm, yMm, snapshot, mapLeft, mapTop, mapSize) {
  const gridColumn = snapshot.originColumn - yMm / snapshot.resolutionMm;
  const gridRow = snapshot.originRow - xMm / snapshot.resolutionMm;
  return {
    x: mapLeft + (gridColumn / Math.max(1, snapshot.width - 1)) * mapSize,
    y: mapTop + (gridRow / Math.max(1, snapshot.height - 1)) * mapSize,
  };
}

// 将雷达局部点按当前位姿变换到地图坐标，供“当前扫描”图层教学使用。
function transformPointToWorld(point, pose) {
  if (!point?.valid || !pose) return null;
  const xMm = Number(point.xMm);
  const yMm = Number(point.yMm);
  const poseX = Number(pose.xMm);
  const poseY = Number(pose.yMm);
  const theta = (Number(pose.thetaDeg) * Math.PI) / 180;
  if (![xMm, yMm, poseX, poseY, theta].every(Number.isFinite)) return null;
  return {
    xMm: poseX + Math.cos(theta) * xMm - Math.sin(theta) * yMm,
    yMm: poseY + Math.sin(theta) * xMm + Math.cos(theta) * yMm,
  };
}

// 绘制带箭头头部的方向线，供前进和左右转向建议复用。
function drawArrow(context, startX, startY, endX, endY, color) {
  const angle = Math.atan2(endY - startY, endX - startX);
  const headLength = 10;
  context.strokeStyle = color;
  context.fillStyle = color;
  context.lineWidth = 3;
  context.beginPath();
  context.moveTo(startX, startY);
  context.lineTo(endX, endY);
  context.stroke();
  context.beginPath();
  context.moveTo(endX, endY);
  context.lineTo(endX - headLength * Math.cos(angle - Math.PI / 6), endY - headLength * Math.sin(angle - Math.PI / 6));
  context.lineTo(endX - headLength * Math.cos(angle + Math.PI / 6), endY - headLength * Math.sin(angle + Math.PI / 6));
  context.closePath();
  context.fill();
}

// 停止建议使用八边形和叉号，避免原实现的零长度箭头无法被学生看见。
function drawStopSymbol(context, centerX, centerY, color) {
  const radius = 18;
  context.strokeStyle = color;
  context.lineWidth = 3;
  context.beginPath();
  for (let index = 0; index < 8; index += 1) {
    const angle = Math.PI / 8 + index * Math.PI / 4;
    const x = centerX + Math.cos(angle) * radius;
    const y = centerY + Math.sin(angle) * radius;
    if (index === 0) context.moveTo(x, y);
    else context.lineTo(x, y);
  }
  context.closePath();
  context.stroke();
  context.beginPath();
  context.moveTo(centerX - 7, centerY - 7);
  context.lineTo(centerX + 7, centerY + 7);
  context.moveTo(centerX + 7, centerY - 7);
  context.lineTo(centerX - 7, centerY + 7);
  context.stroke();
}

// 绘制实验性增量地图；它只展示扫描匹配的历史证据和位姿轨迹，不把历史地图送入避障决策。
export function drawGlobalMappingMap(
  canvas,
  mappingSnapshot,
  frame,
  settings,
  mappingState = {},
  layerOptions = {},
  viewState = {},
) {
  const layout = resizeCanvas(canvas);
  if (!layout) return;
  const { context, width, height } = layout;
  const colors = themeColors();
  const now = viewState.now ?? performance.now();
  const snapshot = mappingSnapshot?.map ?? mappingSnapshot;
  // 左右各留 40px 给“Y 左 / Y 右”轴标签，避免正方形画布裁掉文字。
  const mapSize = Math.max(40, Math.min(width - 80, height - 48));
  const mapLeft = (width - mapSize) / 2;
  const mapTop = (height - mapSize) / 2;
  const centerX = mapLeft + mapSize / 2;
  const centerY = mapTop + mapSize / 2;

  // 先绘制未知背景，再按快照 revision/时间桶复用栅格位图缓存。
  context.clearRect(0, 0, width, height);
  context.fillStyle = colors.mapUnknown;
  context.fillRect(mapLeft, mapTop, mapSize, mapSize);
  context.save();
  context.beginPath();
  context.rect(mapLeft, mapTop, mapSize, mapSize);
  context.clip();
  const raster = getOccupancyRaster(canvas, snapshot, colors, now);
  if (raster) {
    context.imageSmoothingEnabled = false;
    context.drawImage(raster, mapLeft, mapTop, mapSize, mapSize);
  }

  if (snapshot?.width && snapshot?.height) {
    // 每米一条主网格线，帮助学生把全局地图像素与真实距离对应起来。
    const cellsPerMetre = 1000 / Math.max(1, snapshot.resolutionMm);
    const pixelsPerCell = mapSize / Math.max(1, snapshot.width - 1);
    context.strokeStyle = colors.mapGridMajor;
    context.lineWidth = 1;
    context.beginPath();
    for (let offset = 0; offset <= Math.max(snapshot.originColumn, snapshot.originRow); offset += cellsPerMetre) {
      for (const direction of offset === 0 ? [1] : [-1, 1]) {
        const x = centerX + direction * offset * pixelsPerCell;
        const y = centerY + direction * offset * pixelsPerCell;
        context.moveTo(x, mapTop);
        context.lineTo(x, mapTop + mapSize);
        context.moveTo(mapLeft, y);
        context.lineTo(mapLeft + mapSize, y);
      }
    }
    context.stroke();
  }

  // 轨迹用折线保留运动方向教学信息；轨迹长度由算法端固定上限控制。
  const trajectory = mappingState.path ?? mappingState.trajectory ?? [];
  if (layerOptions.showMappingTrajectory !== false && trajectory.length > 1 && snapshot) {
    // 轨迹可能在固定地图边界外，裁剪后不会覆盖坐标标签和状态文字。
    context.save();
    context.beginPath();
    context.rect(mapLeft, mapTop, mapSize, mapSize);
    context.clip();
    context.strokeStyle = colors.accent ?? colors.point;
    context.globalAlpha = 0.9;
    context.lineWidth = 2;
    context.beginPath();
    trajectory.forEach((pose, index) => {
      const position = worldPointToScreen(Number(pose.xMm), Number(pose.yMm), snapshot, mapLeft, mapTop, mapSize);
      if (index === 0) context.moveTo(position.x, position.y);
      else context.lineTo(position.x, position.y);
    });
    context.stroke();
    context.globalAlpha = 1;
    context.restore();
  }

  // 当前扫描只作为地图覆盖层显示，不修改历史地图，也不参与避障建议。
  const pose = mappingState.pose;
  const validPoints = frame?.points?.filter((point) => point.valid) ?? [];
  if (layerOptions.showMappingScan !== false && snapshot && pose && validPoints.length) {
    // 全局图的实时扫描同样合并为一次填充，避免建图模式因逐点提交而周期性卡顿。
    context.fillStyle = colors.mapLiveHit;
    context.beginPath();
    for (const point of validPoints) {
      const worldPoint = transformPointToWorld(point, pose);
      if (!worldPoint) continue;
      const position = worldPointToScreen(worldPoint.xMm, worldPoint.yMm, snapshot, mapLeft, mapTop, mapSize);
      context.moveTo(position.x + 2, position.y);
      context.arc(position.x, position.y, 2, 0, Math.PI * 2);
    }
    context.fill();
  }
  context.restore();

  // 当前位姿使用圆形 footprint 和朝向箭头；它不是机器人真实底盘尺寸。
  if (snapshot && pose) {
    // 位姿接近地图边界时裁剪箭头，避免越界线条遮挡地图标题。
    context.save();
    context.beginPath();
    context.rect(mapLeft, mapTop, mapSize, mapSize);
    context.clip();
    const posePosition = worldPointToScreen(Number(pose.xMm), Number(pose.yMm), snapshot, mapLeft, mapTop, mapSize);
    const theta = (Number(pose.thetaDeg) * Math.PI) / 180;
    context.strokeStyle = colors.mapOrigin;
    context.fillStyle = colors.mapOrigin;
    context.lineWidth = 2;
    context.beginPath();
    context.arc(posePosition.x, posePosition.y, 10, 0, Math.PI * 2);
    context.stroke();
    if (Number.isFinite(theta)) {
      const arrowLengthMm = Math.max(
        snapshot.resolutionMm * 8,
        snapshot.resolutionMm * Math.min(snapshot.width, snapshot.height) * 0.05,
      );
      const heading = worldPointToScreen(
        Number(pose.xMm) + Math.cos(theta) * arrowLengthMm,
        Number(pose.yMm) + Math.sin(theta) * arrowLengthMm,
        snapshot,
        mapLeft,
        mapTop,
        mapSize,
      );
      drawArrow(context, posePosition.x, posePosition.y, heading.x, heading.y, colors.mapOrigin);
    }
    context.restore();
  }

  // 地图边缘说明当前坐标系、匹配质量和跟踪状态，便于课堂解释“漂移”来源。
  context.textBaseline = "middle";
  context.textAlign = "left";
  context.fillStyle = colors.text;
  context.font = "600 11px Consolas, monospace";
  context.fillText(snapshot?.frameId ?? mappingState.frameId ?? "map", mapLeft + 8, mapTop + 12);
  context.fillStyle = colors.muted;
  context.font = "11px Segoe UI, sans-serif";
  context.textAlign = "center";
  context.fillText("X 前", centerX, mapTop - 12);
  context.fillText("Y 左", mapLeft - 18, centerY);
  context.fillText("Y 右", mapLeft + mapSize + 18, centerY);
  const match = mappingState.match ?? {};
  const ratio = Number(match.ratio ?? mappingState.matchQuality);
  const qualityText = Number.isFinite(ratio) ? `匹配 ${(ratio * (ratio <= 1 ? 100 : 1)).toFixed(0)}%` : "匹配质量 --";
  const trackingMode = mappingState.mode ?? mappingState.trackingState ?? "ready";
  const trackingText = mappingStatusLabel(trackingMode);
  context.fillText(`${qualityText} · ${trackingText}`, centerX, mapTop + mapSize + 16);

  if (!snapshot || !snapshot.scores?.length) {
    context.fillStyle = colors.text;
    context.font = "500 13px Segoe UI, sans-serif";
    context.fillText("尚未生成建图数据", centerX, centerY);
  }

  // 暂停、丢失匹配或数据过期时必须遮罩，避免把旧地图误认为正在跟踪。
  const mode = String(mappingState.mode ?? mappingState.trackingState ?? "").toLowerCase();
  const stale = viewState.stale || viewState.paused || mode === "paused" || mode === "lost";
  if (stale) {
    context.fillStyle = colors.overlay;
    context.fillRect(mapLeft, mapTop, mapSize, mapSize);
    context.fillStyle = mode === "lost" ? colors.warning : colors.muted;
    context.font = "500 13px Segoe UI, sans-serif";
    context.textAlign = "center";
    const message = mode === "lost" ? "匹配质量不足 · 暂停累积" : mode === "paused" ? "建图已暂停" : "数据过期 · 保留历史图";
    context.fillText(message, centerX, centerY);
  }
}

// 兼容不同教学模块的命名，统一走全局增量地图绘制实现。
export const drawMappingMap = drawGlobalMappingMap;

// 把扫描匹配内部状态转换为教学界面可读文字，避免 app.js 在多个分支重复定义中文标签。
export function mappingStatusLabel(mode) {
  return {
    ready: "未开始",
    tracking: "建图中",
    paused: "已暂停",
    lost: "匹配丢失",
    disabled: "未启用",
  }[mode] ?? "等待数据";
}

// 统一格式化匹配质量；ratio 既兼容 0～1 比例，也兼容算法端直接给出的百分数。
export function formatMappingMatchQuality(match = {}) {
  const ratio = Number(match.ratio ?? match.quality ?? match.matchQuality);
  if (!Number.isFinite(ratio)) return "--";
  const percentage = ratio <= 1 ? ratio * 100 : ratio;
  return `${Math.max(0, Math.min(100, percentage)).toFixed(0)}%`;
}

// 绘制固定雷达坐标系下的 RViz 风格占据栅格、当前扫描和教学覆盖层。
export function drawOccupancyMap(canvas, snapshot, frame, settings, decision, layerOptions = {}, viewState = {}) {
  // app.js 可通过 viewState.mappingMode 切换同一个 mapCanvas 的历史建图视图。
  const mappingState = viewState.mapping ?? viewState.mappingSnapshot;
  if (viewState.mappingMode === "mapping" && mappingState) {
    // 两组图层分开保存时在渲染入口合并，保证局部图的决策开关不会意外隐藏建图轨迹。
    const mappingLayers = viewState.mappingLayers ?? {};
    const mergedLayers = { ...layerOptions, ...mappingLayers };
    return drawGlobalMappingMap(canvas, mappingState.map ?? mappingState, frame, settings, mappingState, mergedLayers, viewState);
  }
  const layout = resizeCanvas(canvas);
  if (!layout) return;
  const { context, width, height } = layout;
  const colors = themeColors();
  const now = viewState.now ?? performance.now();
  // 左右各留 40px 给“Y 左 / Y 右”轴标签，避免正方形画布裁掉文字。
  const mapSize = Math.max(40, Math.min(width - 80, height - 48));
  const mapLeft = (width - mapSize) / 2;
  const mapTop = (height - mapSize) / 2;
  const centerX = mapLeft + mapSize / 2;
  const centerY = mapTop + mapSize / 2;

  context.clearRect(0, 0, width, height);
  context.fillStyle = colors.mapUnknown;
  context.fillRect(mapLeft, mapTop, mapSize, mapSize);
  context.save();
  context.beginPath();
  context.rect(mapLeft, mapTop, mapSize, mapSize);
  context.clip();

  const raster = getOccupancyRaster(canvas, snapshot, colors, now);
  if (raster) {
    context.imageSmoothingEnabled = false;
    context.drawImage(raster, mapLeft, mapTop, mapSize, mapSize);
  }

  if (snapshot && viewState.showCoordinateGrid !== false) {
    // 每米绘制主网格，使栅格分辨率和真实尺寸之间的关系可以直接讲解。
    const cellsPerMetre = 1000 / snapshot.resolutionMm;
    const pixelsPerCell = mapSize / Math.max(1, snapshot.width - 1);
    context.strokeStyle = colors.mapGridMajor;
    context.lineWidth = 1;
    context.beginPath();
    for (let offset = 0; offset <= snapshot.originColumn; offset += cellsPerMetre) {
      for (const direction of offset === 0 ? [1] : [-1, 1]) {
        const x = centerX + direction * offset * pixelsPerCell;
        const y = centerY + direction * offset * pixelsPerCell;
        context.moveTo(x, mapTop);
        context.lineTo(x, mapTop + mapSize);
        context.moveTo(mapLeft, y);
        context.lineTo(mapLeft + mapSize, y);
      }
    }
    context.stroke();
  }

  // 实时包覆盖层把“角度 -> 距离 -> X/Y”直接投影到笛卡尔空间，不写入历史栅格。
  const liveProgress = viewState.liveProgress;
  const livePacket = viewState.latestPacket;
  if (snapshot && liveProgress && viewState.showLiveBeam !== false) {
    const beamPoint = { xMm: Math.cos((liveProgress.currentAngleDeg * Math.PI) / 180) * settings.maxRangeMm, yMm: Math.sin((liveProgress.currentAngleDeg * Math.PI) / 180) * settings.maxRangeMm };
    const beamScreen = mapPointToScreen(beamPoint, snapshot, mapLeft, mapTop, mapSize);
    context.save(); context.globalAlpha = 0.65; context.strokeStyle = colors.accent; context.lineWidth = 2;
    context.beginPath(); context.moveTo(centerX, centerY); context.lineTo(beamScreen.x, beamScreen.y); context.stroke(); context.restore();
  }
  if (snapshot && livePacket && viewState.showPacketEcho !== false) {
    context.fillStyle = colors.mapLiveHit; context.beginPath();
    for (const point of livePacket.points ?? []) {
      if (!point.valid) continue;
      const position = mapPointToScreen(point, snapshot, mapLeft, mapTop, mapSize);
      context.moveTo(position.x + 3, position.y); context.arc(position.x, position.y, 3, 0, Math.PI * 2);
    }
    context.fill();
  }
  if (snapshot && viewState.showSweptSector !== false && liveProgress) {
    context.save(); context.globalAlpha = 0.12; context.strokeStyle = colors.accent; context.lineWidth = 1;
    context.beginPath();
    const startPoint = mapPointToScreen({ xMm: Math.cos((liveProgress.packetStartAngleDeg * Math.PI) / 180) * settings.maxRangeMm, yMm: Math.sin((liveProgress.packetStartAngleDeg * Math.PI) / 180) * settings.maxRangeMm }, snapshot, mapLeft, mapTop, mapSize);
    const endPoint = mapPointToScreen({ xMm: Math.cos((liveProgress.packetEndAngleDeg * Math.PI) / 180) * settings.maxRangeMm, yMm: Math.sin((liveProgress.packetEndAngleDeg * Math.PI) / 180) * settings.maxRangeMm }, snapshot, mapLeft, mapTop, mapSize);
    context.moveTo(centerX, centerY); context.lineTo(startPoint.x, startPoint.y); context.moveTo(centerX, centerY); context.lineTo(endPoint.x, endPoint.y); context.stroke(); context.restore();
  }

  const validPoints = frame?.points?.filter((point) => point.valid) ?? [];
  if (snapshot && layerOptions.showLiveRays !== false && validPoints.length) {
    // 所有射线合并为一个 Path，避免数百个回波分别触发 Canvas 描边。
    context.save();
    context.globalAlpha = 0.18;
    context.strokeStyle = colors.mapRay;
    context.lineWidth = 0.8;
    context.beginPath();
    for (const point of validPoints) {
      const position = mapPointToScreen(point, snapshot, mapLeft, mapTop, mapSize);
      context.moveTo(centerX, centerY);
      context.lineTo(position.x, position.y);
    }
    context.stroke();
    context.restore();
  }

  if (snapshot && validPoints.length) {
    // 当前回波颜色一致，合并成一个路径后一次填充可显著减少高点数扫描的绘制调用。
    context.fillStyle = colors.mapLiveHit;
    context.beginPath();
    for (const point of validPoints) {
      const position = mapPointToScreen(point, snapshot, mapLeft, mapTop, mapSize);
      context.moveTo(position.x + 2.2, position.y);
      context.arc(position.x, position.y, 2.2, 0, Math.PI * 2);
    }
    context.fill();
  }

  if (snapshot && layerOptions.showClusters !== false) {
    for (const cluster of frame?.clusters ?? []) {
      if (!cluster.points?.length) continue;
      context.save();
      context.strokeStyle = colors.cluster;
      context.fillStyle = colors.cluster;
      context.lineWidth = 1.5;
      context.setLineDash([6, 4]);
      context.beginPath();
      cluster.points.forEach((point, index) => {
        const position = mapPointToScreen(point, snapshot, mapLeft, mapTop, mapSize);
        if (index === 0) context.moveTo(position.x, position.y);
        else context.lineTo(position.x, position.y);
      });
      context.stroke();
      context.setLineDash([]);
      const centroid = mapPointToScreen(cluster.centroid, snapshot, mapLeft, mapTop, mapSize);
      context.beginPath();
      context.arc(centroid.x, centroid.y, 5, 0, Math.PI * 2);
      context.stroke();
      context.font = "600 11px Segoe UI, sans-serif";
      context.fillText(`#${cluster.id}`, centroid.x + 11, centroid.y - 10);
      context.restore();
    }
  }
  context.restore();

  // 雷达中心采用圆形 footprint 和向前三角形；它只是坐标原点示意，不代表真实底盘尺寸。
  context.strokeStyle = colors.mapOrigin;
  context.fillStyle = colors.mapOrigin;
  context.lineWidth = 2;
  context.beginPath();
  context.arc(centerX, centerY, 12, 0, Math.PI * 2);
  context.stroke();
  context.beginPath();
  context.moveTo(centerX, centerY - 17);
  context.lineTo(centerX - 6, centerY - 7);
  context.lineTo(centerX + 6, centerY - 7);
  context.closePath();
  context.fill();

  if (layerOptions.showDecision !== false && decision?.action) {
    const actionColor = decision.action === "stop" ? colors.danger : decision.action === "forward" ? colors.safe : colors.warning;
    if (decision.action === "stop") {
      drawStopSymbol(context, centerX, centerY - 42, actionColor);
    } else {
      const horizontal = decision.action === "turn-left" ? -34 : decision.action === "turn-right" ? 34 : 0;
      drawArrow(context, centerX, centerY - 18, centerX + horizontal, centerY - 65, actionColor);
    }
  }

  context.textBaseline = "middle";
  context.fillStyle = colors.text;
  context.font = "600 11px Consolas, monospace";
  context.textAlign = "left";
  context.fillText(snapshot?.frameId ?? "lidar_link", mapLeft + 8, mapTop + 12);
  context.fillStyle = colors.muted;
  context.font = "11px Segoe UI, sans-serif";
  context.textAlign = "center";
  context.fillText("X 前", centerX, mapTop - 12);
  context.fillText("Y 左", mapLeft - 18, centerY);
  context.fillText("Y 右", mapLeft + mapSize + 18, centerY);
  context.fillText("示意 footprint", centerX, centerY + 28);
  context.fillStyle = colors.text;
  context.font = "600 12px Segoe UI, sans-serif";
  context.fillText(
    layerOptions.showDecision === false ? "决策图层已隐藏" : decisionLabel(decision?.action),
    centerX,
    mapTop + mapSize + 16,
  );

  if (!frame?.points?.length) {
    context.fillStyle = colors.text;
    context.font = "500 13px Segoe UI, sans-serif";
    context.fillText("等待串口数据", centerX, centerY - 34);
  }
}

// 在旧帧仍可见但已经超过实时期限时加上文字遮罩，避免学生把旧点云当成当前状态。
export function drawStaleOverlay(canvas, text) {
  const layout = resizeCanvas(canvas);
  if (!layout) return;
  const { context, width, height } = layout;
  const colors = themeColors();
  context.fillStyle = colors.overlay;
  context.fillRect(0, 0, width, height);
  context.fillStyle = colors.warning;
  context.font = "500 14px Segoe UI, sans-serif";
  context.textAlign = "center";
  context.textBaseline = "middle";
  context.fillText(text, width / 2, height / 2);
}

// 把实时、暂停和过期状态统一折叠成安全显示决策，便于自动测试“不输出前进”的约束。
export function resolveDisplayDecision(frame, { stale = false, paused = false } = {}) {
  if (!frame) return null;
  if (stale) {
    return { action: "stop", reason: "超过 500ms 未收到新扫描，安全起见不输出前进建议" };
  }
  if (paused) {
    return { action: "stop", reason: "已请求停止扫描，等待重新开始后的新数据" };
  }
  return frame.decision;
}

// 把内部动作值转换成课堂界面中的中文文本。
export function decisionLabel(action) {
  return {
    forward: "建议：前进",
    "turn-left": "建议：左转",
    "turn-right": "建议：右转",
    stop: "建议：停止",
    "no-data": "暂无决策",
  }[action] ?? "暂无决策";
}

// 根据鼠标/触摸位置选择最近的有效点，返回原始数组下标供点位详情面板使用。
export function hitTestPolar(canvas, frame, settings, clientX, clientY) {
  if (!frame?.points?.length) return -1;
  const rect = canvas.getBoundingClientRect();
  const localX = clientX - rect.left;
  const localY = clientY - rect.top;
  const centerX = rect.width / 2;
  const centerY = rect.height / 2;
  const radius = Math.max(20, Math.min(rect.width, rect.height) / 2 - 28);
  const scale = radius / Math.max(1, settings.maxRangeMm);
  let nearestIndex = -1;
  let nearestDistance = 14;
  for (const point of frame.points) {
    if (!point.valid) continue;
    const position = polarToScreen(point.angleDeg, point.distanceMm, centerX, centerY, scale);
    const distance = Math.hypot(position.x - localX, position.y - localY);
    if (distance < nearestDistance) {
      nearestDistance = distance;
      nearestIndex = point.index;
    }
  }
  return nearestIndex;
}
