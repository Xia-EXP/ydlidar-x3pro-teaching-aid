// YDLIDAR X3/X3 PRO 无强度三角测距协议的默认参数。
export const PROTOCOL_DEFAULTS = Object.freeze({
  baudRate: 115200,
  maxLsn: 40,
  sampleBytes: 2,
  distanceScale: 4,
  maxScanPoints: 7200,
  minDistanceMm: 100,
  maxDistanceMm: 8000,
});

// 将任意角度折叠到 [0, 360) 区间，保证绘图和扇区判断使用同一坐标范围。
export function normalizeAngle(angleDeg) {
  const normalized = angleDeg % 360;
  return normalized < 0 ? normalized + 360 : normalized;
}

// 将一个小端序 16 位字段转换为 JavaScript 数字，供协议字段和距离计算共用。
export function readUint16LE(bytes, offset) {
  return bytes[offset] | (bytes[offset + 1] << 8);
}

// 生成短小的十六进制文本，让教学面板可以直接对应串口原始字节。
export function bytesToHex(bytes, limit = 96) {
  const view = bytes instanceof Uint8Array ? bytes : Uint8Array.from(bytes);
  const shown = Array.from(view.slice(0, limit), (byte) => byte.toString(16).padStart(2, "0").toUpperCase());
  const suffix = view.length > limit ? ` …(+${view.length - limit} bytes)` : "";
  return `${shown.join(" ")}${suffix}`;
}

// 按公开协议计算 16 位 XOR 校验值，校验字段自身不参与异或。
export function calculateChecksum(ct, lsn, fsa, lsa, samples) {
  let checksum = 0x55aa;
  checksum ^= fsa;
  for (const sample of samples) {
    checksum ^= sample;
  }
  checksum ^= (lsn << 8) | ct;
  checksum ^= lsa;
  return checksum & 0xffff;
}

// 将一个完整数据包解码为教学层可使用的字段和扫描点。
export function decodePacket(input, options = {}) {
  const bytes = input instanceof Uint8Array ? input : Uint8Array.from(input);
  const config = { ...PROTOCOL_DEFAULTS, ...options };
  if (bytes.length < 10) {
    return { valid: false, error: "packet-too-short" };
  }
  if (bytes[0] !== 0xaa || bytes[1] !== 0x55) {
    return { valid: false, error: "bad-header" };
  }

  const ct = bytes[2];
  const lsn = bytes[3];
  if (lsn < 1 || lsn > config.maxLsn) {
    return { valid: false, error: "invalid-sample-count", ct, lsn };
  }
  const expectedLength = 10 + config.sampleBytes * lsn;
  if (bytes.length !== expectedLength) {
    return { valid: false, error: "wrong-packet-length", ct, lsn, expectedLength };
  }

  const fsa = readUint16LE(bytes, 4);
  const lsa = readUint16LE(bytes, 6);
  // FSA/LSA 的最低位是协议角度校验标志，异常时拒绝该候选包并重新同步。
  if ((fsa & 0x01) !== 1 || (lsa & 0x01) !== 1) {
    return { valid: false, error: "invalid-angle-check-bit", ct, lsn, fsa, lsa };
  }
  const receivedChecksum = readUint16LE(bytes, 8);
  const samples = [];
  for (let index = 0; index < lsn; index += 1) {
    const offset = 10 + index * config.sampleBytes;
    samples.push(readUint16LE(bytes, offset));
  }
  const calculatedChecksum = calculateChecksum(ct, lsn, fsa, lsa, samples);
  if (calculatedChecksum !== receivedChecksum) {
    return {
      valid: false,
      error: "checksum-mismatch",
      ct,
      lsn,
      fsa,
      lsa,
      receivedChecksum,
      calculatedChecksum,
      raw: bytes,
    };
  }

  // 起始包通常只有一个占位点；它的频率字段描述上一圈，不能当成障碍物。
  const isStartPacket = (ct & 0x01) === 1;
  const startAngle = (fsa >> 1) / 64;
  const endAngle = (lsa >> 1) / 64;
  let angleDifference = endAngle - startAngle;
  if (angleDifference < 0) angleDifference += 360;

  const points = [];
  for (let index = 0; index < lsn; index += 1) {
    const rawDistance = samples[index];
    const distanceMm = rawDistance / config.distanceScale;
    const rawAngleDeg = normalizeAngle(lsn > 1 ? startAngle + (angleDifference * index) / (lsn - 1) : startAngle);
    let angleDeg = rawAngleDeg;
    let angleCorrectionDeg = 0;

    // 三角雷达的二级角度修正使用毫米单位；无回波时跳过反正切计算。
    if (distanceMm > 0) {
      const correction = Math.atan((21.8 * (155.3 - distanceMm)) / (155.3 * distanceMm));
      angleCorrectionDeg = (correction * 180) / Math.PI;
      angleDeg += angleCorrectionDeg;
    }
    const invalidReason = isStartPacket
      ? "start-placeholder"
      : rawDistance === 0
        ? "zero-distance"
        : distanceMm < config.minDistanceMm
          ? "below-min-range"
          : distanceMm > config.maxDistanceMm
            ? "over-max-range"
            : null;
    points.push({
      index,
      packetIndex: -1,
      sampleIndex: index,
      angleDeg: normalizeAngle(angleDeg),
      rawAngleDeg,
      angleCorrectionDeg,
      distanceMm,
      rawDistance,
      valid: invalidReason === null,
      invalidReason,
    });
  }

  return {
    valid: true,
    raw: bytes,
    ct,
    lsn,
    fsa,
    lsa,
    cs: receivedChecksum,
    calculatedChecksum,
    startAngle,
    endAngle,
    scanHz: isStartPacket ? (ct >> 1) / 10 : 0,
    isStartPacket,
    points: isStartPacket ? [] : points,
  };
}

// 从任意串口分块中提取完整数据包，负责错位恢复、坏包统计和内存上限。
export class PacketStreamDecoder {
  constructor(options = {}) {
    this.options = { ...PROTOCOL_DEFAULTS, ...options };
    this.buffer = [];
    this.stats = {
      packets: 0,
      checksumErrors: 0,
      malformedPackets: 0,
      droppedBytes: 0,
    };
  }

  // 把浏览器 ReadableStream 的一个 Uint8Array 追加到解析缓冲区。
  push(chunk) {
    const bytes = chunk instanceof Uint8Array ? chunk : new Uint8Array(chunk);
    for (const byte of bytes) this.buffer.push(byte);
    const packets = [];

    // 循环只在缓冲区存在一个完整候选包时消费数据，避免把半包误判成坏包。
    while (this.buffer.length >= 2) {
      let headerIndex = -1;
      for (let index = 0; index < this.buffer.length - 1; index += 1) {
        if (this.buffer[index] === 0xaa && this.buffer[index + 1] === 0x55) {
          headerIndex = index;
          break;
        }
      }
      if (headerIndex < 0) {
        // 保留末尾 AA，防止包头恰好跨越两个串口分块。
        const keep = this.buffer[this.buffer.length - 1] === 0xaa ? 1 : 0;
        this.stats.droppedBytes += this.buffer.length - keep;
        this.buffer = keep ? [0xaa] : [];
        break;
      }
      if (headerIndex > 0) {
        this.stats.droppedBytes += headerIndex;
        this.buffer.splice(0, headerIndex);
      }
      if (this.buffer.length < 10) break;

      const lsn = this.buffer[3];
      if (lsn < 1 || lsn > this.options.maxLsn) {
        this.stats.malformedPackets += 1;
        this.stats.droppedBytes += 1;
        this.buffer.shift();
        continue;
      }
      // 先检查固定长度的角度标志，避免伪造的大 LSN 包把后续真实数据长期卡在缓冲区。
      const fsa = this.buffer[4] | (this.buffer[5] << 8);
      const lsa = this.buffer[6] | (this.buffer[7] << 8);
      if ((fsa & 0x01) !== 1 || (lsa & 0x01) !== 1) {
        this.stats.malformedPackets += 1;
        this.stats.droppedBytes += 1;
        this.buffer.shift();
        continue;
      }
      const packetLength = 10 + this.options.sampleBytes * lsn;
      if (this.buffer.length < packetLength) break;

      const candidate = Uint8Array.from(this.buffer.slice(0, packetLength));
      const packet = decodePacket(candidate, this.options);
      if (!packet.valid) {
        if (packet.error === "checksum-mismatch") this.stats.checksumErrors += 1;
        else this.stats.malformedPackets += 1;
        // LSN 已经给出了候选包长度，整包丢弃可避免 payload 中偶然出现 AA55 造成假同步。
        this.stats.droppedBytes += packetLength;
        this.buffer.splice(0, packetLength);
        continue;
      }
      this.buffer.splice(0, packetLength);
      this.stats.packets += 1;
      packets.push(packet);
    }
    return packets;
  }

  // 返回只读诊断快照，避免界面意外修改解析器内部计数。
  getStats() {
    return { ...this.stats, bufferedBytes: this.buffer.length };
  }

  // 断开或更换设备时清空半包和累计诊断，防止两台设备的数据被拼接。
  reset() {
    this.buffer = [];
    this.stats = {
      packets: 0,
      checksumErrors: 0,
      malformedPackets: 0,
      droppedBytes: 0,
    };
  }
}

// 将连续数据包按起始包边界聚合成一圈扫描，保留原始数据供教学诊断。
export class ScanAssembler {
  constructor(options = {}) {
    this.maxScanPoints = options.maxScanPoints ?? PROTOCOL_DEFAULTS.maxScanPoints;
    this.points = [];
    this.packetCount = 0;
    this.lastStartTimestamp = 0;
    this.pendingScanHz = 0;
    this.started = false;
    this.scanSequence = 0;
    this.progress = null;
    this.lastAngleDeg = null;
    this.direction = "unknown";
  }

  // 返回包级实时进度；只保存最新包，界面不积累高频历史队列。
  getProgress() {
    return this.progress ? { ...this.progress, currentPacket: this.progress.currentPacket ? { ...this.progress.currentPacket } : null } : null;
  }

  // 计算跨越 0/360 度时的最短有向角度差，用于推断真实旋转方向和扫过角度。
  static signedAngleDelta(previous, current) {
    let delta = normalizeAngle(current) - normalizeAngle(previous);
    if (delta > 180) delta -= 360;
    if (delta < -180) delta += 360;
    return delta;
  }

  // 输入一个已校验的数据包，可能返回上一圈完成的 ScanFrame，也可能返回 null。
  push(packet, timestamp = performance.now()) {
    if (!packet.valid) return null;
    if (packet.isStartPacket) {
      // 第一枚起始包只建立同步，之前收到的 normal 包不能被误认为完整一圈。
      const completed = this.started && this.points.length > 0
        ? {
            timestamp,
            scanHz: packet.scanHz || this.pendingScanHz,
            measuredScanHz: this.lastStartTimestamp > 0 && timestamp > this.lastStartTimestamp ? 1000 / (timestamp - this.lastStartTimestamp) : 0,
            points: this.points,
            packetCount: this.packetCount,
          }
        : null;
      this.points = [];
      this.packetCount = 0;
      this.pendingScanHz = packet.scanHz || this.pendingScanHz;
      this.lastStartTimestamp = timestamp;
      this.started = true;
      this.scanSequence += 1;
      this.lastAngleDeg = null;
      this.direction = "unknown";
      this.progress = {
        timestamp,
        scanSequence: this.scanSequence,
        direction: this.direction,
        scanStartAngleDeg: packet.startAngle,
        packetStartAngleDeg: packet.startAngle,
        packetEndAngleDeg: packet.endAngle,
        currentAngleDeg: packet.startAngle,
        sweptAngleDeg: 0,
        progress01: 0,
        packetCount: 0,
        sampleCount: 0,
        validCount: 0,
        invalidCount: packet.lsn,
        currentPacket: this.packetSummary(packet),
      };
      return completed;
    }

    // 在首次起始包之前忽略 normal 包，避免断线重连残留数据污染第一圈。
    if (!this.started) return null;
    // 起始包丢失时主动丢弃残帧并重新同步，避免异常串口流让内存无限增长。
    if (this.points.length + packet.points.length > this.maxScanPoints) {
      this.points = [];
      this.packetCount = 0;
      this.started = false;
      return null;
    }
    const packetIndex = this.packetCount;
    const points = packet.points.map((point) => ({ ...point, packetIndex, sampleIndex: point.sampleIndex ?? 0 }));
    this.points.push(...points);
    this.packetCount += 1;
    const delta = this.lastAngleDeg === null ? 0 : ScanAssembler.signedAngleDelta(this.lastAngleDeg, packet.endAngle);
    if (Math.abs(delta) >= 0.05) this.direction = delta > 0 ? "ccw" : "cw";
    this.lastAngleDeg = packet.endAngle;
    const startAngle = this.progress?.scanStartAngleDeg ?? packet.startAngle;
    let swept = Math.abs(ScanAssembler.signedAngleDelta(startAngle, packet.endAngle));
    if (this.packetCount > 1 && swept < 5) swept = Math.min(360, (this.progress?.sweptAngleDeg ?? 0) + Math.abs(delta));
    swept = Math.min(360, swept);
    const validCount = this.points.reduce((sum, point) => sum + (point.valid ? 1 : 0), 0);
    this.progress = {
      timestamp,
      scanSequence: this.scanSequence,
      direction: this.direction,
      scanStartAngleDeg: startAngle,
      packetStartAngleDeg: packet.startAngle,
      packetEndAngleDeg: packet.endAngle,
      currentAngleDeg: packet.endAngle,
      sweptAngleDeg: swept,
      progress01: Math.min(1, swept / 360),
      packetCount: this.packetCount,
      sampleCount: this.points.length,
      validCount,
      invalidCount: this.points.length - validCount,
      currentPacket: this.packetSummary(packet),
    };
    return null;
  }

  // 把当前包的协议字段单独保存，供教学面板和实时扇区覆盖层使用。
  packetSummary(packet) {
    return {
      raw: packet.raw,
      ct: packet.ct,
      lsn: packet.lsn,
      fsa: packet.fsa,
      lsa: packet.lsa,
      cs: packet.cs,
      calculatedChecksum: packet.calculatedChecksum,
      startAngle: packet.startAngle,
      endAngle: packet.endAngle,
      scanHz: packet.scanHz,
      points: packet.points,
    };
  }

  // 测试和断开连接时显式清空未完成一圈，避免下次连接混入旧数据。
  reset() {
    this.points = [];
    this.packetCount = 0;
    this.lastStartTimestamp = 0;
    this.pendingScanHz = 0;
    this.started = false;
    this.scanSequence = 0;
    this.progress = null;
    this.lastAngleDeg = null;
    this.direction = "unknown";
  }
}
