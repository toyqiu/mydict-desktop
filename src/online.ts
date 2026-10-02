/**
 * 在线词典标签（Wikipedia / Wiktionary / 百度百科 聚合）。
 *
 * 数据来自 MyDict 服务端聚合端点（服务端抓取并纯文本化，600s 缓存 + 独立限流），
 * 桌面端只做卡片渲染——全部 textContent 注入，不渲染第三方 HTML。
 * 已知坑：服务端 links 可能为空数组（取决于 online_dict_sources 配置，空是正常
 * 现象不是异常）；403 的语义是「功能未开启」而不是 Token 问题。
 */

import type { Settings } from './api'
import { api } from './api'
import { guessSourceLang } from './translate'

/** 在线伪标签的 value：不会与任何语言码冲突 */
export const ONLINE_TAB = '__online__'

interface OnlineLink {
  id?: string
  name?: string
  url?: string
}

interface OnlineSection {
  id?: string
  name?: string
  title?: string
  subtitle?: string
  text?: string
  url?: string
  entries?:
    | {
        pos?: string
        language?: string
        senses?: { text?: string; examples?: string[] }[]
      }[]
    | null
}

interface OnlineData {
  sections?: OnlineSection[] | null
  links?: OnlineLink[] | null
}

/* ---------------- 模块级 LRU 缓存（同一词反复切换不发请求） ---------------- */

const cache = new Map<string, OnlineData | { error: string }>()
const CACHE_LIMIT = 200

function cacheKey(lang: string, text: string): string {
  return `${lang}:${text}`
}

function cacheGet(key: string): OnlineData | { error: string } | undefined {
  const hit = cache.get(key)
  if (hit === undefined) return undefined
  cache.delete(key)
  cache.set(key, hit)
  return hit
}

function cachePut(key: string, value: OnlineData | { error: string }): void {
  if (cache.size >= CACHE_LIMIT) {
    const oldest = cache.keys().next().value
    if (oldest !== undefined) cache.delete(oldest)
  }
  cache.set(key, value)
}

/* ---------------- 渲染 ---------------- */

function escapeHtml(raw: string): string {
  return raw.replace(
    /[&<>"]/g,
    (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[ch] ?? ch,
  )
}

export interface OnlineView {
  element: HTMLElement
  /** 换了要查的词（同一窗口复用时）：重置为加载态并发起查询（缓存命中秒回） */
  lookup(text: string): void
}

/**
 * 在 container 里渲染在线词典视图（懒加载：mount 时不请求，lookup 才发）。
 * 失败分档：网络失败 / HTTP 状态码 / UNSUPPORTED（服务端功能未开启）。
 */
export function mountOnlineView(
  container: HTMLElement,
  options: {
    settings: Pick<Settings, 'server_url' | 'translate_target_lang'>
    getToken: () => string
    text: string
  },
): OnlineView {
  container.classList.add('online-host')
  container.innerHTML = '<div class="online-view"></div>'
  const box = container.querySelector('.online-view') as HTMLElement

  function setBusy(): void {
    box.innerHTML = '<div class="online-loading">正在查询在线词典…</div>'
  }

  function setError(message: string, retry: () => void): void {
    box.innerHTML = ''
    const err = document.createElement('span')
    err.className = 'online-error'
    err.textContent = message
    const btn = document.createElement('button')
    btn.type = 'button'
    btn.className = 'online-retry'
    btn.textContent = '重试'
    btn.addEventListener('click', retry)
    box.append(err, btn)
  }

  function setEmpty(): void {
    box.innerHTML = '<div class="online-empty">在线词典没有返回内容</div>'
  }

  function setUnsupported(): void {
    box.innerHTML =
      '<div class="online-empty">在线词典未开启（MyDict 管理后台 → 系统设置）</div>'
  }

  function setData(data: OnlineData): void {
    const sections = Array.isArray(data.sections) ? data.sections : []
    const links = Array.isArray(data.links) ? data.links : []
    if (sections.length === 0 && links.length === 0) {
      setEmpty()
      return
    }
    box.innerHTML = ''
    for (const section of sections) {
      const card = document.createElement('div')
      card.className = 'online-card'
      const head = document.createElement('div')
      head.className = 'online-card-head'
      head.innerHTML = `<span class="online-card-name">${escapeHtml(section.name ?? section.id ?? '')}</span>`
      if (section.url) {
        const open = document.createElement('button')
        open.type = 'button'
        open.className = 'online-open'
        open.textContent = '在新标签页打开 ↗'
        open.addEventListener('click', () => void api.openExternal(section.url as string))
        head.appendChild(open)
      }
      card.appendChild(head)
      if (section.title) {
        const t = document.createElement('div')
        t.className = 'online-card-title'
        t.textContent = section.title
        card.appendChild(t)
      }
      if (section.subtitle) {
        const st = document.createElement('div')
        st.className = 'online-card-subtitle'
        st.textContent = section.subtitle
        card.appendChild(st)
      }
      if (section.text) {
        const tx = document.createElement('div')
        tx.className = 'online-card-text'
        tx.textContent = section.text
        card.appendChild(tx)
      }
      for (const entry of section.entries ?? []) {
        const meta = [entry.pos, entry.language].filter(Boolean).join(' · ')
        if (meta) {
          const m = document.createElement('div')
          m.className = 'online-card-meta'
          m.textContent = meta
          card.appendChild(m)
        }
        for (const sense of entry.senses ?? []) {
          if (!sense.text) continue
          const li = document.createElement('div')
          li.className = 'online-sense'
          li.textContent = `• ${sense.text}`
          card.appendChild(li)
          for (const example of sense.examples ?? []) {
            const ex = document.createElement('div')
            ex.className = 'online-example'
            ex.textContent = example
            card.appendChild(ex)
          }
        }
      }
      box.appendChild(card)
    }
    if (links.length > 0) {
      const row = document.createElement('div')
      row.className = 'online-links'
      for (const link of links) {
        if (!link.url || !link.name) continue
        const a = document.createElement('button')
        a.type = 'button'
        a.className = 'online-link'
        a.textContent = link.name
        a.addEventListener('click', () => void api.openExternal(link.url as string))
        row.appendChild(a)
      }
      if (row.children.length > 0) box.appendChild(row)
    }
  }

  async function lookup(text: string): Promise<void> {
    const raw = (text ?? '').trim()
    if (!raw) return
    const lang = guessSourceLang(raw).slice(0, 2)
    const key = cacheKey(lang, raw)
    const hit = cacheGet(key)
    if (hit !== undefined) {
      if ('error' in hit) setError(hit.error, () => void lookup(text))
      else setData(hit)
      return
    }
    setBusy()
    try {
      const data = (await api.onlineLookup(
        options.settings.server_url,
        options.getToken(),
        raw,
        lang,
      )) as OnlineData
      cachePut(key, data)
      setData(data)
    } catch (error) {
      const message = String(error)
      if (message.startsWith('UNSUPPORTED:')) {
        setUnsupported()
        cachePut(key, { error: message.replace('UNSUPPORTED:', '') })
        return
      }
      const reason = message.startsWith('HTTP') ? `在线词典出错（${message}）` : `网络失败：${message}`
      setError(reason, () => void lookup(text))
    }
  }

  return {
    element: container,
    lookup(text: string): void {
      void lookup(text)
    },
  }
}
