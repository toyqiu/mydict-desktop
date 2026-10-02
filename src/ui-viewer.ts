/**
 * 图片查看器窗口（独立于词典界面）。
 *
 * 词条里点了大图时，popup/main 通过 Rust 侧 open_viewer 创建本窗口（无边框、置顶、
 * 铺满所在显示器）；词典窗口不动——全屏看图不该顺带改词典窗口的几何。
 *
 * 图片载荷的两条到达路径：
 *   1. 窗口是新建的：页面加载完 invoke take_viewer_payload 取走 Rust 暂存的初始载荷
 *      （事件可能发在页面监听装好之前，靠暂存避免竞态）；
 *   2. 窗口已开着又点了别的图：Rust emit mydict:viewer-image，这里直接换图。
 *
 * 用户退出查看器（Esc / 点空白）→ invoke close_viewer 销毁窗口，回到词典界面。
 *
 * 背景：默认**浅色**——黑色底会淹没深色图片/白底扫描件的内容（用户实测反馈）；
 * 右下角「背景」按钮可一键在深/浅之间切换（深色照片类图片仍有深色可选）。
 * 提示条与切换按钮自带半透明深色胶囊底，两种背景下都清晰。
 */

import { invoke } from '@tauri-apps/api/core'
import { listen } from '@tauri-apps/api/event'
import { mountImageLightbox, type LightboxPayload } from './image-lightbox'
import './theme.css'

const BG_LIGHT = '#f2f2f2'
const BG_DARK = '#0a0a0a'

let bgDark = false

const toggleBtn = document.createElement('button')
toggleBtn.type = 'button'
toggleBtn.className = 'viewer-bg-toggle'
document.body.appendChild(toggleBtn)

function applyBg(): void {
  document.body.style.background = bgDark ? BG_DARK : BG_LIGHT
  toggleBtn.textContent = bgDark ? '☀ 浅色背景' : '🌙 深色背景'
}
applyBg()

toggleBtn.addEventListener('click', () => {
  bgDark = !bgDark
  applyBg()
})

const lightbox = mountImageLightbox({
  onOpenChange: (open) => {
    if (open) {
      // 内容就绪（背景已就位）才上屏：Windows 上 WebView2 初始化期间的默认白幕
      // 不能露出来，更不能以「置顶全屏白幕」的形态锁死桌面
      void invoke('show_viewer').catch(() => undefined)
    } else {
      // 关闭即销毁窗口；popup/main 还在，应用不会退出
      void invoke('close_viewer').catch(() => undefined)
    }
  },
})
document.body.appendChild(lightbox.element)
// 独立查看器不需要 lightbox 自带的深色遮罩（那是弹窗叠加场景的设计）——
// 遮罩会盖住 body 的背景色，让「浅色背景」永远不生效。背景色交给 body。
lightbox.element.style.background = 'transparent'

void listen<LightboxPayload>('mydict:viewer-image', (event) => {
  lightbox.show(event.payload)
})

void invoke<LightboxPayload | null>('take_viewer_payload')
  .then((payload) => {
    if (payload) lightbox.show(payload)
  })
  .catch(() => undefined)
