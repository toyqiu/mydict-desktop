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

export interface EntryFrameOptions {
  /**
   * 服务器根地址，如 http://192.168.5.197:4815；尾部斜杠会自动补。
   * 允许传函数：设置页改完地址后不必重建 frame，下一次渲染就用新地址。
   */
  baseUrl: string | (() => string)
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
}

export function createEntryFrame(options: EntryFrameOptions): EntryFrame {
  const frame = document.createElement('iframe')
  frame.className = 'entry-frame'
  frame.setAttribute('sandbox', 'allow-scripts')
  frame.setAttribute('referrerpolicy', 'no-referrer')
  frame.setAttribute('title', '词条')
  frame.srcdoc = '<!doctype html><html><body></body></html>'

  const onMessage = (event: MessageEvent) => {
    if (event.source !== frame.contentWindow) return
    const data = event.data as { type?: string } & Record<string, unknown>
    if (!data || typeof data.type !== 'string') return
    switch (data.type) {
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
        console.error(`[audio] unsupported ${String(data.url ?? '')}`)
        options.onAudioUnsupported?.()
        break
      case 'mydict:audio-error':
        console.error(`[audio] error ${String(data.url ?? '')}`)
        break
      case 'mydict:audio-ended':
        console.error(`[audio] ended ${String(data.url ?? '')}`)
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
