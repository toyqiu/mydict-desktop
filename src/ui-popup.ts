/**
 * 快捷搜索窗（popup）——轻量形态，对标 MyReader 的查词面板：
 *
 *   [输入框]
 *   [语言标签行]   ← 命中按词典源语言分组，点标签切换词典组
 *   [手风琴词条区]  ← 默认展开该组排名第一的词典，其余折叠为标题条；点标题条切换展开
 *
 * 与主界面（词典浏览）是两个窗口：本窗口由全局热键 / 划词 / 剪贴板监听唤起。
 */

import { listen } from '@tauri-apps/api/event'
import { api, type Hit, type Settings } from './api'
import { createEntryFrame, type EntryFrame } from './entry-frame'
import { mountSettingsModal } from './settings-modal'
import './theme.css'
import './popup.css'

// mousedown 诊断：真实点击是否到达 DOM（写 stderr，见 /tmp/mydict-desktop.log）
window.addEventListener(
  'mousedown',
  (e) => {
    const stack = document
      .elementsFromPoint(e.clientX, e.clientY)
      .slice(0, 3)
      .map((el) => `${el.tagName}${el.id ? '#' + el.id : ''}[${String(el.className).slice(0, 20)}]`)
      .join(' >> ')
    const head = document.querySelector('button.acc-head')
    const hr = head ? head.getBoundingClientRect() : null
    void api.note(
      `popup mousedown ${e.clientX},${e.clientY} trusted=${e.isTrusted} 栈=${stack} 首标题条=${hr ? `${Math.round(hr.x)},${Math.round(hr.y)} ${Math.round(hr.width)}x${Math.round(hr.height)}` : '无'}`,
    )
  },
  true,
)

const LANG_LABELS: Record<string, string> = {
  'zh-Hans': '简中',
  'zh-Hant': '繁中',
  zh: '中文',
  ja: '日语',
  en: '英语',
  ko: '韩语',
  fr: '法语',
  de: '德语',
  ru: '俄语',
}

const langLabel = (code: string | null | undefined): string =>
  code ? (LANG_LABELS[code] ?? code) : '未知'

const element = <T extends HTMLElement>(id: string): T => {
  const found = document.getElementById(id)
  if (!found) throw new Error(`界面元素缺失：#${id}`)
  return found as T
}

const app = element('app')
app.innerHTML = `
  <div class="app">
    <header class="titlebar" data-tauri-drag-region>
      <span class="logo" data-tauri-drag-region></span>
      <span class="brand" data-tauri-drag-region>MYDICT</span>
      <span class="spacer" data-tauri-drag-region></span>
      <button class="icon-btn" id="p-main" title="打开词典主界面">⧉</button>
      <button class="icon-btn" id="p-settings" title="设置">⚙</button>
      <button class="icon-btn" id="p-hide" title="收起（Esc）">✕</button>
    </header>

    <form class="search" id="p-form">
      <input id="p-word" type="text" placeholder="输入词语，Enter 查询" autocomplete="off" spellcheck="false" />
    </form>

    <nav class="langs" id="p-langs"></nav>

    <div class="acc" id="p-acc"></div>

    <footer class="popfoot">
      <span class="status-inline" id="p-status"></span>
    </footer>
  </div>

  <div id="p-settings-host"></div>
`

const wordInput = element<HTMLInputElement>('p-word')
const langsRow = element('p-langs')
const accHost = element('p-acc')
const statusBox = element('p-status')

let settings: Settings
let hits: Hit[] = []
let groups: { lang: string; label: string; items: Hit[] }[] = []
let activeLang = ''
let expandedKey: string | null = null
let queryWord = ''
const frames = new Map<string, EntryFrame>()

const setStatus = (message: string, kind: 'info' | 'error' = 'info') => {
  statusBox.textContent = message
  statusBox.className = `status-inline ${kind}`
}

const applyTheme = (theme: string) => {
  document.documentElement.dataset.theme = theme === 'light' ? 'light' : 'dark'
}

/* ---------- 语言分组 ---------- */

function regroup(): void {
  const byLang = new Map<string, Hit[]>()
  for (const hit of hits) {
    const lang = hit.lang_from ?? 'other'
    const list = byLang.get(lang) ?? []
    list.push(hit)
    byLang.set(lang, list)
  }
  // 排序：与输入语言一致的组在前，其后按命中数降序
  groups = [...byLang.entries()]
    .map(([lang, items]) => ({ lang, label: langLabel(lang), items }))
    .sort((a, b) => {
      const aMatch = a.items.some((item) => item.lang_match !== false) ? 0 : 1
      const bMatch = b.items.some((item) => item.lang_match !== false) ? 0 : 1
      return aMatch - bMatch || b.items.length - a.items.length
    })
  if (!groups.some((g) => g.lang === activeLang)) {
    activeLang = groups[0]?.lang ?? ''
  }
}

function renderLangs(): void {
  langsRow.innerHTML = groups
    .map(
      (group) => `
      <button class="lang-chip ${group.lang === activeLang ? 'active' : ''}" data-lang="${group.lang}">
        ${group.label}<span class="count">${group.items.length}</span>
      </button>`,
    )
    .join('')
}

/* ---------- 手风琴词条区 ---------- */

const hitKey = (hit: Hit): string => `${hit.dictionary_id}-${hit.id}`

/** 当前语言组里的命中（展开/折叠都只在这个组里发生） */
const visibleHits = (): Hit[] => groups.find((g) => g.lang === activeLang)?.items ?? []

async function toggleExpand(hit: Hit): Promise<void> {
  const key = hitKey(hit)
  if (expandedKey === key) {
    expandedKey = null
    renderAccordion()
    setStatus('')
    return
  }
  expandedKey = key
  renderAccordion()
  // 换展开项时把它带回视口：手风琴区是 overflow:auto，长词条滚下去之后再看别的词典，
  // 新标题条会落在视口之外，看起来像「点了没反应」。
  const head = accHost.querySelector<HTMLElement>(`button.acc-head[data-key="${key}"]`)
  if (head && head.scrollIntoView) head.scrollIntoView({ block: 'nearest' })
  reportExpandedDict(hit)
  await loadEntry(hit)
}

/** 展开时在状态栏亮出当前词典与位置——iframe 拉高后其余标题条在视口外，这是唯一的锚 */
function reportExpandedDict(hit: Hit): void {
  const items = visibleHits()
  const n = items.findIndex((h) => hitKey(h) === hitKey(hit)) + 1
  setStatus(`${hit.dictionary_name}（${n}/${items.length}）· ↑/↓ 切换词典`)
}

async function loadEntry(hit: Hit): Promise<void> {
  setStatus('载入词条…')
  try {
    const html = await api.entryHtml(hit.dictionary_id, queryWord, [hit.id])
    // 复用主界面的 entry-frame：同一个文档只挂在一个 iframe 上，切组时销毁重建
    const key = hitKey(hit)
    let frame = frames.get(key)
    if (!frame) {
      frame = createEntryFrame({
        baseUrl: () => settings.server_url,
        onHeight: (height) => {
          // 高度链路诊断：词条「高度超低」问题时看这里——子页报了多少、最终设了多少
          console.error(`[height] key=${hitKey(hit)} 报=${height}`)
          if (frame && height > 0) frame.element.style.height = `${height}px`
        },
        onEntry: (word) => {
          void runSearch(word)
        },
        onExternal: (url) => {
          if (url) void api.openExternal(url)
        },
        onEscape: () => void api.hideWindow(),
        onAudioUnsupported: () => setStatus('这条发音放不了（词典里的音频格式或文件缺失）', 'error'),
      })
      frames.set(key, frame)
    }
    frame.load(html)
    // 挂载：renderAccordion 跑在 frame 创建之前（那时 body 还是空的，CSS 对空 body
    // 是 display:none），所以加载完成后必须由这里挂载；renderAccordion 的挂载逻辑
    // 只服务「渲染时 frame 已存在」的路径
    if (expandedKey === key) {
      const body = accHost.querySelector(`[data-body="${key}"]`)
      if (body && frame.element.parentElement !== body) body.appendChild(frame.element)
    }
    setStatus('')
  } catch (error) {
    setStatus(String(error), 'error')
  }
}

function renderAccordion(): void {
  // 只保留当前展开项的 frame，其余销毁（iframe 很占资源）
  const keep = expandedKey ? new Set([expandedKey]) : new Set<string>()
  for (const [key, frame] of frames) {
    if (!keep.has(key)) {
      frame.destroy()
      frames.delete(key)
    }
  }

  accHost.innerHTML = visibleHits()
    .map((hit) => {
      const key = hitKey(hit)
      const expanded = key === expandedKey
      return `
      <div class="acc-item ${expanded ? 'expanded' : ''}" data-key="${key}">
        <button class="acc-head" data-key="${key}">
          <span class="word">${escapeHtml(hit.word)}</span>
          ${hit.phonetic ? `<span class="phonetic">${escapeHtml(hit.phonetic)}</span>` : ''}
          <span class="dict">${escapeHtml(hit.dictionary_name)}</span>
          <span class="chev">${expanded ? '▾' : '▸'}</span>
        </button>
        <div class="acc-body" data-body="${key}">
          ${expanded ? '' : ''}
        </div>
      </div>`
    })
    .join('')

  // 展开项的 body 里放对应的 iframe
  if (expandedKey) {
    const frame = frames.get(expandedKey)
    const body = accHost.querySelector(`[data-body="${expandedKey}"]`)
    if (frame && body) body.appendChild(frame.element)
  }
}

function escapeHtml(raw: string): string {
  return raw.replace(
    /[&<>"]/g,
    (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[ch] ?? ch,
  )
}

/* ---------- 搜索 ---------- */

async function runSearch(next: string): Promise<void> {
  const trimmed = next.trim()
  if (!trimmed) return
  wordInput.value = trimmed
  queryWord = trimmed
  setStatus('查询中…')
  expandedKey = null
  try {
    hits = await api.search(trimmed)
    if (hits.length === 0) {
      groups = []
      renderLangs()
      renderAccordion()
      setStatus(`没有找到「${trimmed}」`)
      return
    }
    regroup()
    renderLangs()
    // 新查询从顶部开始看，否则沿用上一次的滚动位置，新词条可能整个落在视口之外
    accHost.scrollTop = 0
    // 默认展开排名第一的词典（当前语言组里的第一条）
    expandedKey = hitKey(visibleHits()[0])
    renderAccordion()
    await loadEntry(visibleHits()[0])
  } catch (error) {
    setStatus(String(error), 'error')
  }
}

/* ---------- 主界面 ---------- */

async function openMain(): Promise<void> {
  // 主窗口由 Rust 常驻管理：走 Rust 命令显示并聚焦，popup 让位（避免盖在主界面上）
  await api.openMain()
}

/* ---------------- 设置模态（与主界面共用同一份实现） ---------------- */

const modal = mountSettingsModal({
  getSettings: () => settings,
  onSaved: (next) => {
    settings = next
    applyTheme(settings.theme)
    // 剪贴板监听开关 Rust 侧即时生效；这里不用额外处理
  },
  onClosed: () => wordInput.focus(),
})
element('p-settings-host').appendChild(modal.element)

/* ---------------- 事件 ---------------- */

element('p-form').addEventListener('submit', (event) => {
  event.preventDefault()
  void runSearch(wordInput.value)
})

accHost.addEventListener('click', (event) => {
  const head = (event.target as HTMLElement).closest<HTMLButtonElement>('button.acc-head')
  if (!head || !head.dataset.key) return
  const hit = visibleHits().find((h) => hitKey(h) === head.dataset.key)
  void api.note(`acc 点击 key=${head.dataset.key} 命中=${hit ? hitKey(hit) : '无'}`)
  if (hit) void toggleExpand(hit)
})

langsRow.addEventListener('click', (event) => {
  const chip = (event.target as HTMLElement).closest<HTMLButtonElement>('button.lang-chip')
  if (!chip) return
  activeLang = chip.dataset.lang ?? activeLang
  expandedKey = null
  renderLangs()
  renderAccordion()
  // 切组后默认展开该组排名第一的词典
  const first = visibleHits()[0]
  if (first) void toggleExpand(first)
})

element('p-hide').addEventListener('click', () => void api.hideWindow())
element('p-main').addEventListener('click', () => {
  void api.note('⧉ 点击')
  void openMain()
})
element('p-settings').addEventListener('click', () => {
  void api.note('⚙ 点击')
  modal.open()
})


document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape') {
    if (modal.isOpen()) modal.close()
    else void api.hideWindow()
    return
  }
  // ↑/↓ 切换展开的词典（对齐网页版 ←/→ 的 moveExpanded）。单行输入框里这两个键
  // 没有原生用途，聚焦时也接管； 原查询词不丢。
  if (event.key === 'ArrowUp' || event.key === 'ArrowDown') {
    const items = visibleHits()
    if (items.length === 0) return
    event.preventDefault()
    const index = items.findIndex((h) => hitKey(h) === expandedKey)
    const delta = event.key === 'ArrowDown' ? 1 : -1
    const next = items[(((index + delta) % items.length) + items.length) % items.length]
    void toggleExpand(next)
  }
})

/* ---------------- 事件桥（Rust → 本窗口） ---------------- */

void listen('mydict:shown', () => {
  // 呼出时把光标放进输入框（划词模式不会走到这里，见 Rust 侧）
  wordInput.focus()
  wordInput.select()
})

void listen<string>('mydict:word', (event) => {
  if (typeof event.payload === 'string' && event.payload.trim()) {
    void runSearch(event.payload)
  }
})

/* ---------------- 启动 ---------------- */

async function bootstrap(): Promise<void> {
  settings = await api.getSettings()
  applyTheme(settings.theme)
  const status = await api.authStatus()
  if (!status.logged_in) {
    setStatus('尚未登录：打开设置填服务器与账号')
    modal.open()
    return
  }
  wordInput.focus()
}

void bootstrap()
