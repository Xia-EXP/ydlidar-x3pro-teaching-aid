// 案例视频页签：只控制本地视频播放与课堂标记，不读写设备连接、扫描或算法状态。
const video = document.getElementById('lessonVideo');
const panel = document.getElementById('panel-video');
const stage = document.getElementById('videoStage');
const heading = document.getElementById('videoHeading');
const durationChip = document.getElementById('videoDuration');
const source = document.getElementById('videoSource');
const chapterList = document.getElementById('videoChapters');
const markForm = document.getElementById('videoMarkForm');
const markLabel = document.getElementById('videoMarkLabel');
const markList = document.getElementById('videoMarks');
const loopInput = document.getElementById('videoLoopInput');
const theaterToggle = document.getElementById('theaterToggle');
const pickButtons = [...document.querySelectorAll('[data-video]')];
const rateButtons = [...document.querySelectorAll('[data-rate]')];

// 视频清单；章节时间来自视频内嵌字幕，缝隙跟随法短片没有字幕，由教师自行标记。
const VIDEOS = {
  g1: {
    src: '/media/g1-avoidance.mp4',
    title: 'G1 避障演示',
    duration: '0:31',
    orientation: 'landscape',
    source: '视频带“AI 仿真演示”水印，为示意动画，仅用于课堂演示。',
    placeholder: '标记说明，如：开始绕行',
    chapters: [
      { time: 0, label: '机器人行走' },
      { time: 2, label: '激光雷达持续扫描' },
      { time: 6, label: '测量障碍物距离和方向' },
      { time: 10, label: '规划器选择右侧绕行' },
      { time: 16, label: '执行步态，持续更新路线' },
      { time: 21, label: '行人进入路线 · 停步等待' },
      { time: 27, label: '通路清空 · 恢复行走' },
    ],
  },
  slalom: {
    src: '/media/g1-slalom.mp4',
    title: 'G1 绕桩行走完整演示',
    duration: '0:25',
    orientation: 'landscape',
    source: '仿真录屏：Unitree G1 + 训练得到的行为克隆导航器（slalom 场景），仅用于课堂演示。',
    placeholder: '标记说明，如：绕过第二根桩',
    chapters: [
      { time: 0, label: '起步，桩在前方' },
      { time: 2, label: '接近第一根桩' },
      { time: 8, label: '在桩之间穿行' },
      { time: 15, label: '绿色终点线进入视野' },
      { time: 21, label: '绕过最后一根桩' },
      { time: 24, label: '越过终点线 · success=True' },
    ],
  },
  gap: {
    src: '/media/gap-following.mp4',
    title: '50 秒看懂缝隙跟随法',
    duration: '0:48',
    orientation: 'portrait',
    source: '来源：道化之华《50 秒看懂缝隙跟随法》，仅用于课堂演示。',
    placeholder: '标记说明，如：找最近点',
    chapters: [],
  },
  tf: {
    src: '/media/tf-frames.mp4',
    title: '50 秒看懂 TF 与坐标的作用',
    duration: '0:52',
    orientation: 'portrait',
    source: '来源：道化之华《50 秒看懂 TF 与坐标的作用》，仅用于课堂演示。',
    placeholder: '标记说明，如：换成车身坐标',
    chapters: [
      { time: 0, label: '雷达在，我在哪都清楚' },
      { time: 3, label: '雷达被拿走，眼睛还在' },
      { time: 9, label: '相机坐标：它在我右前方' },
      { time: 12, label: '先换成车身坐标' },
      { time: 17, label: '杯盖？坐标没错，是认错了' },
      { time: 22, label: '箱子挡路，看不见了' },
      { time: 26, label: '东西没动，车身坐标一直变' },
      { time: 30, label: '换不跟车走的原点：出发点、地图' },
      { time: 35, label: 'TF 每一刻都在换算' },
      { time: 43, label: '找到了，装回雷达：TF 树多一枝' },
      { time: 47, label: '一个位置，四种说法' },
    ],
  },
};

let currentId = 'g1';
let marks = [];
const storageKey = (id) => `ydlidar.videoMarks.${id === 'gap' ? 'gap-following' : id}`;

// 读取本机保存的标记；存储损坏或被禁用时退回空列表，不影响播放。
function loadMarks(id) {
  try {
    const stored = JSON.parse(localStorage.getItem(storageKey(id)) ?? '[]');
    return Array.isArray(stored) ? stored.filter((mark) => Number.isFinite(mark.time) && typeof mark.label === 'string') : [];
  } catch {
    return [];
  }
}

function saveMarks() {
  try {
    localStorage.setItem(storageKey(currentId), JSON.stringify(marks));
  } catch {
    // 隐私模式下无法持久化，本次课堂内仍可使用标记。
  }
}

// 将秒数格式化为 m:ss.s，便于对照 0.5× 慢放时的细节。
function formatTime(seconds) {
  const minutes = Math.floor(seconds / 60);
  return `${minutes}:${(seconds - minutes * 60).toFixed(1).padStart(4, '0')}`;
}

// 生成一个“时间 + 说明”跳转按钮，标签文本只经 textContent 写入。
function makeJumpButton(mark) {
  const jump = document.createElement('button');
  jump.type = 'button';
  jump.className = 'video-mark-jump';
  jump.dataset.time = String(mark.time);
  const time = document.createElement('time');
  time.textContent = formatTime(mark.time);
  const label = document.createElement('span');
  label.textContent = mark.label;
  jump.append(time, label);
  jump.addEventListener('click', () => {
    video.currentTime = mark.time;
    highlightChapter();
    video.play().catch(() => {});
  });
  return jump;
}

function renderChapters() {
  const { chapters } = VIDEOS[currentId];
  chapterList.hidden = chapters.length === 0;
  chapterList.previousElementSibling.hidden = chapters.length === 0;
  chapterList.replaceChildren(...chapters.map((chapter) => {
    const item = document.createElement('li');
    item.append(makeJumpButton(chapter));
    return item;
  }));
  highlightChapter();
}

// 播放时高亮当前所在章节，方便教师对照讲解。
function highlightChapter() {
  const buttons = [...chapterList.querySelectorAll('.video-mark-jump')];
  const current = buttons.filter((button) => Number(button.dataset.time) <= video.currentTime + 0.05).pop();
  for (const button of buttons) button.classList.toggle('is-current', button === current);
}

function renderMarks() {
  markList.replaceChildren(...marks.map((mark, index) => {
    const item = document.createElement('li');
    const remove = document.createElement('button');
    remove.type = 'button';
    remove.className = 'video-mark-delete';
    remove.textContent = '×';
    remove.setAttribute('aria-label', `删除标记 ${formatTime(mark.time)} ${mark.label}`);
    remove.addEventListener('click', () => {
      marks.splice(index, 1);
      saveMarks();
      renderMarks();
    });
    item.append(makeJumpButton(mark), remove);
    return item;
  }));
}

// 切换视频：更换片源并同步标题、章节、标记与对应课堂脚本。
function selectVideo(id) {
  const info = VIDEOS[id];
  if (!info) return;
  currentId = id;
  if (video.getAttribute('src') !== info.src) {
    video.pause();
    video.src = info.src;
    video.playbackRate = Number(rateButtons.find((button) => button.getAttribute('aria-pressed') === 'true')?.dataset.rate ?? 1);
  }
  stage.dataset.orientation = info.orientation;
  heading.textContent = info.title;
  durationChip.textContent = info.duration;
  source.textContent = `${info.source}标记保存在本机浏览器。`;
  markLabel.placeholder = info.placeholder;
  for (const button of pickButtons) button.setAttribute('aria-pressed', String(button.dataset.video === id));
  for (const lesson of document.querySelectorAll('[data-lesson]')) lesson.hidden = lesson.dataset.lesson !== id;
  marks = loadMarks(id);
  renderChapters();
  renderMarks();
}

// 剧场模式把整个案例视频面板铺满窗口（视频选择、播放器、章节和课堂脚本），像独立子页；Escape 退出。
function setTheater(on) {
  panel.classList.toggle('is-theater', on);
  document.body.classList.toggle('has-theater', on);
  theaterToggle.setAttribute('aria-pressed', String(on));
  theaterToggle.textContent = on ? '退出剧场' : '剧场模式';
}

markForm.addEventListener('submit', (event) => {
  event.preventDefault();
  const label = markLabel.value.trim() || `标记 ${marks.length + 1}`;
  marks = [...marks, { time: Math.round(video.currentTime * 10) / 10, label }].sort((a, b) => a.time - b.time);
  saveMarks();
  renderMarks();
  markLabel.value = '';
});

for (const button of pickButtons) button.addEventListener('click', () => selectVideo(button.dataset.video));

for (const button of rateButtons) {
  button.addEventListener('click', () => {
    video.playbackRate = Number(button.dataset.rate);
    for (const other of rateButtons) other.setAttribute('aria-pressed', String(other === button));
  });
}

loopInput.addEventListener('change', () => {
  video.loop = loopInput.checked;
});

theaterToggle.addEventListener('click', () => setTheater(!panel.classList.contains('is-theater')));
document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape' && panel.classList.contains('is-theater')) setTheater(false);
});

video.addEventListener('timeupdate', highlightChapter);
video.addEventListener('seeked', highlightChapter);

// 切换到其他页签时暂停并退出剧场，避免视频声音干扰雷达操作讲解。
new MutationObserver(() => {
  if (!panel.hidden) return;
  if (!video.paused) video.pause();
  setTheater(false);
}).observe(panel, { attributes: true, attributeFilter: ['hidden'] });

selectVideo(currentId);
