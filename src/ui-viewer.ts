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
 * 背景明暗切换（默认浅色 + 右下角按钮）由灯箱组件自己管理，见 image-lightbox.ts——
 * 桌面窗口与移动端页内灯箱共用同一实现。
 */

import { invoke } from '@tauri-apps/api/core'
import { listen } from '@tauri-apps/api/event'
import { mountImageLightbox, type LightboxPayload } from './image-lightbox'
import './theme.css'

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

void listen<LightboxPayload>('mydict:viewer-image', (event) => {
  lightbox.show(event.payload)
})

void invoke<LightboxPayload | null>('take_viewer_payload')
  .then((payload) => {
    if (payload) lightbox.show(payload)
  })
  .catch(() => undefined)
