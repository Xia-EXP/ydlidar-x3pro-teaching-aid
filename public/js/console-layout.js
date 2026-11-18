// 页签只控制展示，不读写设备连接、扫描或算法状态。
const tabs = [...document.querySelectorAll('.workspace-tab')];
// 切换选中页签并同步键盘焦点顺序与无障碍关联。
function activateTab(selected, focus = false) {
  for (const tab of tabs) { // 同一时刻只有一个页签进入 Tab 顺序。
    const active = tab === selected; // 根据目标按钮计算面板是否可见。
    tab.setAttribute('aria-selected', String(active)); // 告知屏幕阅读器选中状态。
    tab.tabIndex = active ? 0 : -1; // 方向键导航后仍保持单一页签焦点入口。
    document.getElementById(tab.getAttribute('aria-controls')).hidden = !active; // 仅隐藏内容，不销毁输入节点。
  } // 全部面板状态已同步。
  if (focus) selected.focus(); // 方向键切换时将焦点跟随到新的页签。
} // 页签展示切换结束。
for (const tab of tabs) { // 为三个工作区入口绑定统一交互。
  tab.addEventListener('click', () => activateTab(tab)); // 鼠标和触屏使用相同行为。
  tab.addEventListener('keydown', (event) => { // 支持标准横向页签键盘导航。
    const current = tabs.indexOf(tab); // 定位当前页签以计算相邻目标。
    const targets = { ArrowRight: (current + 1) % tabs.length, ArrowLeft: (current - 1 + tabs.length) % tabs.length, Home: 0, End: tabs.length - 1 }; // 支持循环和首尾导航。
    if (!(event.key in targets)) return; // 其他按键保留浏览器默认操作。
    event.preventDefault(); // 防止方向键同时滚动页面。
    activateTab(tabs[targets[event.key]], true); // 显示目标面板并同步焦点。
  }); // 完成当前页签键盘绑定。
} // 所有页签绑定完成。
// 地图模式由应用状态驱动，避免恢复默认后显示旧模式操作。
export function syncMapMode(mode) {
  for (const element of document.querySelectorAll('[data-map-mode]')) { // 遍历仅属于某个地图模式的控件组。
    const hidden = element.dataset.mapMode !== mode; // 局部图与实验建图采用互斥展示。
    if (element.hidden !== hidden) element.hidden = hidden; // 差分修改避免高频更新触发布局。
  } // 模式专属区域已同步。
} // 该接口只操作可见性，不会开始或暂停建图。
for (const details of document.querySelectorAll('.console-disclosure')) { // 每次只展开一个设置浮层。
  details.addEventListener('toggle', () => { // 原生鼠标、键盘操作共用该事件。
    if (!details.open) return; // 关闭时无需处理其他区域。
    for (const other of document.querySelectorAll('.console-disclosure[open]')) { // 获取当前展开的设置区。
      if (other !== details) other.open = false; // 避免浮层叠加遮挡主视图。
    } // 完成互斥展开。
  }); // 保留原生 details 的键盘语义。
} // 所有设置入口绑定完成。
document.addEventListener('keydown', (event) => { // Escape 关闭设置并恢复入口焦点。
  if (event.key !== 'Escape') return; // 其他键不影响设置区域。
  for (const details of document.querySelectorAll('.console-disclosure[open]')) { // 查找展开中的设置。
    const ownsFocus = details.contains(document.activeElement); // 仅恢复当前操作区域的焦点。
    details.open = false; // 关闭设置，输入值保持不变。
    if (ownsFocus) details.querySelector('summary').focus(); // 键盘用户返回原入口。
  } // 全部浮层已关闭。
}); // Escape 行为绑定完成。
document.addEventListener('click', (event) => { // 点击设置外部可收起浮层。
  for (const details of document.querySelectorAll('.console-disclosure[open]')) { // 保持原生 summary 点击行为。
    if (!details.contains(event.target)) details.open = false; // 外部点击不会触发设备命令。
  } // 完成点击区域判断。
}); // 页面辅助交互绑定完成。
