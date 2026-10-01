/**
 * 词条渲染：把 MyDict 返回的自包含 HTML 装进沙箱 iframe —— 这是本项目「复用 MyDict 渲染」
 * 的全部实现，没有之一。
 *
 * 两件必须做的事：
 *
 * 1. **注入 `<base href="<服务器地址>/">`**：词条文档里的资源是**根相对**的（引导脚本里
 *    `RES_PREFIX = '/dict-res/<词典 id>/res/'`），而 srcdoc 文档的源是本应用的
 *    `tauri://localhost`——不注入 base，词典自带的字体/图片/发音会全部 404。
 * 2. **`sandbox="allow-scripts"` 且不加 `allow-same-origin`**：词条脚本来自第三方词典包，
 *    必须留在不透明源里（与前台同款），拿不到本应用的任何东西。
 *
 * 消息协议沿用前台（我们不改 MyDict 一行）：
 *   mydict:height  → 子页上报内容高度（父页读不到 contentDocument）
 *   mydict:entry   → 词条内点了 entry:// 链接，交父页发起新查询
 *   mydict:open    → 外链，交父页用系统浏览器打开
 *   mydict:escape  → 词条内按了 Esc（选中文字菜单未开时）
 *   mydict:audio-unsupported → 发音三种候选都放不了
 */

import { invoke } from '@tauri-apps/api/core'

export interface EntryFrameOptions {
  /**
   * 服务器根地址，如 http://192.168.5.197:4815；尾部斜杠会自动补。
   * 允许传函数：设置页改完地址后不必重建 frame，下一次渲染就用新地址。
   */
  baseUrl: string | (() => string)
  /**
   * 当前主题（dark|light），允许传函数。词条文档按它渲染明暗：
   * ready 时补发一次（文档没带主题初值时会跟随系统偏好，桌面端系统偏好=亮色，
   * 应用是暗色时词条就一直是亮色——实测正是「暗色模式下词条不变暗」的原因）。
   */
  theme: string | (() => string)
  /**
   * 词条里点了大图（≥160px、不在链接里的 <img>）：服务端引导脚本会带上该词典全部
   * 大图的 urls 与点中下标——扫描版词典（辞海）的整页图靠这个放大查看。
   */
  onImage?: (payload: { src: string; alt: string; urls: string[]; index: number }) => void
  onHeight?: (height: number) => void
  onEntry?: (word: string, anchor: string) => void
  onExternal?: (url: string) => void
  onEscape?: () => void
  onAudioUnsupported?: () => void
}

export interface EntryFrame {
  element: HTMLIFrameElement
  load: (html: string) => void
  destroy: () => void
  /** 主题变化时调用：给词条文档补发 mydict:cmd/theme */
  refreshTheme: () => void
}

/**
 * 诊断走 Rust 的 `note`（写 stderr → /tmp/mydict-desktop-<uid>.log）。
 *
 * **不要用 console.***：WebView 的控制台不落盘（实测：同一实例里 Rust 的 eprintln 有日志，
 * 而 TS 里加的 [height]/[audio] console 一行都没有），GUI 下等于没有诊断。词条高度那次
 * 排查就是靠这个通道才看得见。
 */
function note(tag: string): void {
  void invoke('note', { tag }).catch(() => undefined)
}

export function createEntryFrame(options: EntryFrameOptions): EntryFrame {
  const frame = document.createElement('iframe')
  frame.className = 'entry-frame'
  frame.setAttribute('sandbox', 'allow-scripts')
  frame.setAttribute('referrerpolicy', 'no-referrer')
  frame.setAttribute('title', '词条')
  frame.srcdoc = '<!doctype html><html><body></body></html>'

  const currentTheme = (): string =>
    (typeof options.theme === 'function' ? options.theme() : options.theme) || 'dark'

  const postTheme = () => {
    try {
      frame.contentWindow?.postMessage(
        { type: 'mydict:cmd', cmd: 'theme', theme: currentTheme() },
        '*',
      )
    } catch {
      /* 父页/子页销毁时静默 */
    }
  }

  const onMessage = (event: MessageEvent) => {
    if (event.source !== frame.contentWindow) return
    const data = event.data as { type?: string } & Record<string, unknown>
    if (!data || typeof data.type !== 'string') return
    switch (data.type) {
      case 'mydict:image': {
        // 解析口径与网页版 EntryFrame 一致：urls 缺失/坏数据时退化成单张
        const src = typeof data.src === 'string' && data.src ? data.src : ''
        if (!src) break
        note(`[image] iframe→parent ${src.slice(-56)}`)
        const urls = Array.isArray(data.urls)
          ? data.urls.filter((item): item is string => typeof item === 'string' && !!item)
          : [src]
        const index = Number(data.index)
        options.onImage?.({
          src,
          alt: typeof data.alt === 'string' ? data.alt : '',
          urls: urls.length ? urls : [src],
          index:
            Number.isInteger(index) && index >= 0 && index < urls.length
              ? index
              : Math.max(0, urls.indexOf(src)),
        })
        break
      }
      case 'mydict:ready':
        // 子页监听已装好，这是下发主题最可靠的时机（对齐网页版 EntryFrame.postTheme）
        postTheme()
        break
      case 'mydict:height':
        options.onHeight?.(Number(data.height) || 0)
        break
      case 'mydict:entry':
        if (typeof data.word === 'string' && data.word.trim()) {
          options.onEntry?.(data.word, typeof data.anchor === 'string' ? data.anchor : '')
        }
        break
      case 'mydict:open':
        options.onExternal?.(String(data.url ?? ''))
        break
      case 'mydict:escape':
        options.onEscape?.()
        break
      case 'mydict:audio-unsupported':
        note(`[audio] unsupported ${String(data.url ?? '')}`)
        options.onAudioUnsupported?.()
        break
      case 'mydict:audio-error':
        note(`[audio] error ${String(data.url ?? '')}`)
        break
      case 'mydict:audio-ended':
        note(`[audio] ended ${String(data.url ?? '')}`)
        break
      default:
        break
    }
  }
  window.addEventListener('message', onMessage)

  const resolveBase = (): string => {
    const raw = (typeof options.baseUrl === 'function' ? options.baseUrl() : options.baseUrl).trim()
    if (!raw) return ''
    return raw.endsWith('/') ? raw : `${raw}/`
  }

  return {
    element: frame,
    load(html: string) {
      const base = resolveBase()
      // 服务器地址还没配好时不做任何注入：至少不留下一个指向 tauri:// 的半成品
      frame.srcdoc = base ? withBase(html, base) : html
    },
    destroy() {
      window.removeEventListener('message', onMessage)
      frame.remove()
    },
    refreshTheme: postTheme,
  }
}

/** 把 `<base>` 插到 `<head>` 之后；文档没有 head 时补一个最小骨架 */
export function withBase(html: string, baseHref: string): string {
  const tag = `<base href="${baseHref}">`
  if (/<base\b/i.test(html)) return html // 服务端将来自己加了 base 就不要再插一个
  const headOpen = html.match(/<head[^>]*>/i)
  if (headOpen?.index !== undefined) {
    const at = headOpen.index + headOpen[0].length
    return html.slice(0, at) + tag + html.slice(at)
  }
  return `<!doctype html><html><head>${tag}</head><body>${html}</body></html>`
}
