// 资料规格与协议实时可测字段分开，避免把型号宣传参数误当成当前设备实测值。
export const YDLIDAR_X3_PRO_PROFILE = Object.freeze({
  model: "YDLIDAR X3 PRO",
  measurementPrinciple: "三角测距",
  coverageDeg: 360,
  referenceRangeMm: { min: 100, max: 8000 },
  intensitySupported: false,
  serialDefaults: { baudRate: 115200, dataBits: 8, stopBits: 1, parity: "none", flowControl: "none" },
  sourceLabel: "Yahboom YDLIDAR-X3 教程与公开协议参考",
  sourceUrl: "https://www.yahboom.com/study/YDLIDAR-X3",
  notes: "参考规格，需以实机复核；本协议不提供温度、固件版本或真实电机转速。",
});

// 生成界面可直接显示的资料字段，保留来源链接和复核边界。
export function getDeviceProfile() {
  return YDLIDAR_X3_PRO_PROFILE;
}
