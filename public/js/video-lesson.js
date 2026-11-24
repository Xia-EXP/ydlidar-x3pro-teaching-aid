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

// 四段原创建议图解均为 24 秒，每 6 秒切换一章。
const ORIGINAL_SOURCE = '本项目原创教学动画，使用示意场景。';
const VIDEOS = {
  g1: {
    src: '/media/g1-avoidance.mp4',
    title: 'G1 避障演示',
    source: ORIGINAL_SOURCE + ' 用于说明三扇区几何建议。',
    placeholder: '标记说明，如：开始绕行',
    chapters: ['前方通畅', '左前方受阻', '进入停止距离', '通路恢复'],
  },
  slalom: {
    src: '/media/g1-slalom.mp4',
    title: 'G1 绕桩路径示意',
    source: ORIGINAL_SOURCE + ' 路线为示意，不含真实步态。',
    placeholder: '标记说明，如：绕过第二根桩',
    chapters: ['定位第一根桩', '绕过第一根桩', '交替选边', '到达终点'],
  },
  gap: {
    src: '/media/gap-following.mp4',
    title: '缝隙跟随法',
    source: ORIGINAL_SOURCE + ' 用于对照三扇区法。',
    placeholder: '标记说明，如：找最近点',
    chapters: ['读取与限距', '找最近点', '划出安全范围', '选缝与目标方向'],
  },
  tf: {
    src: '/media/tf-frames.mp4',
    title: 'TF 与坐标',
    source: ORIGINAL_SOURCE + ' 点的位置以三个参考系描述。',
    placeholder: '标记说明，如：换成车身坐标',
    chapters: ['雷达读数', '转到车身坐标', '转到地图坐标', '核对固定障碍'],
  },
};

let currentId = 'g1';
let marks = [];
// 教学短片更新后使用新的标记命名空间，旧版时间戳仍留在浏览器中。
const storageKey = (id) => 'ydlidar.videoMarks.original.' + id;

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
  const chapters = VIDEOS[currentId].chapters.map((label, index) => ({ time: index * 6, label }));
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
  stage.dataset.orientation = 'landscape';
  heading.textContent = info.title;
  durationChip.textContent = '0:24';
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
