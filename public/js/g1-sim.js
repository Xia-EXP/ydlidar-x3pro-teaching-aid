// G1 仿真视图：加载宇树官方 G1 29 自由度模型，把雷达点云和避障建议转成机器人在场景中的“预演”动作。
// 仅作课堂可视化：不发送任何控制命令；预演结束后机器人回到雷达所在位置，点云始终是雷达原位置的真实扫描。
import * as THREE from 'three';
import { STLLoader } from 'three/addons/loaders/STLLoader.js';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';

const MODEL_URL = '/models/g1/g1_29dof.urdf';
const WALK_SPEED = 0.45; // m/s，课堂演示用的平稳步速。
const STEP_HZ = 1.7;
const TURN_RAD = Math.PI / 4;
const TURN_SECONDS = 1.4;
const HOLD_SECONDS = 0.8; // 预演走完后停顿，再回到起点重放。
const ADOPT_DELAY_MS = 600; // 新建议需持续这么久才切换预演，避免 7Hz 扫描抖动导致机器人来回抽动。
const MAX_COLUMNS = 3000;

const COLORS = {
  near: new THREE.Color('#ff6b5b'),
  caution: new THREE.Color('#f5a524'),
  far: new THREE.Color('#4fc6d6'),
  open: '#2fbf71',
  caution2: '#f5a524',
  blocked: '#ff6b5b',
  unknown: '#5b6474',
};
const ACTION_TEXT = {
  forward: '前进',
  'turn-left': '左转',
  'turn-right': '右转',
  stop: '停止',
};

// ---------- URDF 解析：只实现本模型用到的 link/joint/visual/mesh 子集 ----------

function parseVector(text, fallback = [0, 0, 0]) {
  if (!text) return fallback;
  const values = text.trim().split(/\s+/).map(Number);
  return values.length === 3 && values.every(Number.isFinite) ? values : fallback;
}

// URDF 的 rpy 为固定轴 X→Y→Z，等价于 three.js 的 'ZYX' 欧拉顺序。
function applyOrigin(object, originElement) {
  const [x, y, z] = parseVector(originElement?.getAttribute('xyz'));
  const [roll, pitch, yaw] = parseVector(originElement?.getAttribute('rpy'));
  object.position.set(x, y, z);
  object.rotation.set(roll, pitch, yaw, 'ZYX');
}

async function loadRobot() {
  const response = await fetch(MODEL_URL);
  if (!response.ok) throw new Error(`G1 模型读取失败：HTTP ${response.status}`);
  const xml = new DOMParser().parseFromString(await response.text(), 'application/xml');
  const baseUrl = MODEL_URL.slice(0, MODEL_URL.lastIndexOf('/') + 1);
  const loader = new STLLoader();
  const geometryCache = new Map();
  const links = new Map();
  const meshJobs = [];

  for (const linkElement of xml.querySelectorAll('robot > link')) {
    const link = new THREE.Group();
    link.name = linkElement.getAttribute('name');
    for (const visual of linkElement.querySelectorAll(':scope > visual')) {
      const filename = visual.querySelector('geometry > mesh')?.getAttribute('filename');
      if (!filename) continue;
      const holder = new THREE.Group();
      applyOrigin(holder, visual.querySelector(':scope > origin'));
      link.add(holder);
      const [r, g, b] = (visual.querySelector('material > color')?.getAttribute('rgba') ?? '0.7 0.7 0.7 1').split(/\s+/).map(Number);
      const material = new THREE.MeshStandardMaterial({ color: new THREE.Color(r, g, b), metalness: 0.25, roughness: 0.55 });
      if (!geometryCache.has(filename)) geometryCache.set(filename, loader.loadAsync(baseUrl + filename));
      meshJobs.push(geometryCache.get(filename).then((geometry) => {
        const mesh = new THREE.Mesh(geometry, material);
        mesh.castShadow = true;
        holder.add(mesh);
      }));
    }
    links.set(link.name, link);
  }

  const joints = new Map();
  const childLinks = new Set();
  for (const jointElement of xml.querySelectorAll('robot > joint')) {
    const type = jointElement.getAttribute('type');
    const parent = links.get(jointElement.querySelector('parent')?.getAttribute('link'));
    const child = links.get(jointElement.querySelector('child')?.getAttribute('link'));
    if (type === 'floating' || !parent || !child) continue;
    const frame = new THREE.Group();
    applyOrigin(frame, jointElement.querySelector(':scope > origin'));
    const motion = new THREE.Group();
    frame.add(motion);
    motion.add(child);
    parent.add(frame);
    childLinks.add(child.name);
    if (type === 'revolute' || type === 'continuous') {
      const limit = jointElement.querySelector('limit');
      joints.set(jointElement.getAttribute('name'), {
        motion,
        axis: new THREE.Vector3(...parseVector(jointElement.querySelector('axis')?.getAttribute('xyz'), [0, 0, 1])).normalize(),
        lower: Number(limit?.getAttribute('lower') ?? -Math.PI),
        upper: Number(limit?.getAttribute('upper') ?? Math.PI),
      });
    }
  }
  const root = [...links.values()].find((link) => !childLinks.has(link.name) && link.children.length);
  await Promise.all(meshJobs);
  return { root, links, joints };
}

// ---------- 步态：按相位生成关节角，不依赖物理引擎 ----------

function gaitPose(phase, amplitude) {
  const swing = Math.sin(phase);
  const leftLift = Math.max(0, -Math.cos(phase));
  const rightLift = Math.max(0, Math.cos(phase));
  const pose = {};
  const legs = [['left', swing, leftLift], ['right', -swing, rightLift]];
  for (const [side, hipSwing, lift] of legs) {
    const hip = -0.18 + amplitude * 0.38 * hipSwing - amplitude * 0.25 * lift;
    const knee = 0.36 + amplitude * 0.75 * lift;
    pose[`${side}_hip_pitch_joint`] = hip;
    pose[`${side}_knee_joint`] = knee;
    pose[`${side}_ankle_pitch_joint`] = -(hip + knee) + 0.02;
  }
  // 摆臂与同侧腿反相。
  pose.left_shoulder_pitch_joint = 0.25 - amplitude * 0.35 * swing;
  pose.right_shoulder_pitch_joint = 0.25 + amplitude * 0.35 * swing;
  pose.left_shoulder_roll_joint = 0.18;
  pose.right_shoulder_roll_joint = -0.18;
  pose.left_elbow_joint = 0.55;
  pose.right_elbow_joint = 0.55;
  pose.waist_yaw_joint = amplitude * 0.06 * swing;
  return pose;
}

// ---------- 场景 ----------

export function createG1Sim(container) {
  const canvasHost = container.querySelector('.g1-sim-canvas');
  const statusText = container.querySelector('[data-g1="status"]');
  const planText = container.querySelector('[data-g1="plan"]');
  const expandButton = container.querySelector('[data-g1="expand"]');
  const resetButton = container.querySelector('[data-g1="reset-view"]');

  const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 1.5));
  renderer.shadowMap.enabled = true;
  renderer.setClearColor('#0d1117');
  canvasHost.append(renderer.domElement);

  const scene = new THREE.Scene();
  scene.fog = new THREE.Fog('#0d1117', 9, 18);
  const camera = new THREE.PerspectiveCamera(42, 1, 0.05, 60);
  camera.up.set(0, 0, 1); // 世界坐标与雷达一致：X 向前、Y 向左、Z 向上。
  // 主舞台为宽画幅，机位放在左后上方，同时看到机器人、前方障碍和地面扇区。
  const VIEWS = {
    stage: { position: [-2.7, -2.3, 2.2], target: [1.1, 0, 0.55] },
    expanded: { position: [-3.2, -2.6, 2.6], target: [1.3, 0, 0.5] },
  };
  camera.position.set(...VIEWS.stage.position);
  const controls = new OrbitControls(camera, renderer.domElement);
  controls.target.set(...VIEWS.stage.target);
  controls.enableDamping = true;
  controls.maxPolarAngle = Math.PI * 0.49;
  controls.minDistance = 1.2;
  controls.maxDistance = 14;
  controls.update();

  // 半球光默认朝 +Y；本场景 Z 向上，需改为从 +Z 照射，否则侧面全部偏暗。
  const sky = new THREE.HemisphereLight('#d6e2ff', '#2a303a', 1.6);
  sky.position.set(0, 0, 1);
  scene.add(sky);
  const fill = new THREE.DirectionalLight('#9fb4d8', 0.8);
  fill.position.set(4, 3, 3);
  scene.add(fill);
  const sun = new THREE.DirectionalLight('#ffffff', 2.2);
  sun.position.set(-3, -4, 6);
  sun.castShadow = true;
  sun.shadow.mapSize.set(1024, 1024);
  Object.assign(sun.shadow.camera, { left: -4, right: 4, top: 4, bottom: -4 });
  scene.add(sun);

  const floor = new THREE.Mesh(new THREE.CircleGeometry(16, 64), new THREE.MeshStandardMaterial({ color: '#141a23', roughness: 0.95 }));
  floor.receiveShadow = true;
  scene.add(floor);
  const grid = new THREE.GridHelper(16, 32, '#2a3442', '#1c2430');
  grid.rotation.x = Math.PI / 2;
  grid.position.z = 0.002;
  scene.add(grid);

  // 三个扇区画在地面上，颜色与避障规则一致：绿=通畅、橙=注意、红=阻挡、灰=无数据。
  const sectorMeshes = {};
  for (const key of ['left', 'front', 'right']) {
    const mesh = new THREE.Mesh(new THREE.BufferGeometry(), new THREE.MeshBasicMaterial({ color: COLORS.unknown, transparent: true, opacity: 0.22, depthWrite: false, side: THREE.DoubleSide }));
    mesh.position.z = 0.004;
    scene.add(mesh);
    sectorMeshes[key] = mesh;
  }
  let sectorKey = '';
  function updateSectorShapes(settings) {
    const key = [settings.frontHalfAngleDeg, settings.sideLimitAngleDeg, settings.turnDistanceMm].join('|');
    if (key === sectorKey) return;
    sectorKey = key;
    const radius = settings.turnDistanceMm / 1000;
    const front = THREE.MathUtils.degToRad(settings.frontHalfAngleDeg ?? 25);
    const side = THREE.MathUtils.degToRad(settings.sideLimitAngleDeg ?? 110);
    const shapes = { front: [-front, 2 * front], left: [front, side - front], right: [-side, side - front] };
    for (const [name, [start, length]] of Object.entries(shapes)) {
      sectorMeshes[name].geometry.dispose();
      sectorMeshes[name].geometry = new THREE.CircleGeometry(radius, 40, start, length);
    }
  }

  // 雷达点：从地面竖到扫描平面高度的细柱，便于看出“墙”和“桩”。
  const columns = new THREE.InstancedMesh(new THREE.BoxGeometry(0.035, 0.035, 1), new THREE.MeshStandardMaterial({ roughness: 0.6, transparent: true, opacity: 0.85 }), MAX_COLUMNS);
  // 颜色缓冲需在首次渲染前存在，否则着色器不含实例颜色，柱子会显示成黑色。
  columns.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(MAX_COLUMNS * 3), 3);
  columns.count = 0;
  // 点数每圈变化，缓存的包围球会过期导致整组被视锥裁掉，因此关闭裁剪。
  columns.frustumCulled = false;
  columns.castShadow = true;
  scene.add(columns);

  // 规划路径与停止圈。
  const pathLine = new THREE.Line(new THREE.BufferGeometry(), new THREE.LineDashedMaterial({ color: COLORS.open, dashSize: 0.12, gapSize: 0.08 }));
  pathLine.position.z = 0.01;
  scene.add(pathLine);
  const stopRing = new THREE.Mesh(new THREE.RingGeometry(0.42, 0.5, 48), new THREE.MeshBasicMaterial({ color: COLORS.blocked, transparent: true, opacity: 0.7, side: THREE.DoubleSide }));
  stopRing.position.z = 0.012;
  stopRing.visible = false;
  scene.add(stopRing);

  const body = new THREE.Group(); // 机器人在平面上的位姿（x, y, 航向）。
  scene.add(body);
  let robot = null;
  let standHeight = 0;
  let scanHeight = 1.2;

  const state = {
    input: null,
    lastFrame: null,
    lastSettingsKey: '',
    active: 'none',
    pending: null,
    pendingSince: 0,
    plan: null,
    planStart: 0,
    phase: 0,
    lastTime: performance.now(),
    running: false,
    visible: true,
  };

  function setJoint(name, angle) {
    const joint = robot?.joints.get(name);
    if (!joint) return;
    joint.motion.quaternion.setFromAxisAngle(joint.axis, THREE.MathUtils.clamp(angle, joint.lower, joint.upper));
  }

  statusText.textContent = 'G1 模型加载中…';
  loadRobot().then((loaded) => {
    robot = loaded;
    body.add(robot.root);
    for (const [name, angle] of Object.entries(gaitPose(0, 0))) setJoint(name, angle);
    robot.root.updateMatrixWorld(true);
    // 让双脚落地；扫描平面取 G1 头部雷达（mid360_link）的高度，表示“把这台雷达装在 G1 上”。
    const bounds = new THREE.Box3().setFromObject(robot.root);
    standHeight = -bounds.min.z;
    robot.root.position.z = standHeight;
    robot.root.updateMatrixWorld(true);
    const lidar = robot.links.get('mid360_link');
    if (lidar) scanHeight = lidar.getWorldPosition(new THREE.Vector3()).z;
    state.lastFrame = null;
    applyInput();
    refreshStatus();
  }).catch((error) => {
    statusText.textContent = `G1 模型加载失败：${error.message}`;
  });

  // ---------- 数据 → 场景 ----------

  function applyInput() {
    const input = state.input;
    if (!input) return;
    const { frame, settings } = input;
    updateSectorShapes(settings);
    const settingsKey = [settings.stopDistanceMm, settings.turnDistanceMm, settings.maxRangeMm].join('|');
    if (frame !== state.lastFrame || settingsKey !== state.lastSettingsKey) {
      state.lastFrame = frame;
      state.lastSettingsKey = settingsKey;
      const matrix = new THREE.Matrix4();
      let count = 0;
      for (const point of frame?.points ?? []) {
        if (!point.valid || count >= MAX_COLUMNS || point.distanceMm > settings.maxRangeMm) continue;
        matrix.makeScale(1, 1, scanHeight);
        matrix.setPosition(point.xMm / 1000, point.yMm / 1000, scanHeight / 2);
        columns.setMatrixAt(count, matrix);
        columns.setColorAt(count, point.distanceMm <= settings.stopDistanceMm ? COLORS.near : point.distanceMm <= settings.turnDistanceMm ? COLORS.caution : COLORS.far);
        count++;
      }
      columns.count = count;
      columns.instanceMatrix.needsUpdate = true;
      columns.instanceColor.needsUpdate = true;
    }
    const sectors = frame?.sectors;
    for (const name of ['left', 'front', 'right']) {
      const sector = sectors?.[name];
      let color = COLORS.unknown;
      if (sector?.sampleCount && !input.stale && !input.paused) {
        color = sector.clearanceMm <= settings.stopDistanceMm ? COLORS.blocked : sector.clearanceMm <= settings.turnDistanceMm ? COLORS.caution2 : COLORS.open;
      }
      sectorMeshes[name].material.color.set(color);
    }
  }

  function desiredAction() {
    const input = state.input;
    if (!input?.hasFrame || input.stale || input.paused || !input.decision) return 'none';
    return input.decision.action in ACTION_TEXT ? input.decision.action : 'none';
  }

  // 根据建议生成预演：前进距离受前方清距约束，转向先原地转 45° 再前进。
  function buildPlan(action) {
    const input = state.input;
    const settings = input?.settings ?? {};
    const decision = input?.decision ?? {};
    if (action === 'forward') {
      const room = ((decision.frontClearance ?? 1500) - (settings.stopDistanceMm ?? 450)) / 1000;
      return { action, turn: 0, distance: THREE.MathUtils.clamp(room, 0.3, 1.2) };
    }
    if (action === 'turn-left' || action === 'turn-right') {
      const sideClearance = action === 'turn-left' ? decision.leftClearance : decision.rightClearance;
      const room = ((sideClearance ?? 1200) - (settings.stopDistanceMm ?? 450)) / 1000;
      return { action, turn: action === 'turn-left' ? TURN_RAD : -TURN_RAD, distance: THREE.MathUtils.clamp(room, 0.3, 0.9) };
    }
    return { action, turn: 0, distance: 0 };
  }

  function drawPath(plan) {
    stopRing.visible = plan.action === 'stop';
    if (!plan.distance) {
      pathLine.visible = false;
      return;
    }
    const points = [];
    const steps = 24;
    for (let i = 0; i <= steps; i++) {
      const s = (i / steps) * plan.distance;
      points.push(new THREE.Vector3(Math.cos(plan.turn) * s, Math.sin(plan.turn) * s, 0));
    }
    pathLine.geometry.dispose();
    pathLine.geometry = new THREE.BufferGeometry().setFromPoints(points);
    pathLine.computeLineDistances();
    pathLine.material.color.set(plan.turn ? COLORS.caution2 : COLORS.open);
    pathLine.visible = true;
  }

  function adopt(action, now) {
    state.active = action;
    state.plan = buildPlan(action);
    state.planStart = now;
    drawPath(state.plan);
    refreshStatus();
  }

  function refreshStatus() {
    const input = state.input;
    if (!robot) return;
    if (!input?.hasFrame) statusText.textContent = '等待雷达数据 · 连接后 G1 会按建议预演';
    else if (input.stale) statusText.textContent = '数据过期 · G1 原地停止';
    else if (input.paused) statusText.textContent = '扫描已暂停 · G1 原地停止';
    else statusText.textContent = `雷达建议：${ACTION_TEXT[state.active] ?? '--'}`;
    const plan = state.plan;
    if (!plan || state.active === 'none') planText.textContent = '仿真示意，不控制真实机器人';
    else if (plan.action === 'stop') planText.textContent = '预演：原地停步等待';
    else if (plan.turn) planText.textContent = `预演：${plan.turn > 0 ? '左' : '右'}转 45° 后前进 ${plan.distance.toFixed(1)} m，随后回到雷达位置重放`;
    else planText.textContent = `预演：前进 ${plan.distance.toFixed(1)} m（距障碍保留停止距离），随后回到雷达位置重放`;
  }

  // 预演时间轴：转向 → 行走 → 停顿 → 回到起点。返回 [x, y, 航向, 步态幅度]。
  function samplePlan(plan, t) {
    if (!plan || !plan.distance) return [0, 0, 0, 0];
    const turnTime = plan.turn ? TURN_SECONDS : 0;
    const walkTime = plan.distance / WALK_SPEED;
    if (t < turnTime) {
      const k = t / turnTime;
      return [0, 0, plan.turn * (0.5 - 0.5 * Math.cos(Math.PI * k)), 0.55];
    }
    const walked = Math.min(plan.distance, (t - turnTime) * WALK_SPEED);
    const moving = t - turnTime < walkTime;
    return [Math.cos(plan.turn) * walked, Math.sin(plan.turn) * walked, plan.turn, moving ? 1 : 0];
  }

  function planLength(plan) {
    if (!plan || !plan.distance) return Infinity;
    return (plan.turn ? TURN_SECONDS : 0) + plan.distance / WALK_SPEED + HOLD_SECONDS;
  }

  let amplitude = 0;
  function tick(now) {
    if (!state.running) return;
    requestAnimationFrame(tick);
    const dt = Math.min(0.05, (now - state.lastTime) / 1000);
    state.lastTime = now;

    const wanted = desiredAction();
    if (wanted !== state.active) {
      if (wanted === 'stop' || wanted === 'none' || state.active === 'none') adopt(wanted, now);
      else if (state.pending !== wanted) { state.pending = wanted; state.pendingSince = now; }
      else if (now - state.pendingSince >= ADOPT_DELAY_MS) adopt(wanted, now);
    } else {
      state.pending = null;
    }

    let t = (now - state.planStart) / 1000;
    if (t > planLength(state.plan)) { state.planStart = now; t = 0; }
    const [x, y, heading, targetAmplitude] = state.active === 'none' ? [0, 0, 0, 0] : samplePlan(state.plan, t);
    body.position.set(x, y, 0);
    body.rotation.z = heading;
    amplitude += (targetAmplitude - amplitude) * Math.min(1, dt * 6);
    state.phase += dt * Math.PI * 2 * STEP_HZ * (amplitude > 0.02 ? 1 : 0);
    if (robot) {
      for (const [name, angle] of Object.entries(gaitPose(state.phase, amplitude))) setJoint(name, angle);
      robot.root.position.z = standHeight - amplitude * 0.012 * (1 - Math.cos(2 * state.phase));
    }
    stopRing.material.opacity = 0.45 + 0.3 * Math.sin(now / 250);

    controls.update();
    renderer.render(scene, camera);
  }

  function setRunning() {
    const shouldRun = state.visible && !document.hidden;
    if (shouldRun === state.running) return;
    state.running = shouldRun;
    if (shouldRun) { state.lastTime = performance.now(); requestAnimationFrame(tick); }
  }

  // 只在可见时渲染，避免切走或滚出视口时持续占用 GPU。
  new IntersectionObserver((entries) => { state.visible = entries.some((entry) => entry.isIntersecting); setRunning(); }).observe(canvasHost);
  document.addEventListener('visibilitychange', setRunning);
  new ResizeObserver(() => {
    const { clientWidth: width, clientHeight: height } = canvasHost;
    if (!width || !height) return;
    renderer.setSize(width, height, false);
    camera.aspect = width / height;
    camera.updateProjectionMatrix();
    renderer.render(scene, camera); // 改尺寸会清空画布，立即补画一帧避免闪白。
  }).observe(canvasHost);

  // 复位到当前尺寸对应的默认机位，学生拖乱视角后一键恢复。
  function resetView() {
    const view = container.classList.contains('is-expanded') ? VIEWS.expanded : VIEWS.stage;
    camera.position.set(...view.position);
    controls.target.set(...view.target);
    controls.update();
  }
  resetButton?.addEventListener('click', resetView);

  // 放大：铺满窗口观看，Escape 退出。
  function setExpanded(on) {
    container.classList.toggle('is-expanded', on);
    document.body.classList.toggle('has-g1-expanded', on);
    expandButton.setAttribute('aria-pressed', String(on));
    expandButton.textContent = on ? '退出放大' : '放大';
    resetView();
  }
  expandButton.addEventListener('click', () => setExpanded(!container.classList.contains('is-expanded')));
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && container.classList.contains('is-expanded')) setExpanded(false);
  });

  return {
    // 由 app.js 在每次界面刷新时调用；只保存最新状态，动画由本模块自己的帧循环驱动。
    update(input) {
      state.input = input;
      applyInput();
      if (desiredAction() === state.active) refreshStatus();
    },
  };
}
