/**
 * 入口分流：同一份前端 bundle 服务两个窗口。
 *
 * - popup：快捷搜索窗（全局热键 / 划词 / 剪贴板监听唤起，轻量手风琴面板）
 * - main：词典主界面（列表 + 词条的完整浏览形态）
 *
 * 两个窗口加载同一个 index.html，按 window.label 挂载各自的 UI 模块。
 */

import { getCurrentWindow } from '@tauri-apps/api/window'

const label = getCurrentWindow().label

if (label === 'popup') {
  void import('./ui-popup')
} else {
  void import('./ui-main')
}
