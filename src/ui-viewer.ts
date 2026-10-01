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
 */

import { invoke } from '@tauri-apps/api/core'
import { listen } from '@tauri-apps/api/event'
import { mountImageLightbox, type LightboxPayload } from './image-lightbox'
import './theme.css'

// 查看器整窗就是图片背景，不留应用主题底色
document.body.style.background = '#000'

const lightbox = mountImageLightbox({
  onOpenChange: (open) => {
    if (open) {
      // 内容就绪（黑底已就位）才上屏：Windows 上 WebView2 初始化期间的默认白幕
      // 不能露出来，更不能以「置顶全屏白幕」的形态锁死桌面
      void invoke('show_viewer').catch(() => undefined)
    } else {
      // 关闭即销毁窗口；popup/main 还在，应用不会退出
      void invoke('close_viewer').catch(() => undefined)
    }
  },
})
document.body.appendChild(lightbox.element)

void listen<LightboxPayload>('mydict:viewer-image', (event) => {
  lightbox.show(event.payload)
})

void invoke<LightboxPayload | null>('take_viewer_payload')
  .then((payload) => {
    if (payload) lightbox.show(payload)
  })
  .catch(() => undefined)
