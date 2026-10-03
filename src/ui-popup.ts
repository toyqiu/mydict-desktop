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
import { invoke } from '@tauri-apps/api/core'
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

import { langGroupLabel, langGroupOf } from './langs'
import {
  TRANSLATE_TAB,
  isTranslateCandidate,
  mountTranslateView,
  type TranslateView,
} from './translate'
import { ONLINE_TAB, mountOnlineView, type OnlineView } from './online'

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
    <div class="trans-host" id="p-trans" hidden></div>
    <div class="online-host" id="p-online" hidden></div>

    <footer class="popfoot">
      <span class="status-inline" id="p-status"></span>
    </footer>
  </div>

  <div id="p-settings-host"></div>
`

const wordInput = element<HTMLInputElement>('p-word')
const langsRow = element('p-langs')
const transHost = element('p-trans')
let queryIsTranslate = false
let translateView: TranslateView | null = null
const onlineHost = element('p-online')
let onlineView: OnlineView | null = null

/** 三块面板互斥显示：词典分组 / 翻译视图 / 在线词典视图 */
function showPane(name: 'acc' | 'trans' | 'online'): void {
  accHost.hidden = name !== 'acc'
  transHost.hidden = name !== 'trans'
  onlineHost.hidden = name !== 'online'
}
const accHost = element('p-acc')
const statusBox = element('p-status')

let settings: Settings
let hits: Hit[] = []
// 语言标签 = 检索范围选择器（对齐网页版）：数据源是**词典库**而不是命中结果——
// 库里有哪几种语言就显示哪几项，与这一次命中了什么无关。scope 为空 = 全部（服务端按输入语言路由）。
let langTabs: { lang: string; label: string; dictIds: number[] }[] = []
let activeScope = ''
let queryWord = ''

const setStatus = (message: string, kind: 'info' | 'error' = 'info') => {
  statusBox.textContent = message
  statusBox.className = `status-inline ${kind}`
}

const applyTheme = (theme: string) => {
  document.documentElement.dataset.theme = theme === 'light' ? 'light' : 'dark'
}

/* ---------- 语言分组 ---------- */

async function loadTabs(): Promise<void> {
  try {
    const dicts = await api.dictionaries('usable')
    const byLang = new Map<string, number[]>()
    for (const d of dicts) {
      const lang = langGroupOf(d.lang_from)
      const ids = byLang.get(lang) ?? []
      ids.push(d.id)
      byLang.set(lang, ids)
    }
    langTabs = [...byLang.entries()].map(([lang, dictIds]) => ({
      lang,
      label: langGroupLabel(lang),
      dictIds,
    }))
    renderTabs()
  } catch {
    // 拿不到词典列表就不显示标签行，搜索退回「全部」
  }
}

function renderTabs(): void {
  const chips = [
    { lang: '', label: '全部', dictIds: [] as number[] },
    ...langTabs,
    { lang: ONLINE_TAB, label: '在线', dictIds: [] as number[] },
    { lang: TRANSLATE_TAB, label: '翻译', dictIds: [] as number[] },
  ]
  const existing = [...langsRow.children] as HTMLElement[]
  const sameSet =
    existing.length === chips.length &&
    existing.every((el, index) => el.dataset.lang === chips[index].lang)
  if (sameSet) {
    // 集合没变就只切高亮：重建 innerHTML 会让 .langs 短暂变成 :empty（popup.css 把它
    // display:none），整行消失一帧、下方内容上下跳动——这就是切换标签时的闪动。
    existing.forEach((el, index) => {
      const tab = chips[index]
      el.classList.toggle('active', tab.lang === activeScope)
      const count = el.querySelector('.count')
      if (count) count.textContent = tab.dictIds.length ? String(tab.dictIds.length) : ''
    })
    return
  }
  langsRow.innerHTML = chips
    .map(
      (tab) => `
      <button class="lang-chip ${tab.lang === activeScope ? 'active' : ''}" data-lang="${tab.lang}">
        ${tab.label}<span class="count">${tab.dictIds.length || ''}</span>
      </button>`,
    )
    .join('')
}

const scopeDictIds = (): number[] | undefined =>
  langTabs.find((t) => t.lang === activeScope && t.dictIds.length)?.dictIds

/* ---------------- 手风琴词条区 ---------------- */

// 按词典分组：同一部词典命中多条（同形词、多词形）合并成一个面板，展开时一次渲染
// 该词典的全部词条——服务端把多条合成一个文档（条目间有标题分隔），对齐网页版
// HomeView 的 groups。面板顺序沿用后端给的顺序（优先语言优先、再按 sort_order）。
interface DictGroup {
  key: string
  dictionaryId: number
  dictionaryName: string
  word: string
  phonetic?: string | null
  entries: Hit[]
}

let groups: DictGroup[] = []
let expandedKey: string | null = null
let batchIndex = 0
// 词条渲染接口对 entry_ids 有 200 条上限（防伪造，见后端 dict.py）；搜韵这类
// 「每首诗一个词条」的词典对常见词就是几百条，按批渲染
const BATCH_SIZE = 200
const frames = new Map<string, EntryFrame>()

function regroup(): void {
  const map = new Map<number, DictGroup>()
  for (const hit of hits) {
    let group = map.get(hit.dictionary_id)
    if (!group) {
      group = {
        key: String(hit.dictionary_id),
        dictionaryId: hit.dictionary_id,
        dictionaryName: hit.dictionary_name,
        word: hit.word,
        phonetic: hit.phonetic,
        entries: [],
      }
      map.set(hit.dictionary_id, group)
    }
    group.entries.push(hit)
  }
  groups = [...map.values()]
}

const expandedGroup = (): DictGroup | null => groups.find((g) => g.key === expandedKey) ?? null

async function toggleExpand(group: DictGroup): Promise<void> {
  if (expandedKey === group.key) {
    expandedKey = null
    batchIndex = 0
    renderAccordion()
    setStatus('')
    return
  }
  expandedKey = group.key
  batchIndex = 0
  renderAccordion()
  // 换展开项时把它带回视口：手风琴区是 overflow:auto，长词条滚下去之后再看别的词典，
  // 新标题条会落在视口之外，看起来像「点了没反应」。
  const head = accHost.querySelector<HTMLElement>(`button.acc-head[data-key="${group.key}"]`)
  if (head && head.scrollIntoView) head.scrollIntoView({ block: 'nearest' })
  reportExpandedDict(group)
  await loadEntry(group)
}

/** 展开时在状态栏亮出当前词典与位置——iframe 拉高后其余标题条在视口外，这是唯一的锚 */
function reportExpandedDict(group: DictGroup): void {
  const n = groups.findIndex((g) => g.key === group.key) + 1
  setStatus(`${group.dictionaryName}（${n}/${groups.length}）· ↑/↓ 切换词典`)
}

async function loadEntry(group: DictGroup): Promise<void> {
  setStatus('载入词条…')
  try {
    const ids = group.entries
      .slice(batchIndex * BATCH_SIZE, (batchIndex + 1) * BATCH_SIZE)
      .map((item) => item.id)
    const html = await api.entryHtml(group.dictionaryId, queryWord, ids, settings.theme)
    const key = group.key
    let frame = frames.get(key)
    if (!frame) {
      frame = createEntryFrame({
        baseUrl: () => settings.server_url,
        theme: () => settings.theme,
        onHeight: (height) => {
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
        onImage: (payload) => {
          void invoke('note', { tag: `[image->viewer] popup ${payload.src.slice(-56)}` }).catch(
            () => undefined,
          )
          invoke('open_viewer', payload).catch((err) =>
            invoke('note', { tag: `[viewer-err] ${String(err)}` }).catch(() => undefined),
          )
        },
      })
      frames.set(key, frame)
    }
    frame.load(html)
    if (expandedKey === key) {
      const body = accHost.querySelector(`[data-body="${key}"]`)
      if (body) {
        if (frame.element.parentElement !== body) body.appendChild(frame.element)
        // 分批导航：>200 条的词典按批渲染（网页版同款），按钮在词条文档下方
        const batchCount = Math.ceil(group.entries.length / BATCH_SIZE)
        let nav = body.querySelector('.batch-nav') as HTMLElement | null
        if (batchCount > 1) {
          if (!nav) {
            nav = document.createElement('div')
            nav.className = 'batch-nav'
            body.appendChild(nav)
          }
          const start = batchIndex * BATCH_SIZE + 1
          const end = Math.min((batchIndex + 1) * BATCH_SIZE, group.entries.length)
          nav.innerHTML = `
            <button type="button" data-batch="prev" ${batchIndex === 0 ? 'disabled' : ''}>‹ 上一批</button>
            <span>第 ${batchIndex + 1}/${batchCount} 批 · 第 ${start}-${end} 条</span>
            <button type="button" data-batch="next" ${batchIndex + 1 >= batchCount ? 'disabled' : ''}>下一批 ›</button>`
        } else if (nav) {
          nav.remove()
        }
      }
    }
    setStatus('')
  } catch (error) {
    setStatus(String(error), 'error')
  }
}

function gotoBatch(delta: number): void {
  const group = expandedGroup()
  if (!group) return
  const batchCount = Math.ceil(group.entries.length / BATCH_SIZE)
  const next = batchIndex + delta
  if (next < 0 || next >= batchCount) return
  batchIndex = next
  void loadEntry(group)
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

  accHost.innerHTML = groups
    .map((group) => {
      const expanded = group.key === expandedKey
      return `
      <div class="acc-item ${expanded ? 'expanded' : ''}" data-key="${group.key}">
        <button class="acc-head" data-key="${group.key}">
          <span class="dict">${escapeHtml(group.dictionaryName)}</span>
          <span class="word">${escapeHtml(group.word)}</span>
          ${group.phonetic ? `<span class="phonetic">${escapeHtml(group.phonetic)}</span>` : ''}
          ${group.entries.length > 1 ? `<span class="entries-count">共 ${group.entries.length} 条</span>` : ''}
          <span class="chev">${expanded ? '▾' : '▸'}</span>
        </button>
        <div class="acc-body" data-body="${group.key}"></div>
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

/** 进入在线词典视图：懒加载（缓存命中秒回） */
function enterOnlineView(text: string): void {
  queryIsTranslate = false
  activeScope = ONLINE_TAB
  renderTabs()
  showPane('online')
  if (!onlineView) {
    onlineView = mountOnlineView(onlineHost, {
      settings,
      getToken: () => {
        // token 在 Rust 侧持久化，前端拿不到明文——online_lookup 的 token 传空，
        // 该端点无鉴权也可用（有 token 只是配额归属不同）
        return ''
      },
      text,
    })
  } else {
    onlineView.lookup(text)
  }
}

/** 进入翻译视图：词典分组隐藏，译文懒加载；词典查询不做（切回词典标签时才查） */
function enterTranslateView(text: string): void {
  queryIsTranslate = true
  activeScope = TRANSLATE_TAB
  renderTabs()
  showPane('trans')
  if (!translateView) {
    translateView = mountTranslateView(transHost, {
      text,
      getTargetLang: () => settings.translate_target_lang || 'zh-Hans',
    })
  } else {
    translateView.translate(text)
  }
}

/** 离开翻译视图：显示词典分组区（内容随词典查询回来后渲染） */
function leaveTranslateView(): void {
  if (!queryIsTranslate) return
  queryIsTranslate = false
  if (activeScope === TRANSLATE_TAB) {
    activeScope = ''
    renderTabs()
  }
  showPane('acc')
}

async function runSearch(next: string): Promise<void> {
  const trimmed = next.trim()
  if (!trimmed) return
  wordInput.value = trimmed
  queryWord = trimmed
  // 线路自动判定：像句子/长短语 → 翻译视图先立起来（词典查询不做，切回词典标签再查）
  if (isTranslateCandidate(trimmed)) {
    enterTranslateView(trimmed)
    setStatus('')
    return
  }
  queryIsTranslate = false
  // 伪标签（翻译/在线）不应在词典查询里保持高亮，切回「全部」
  if (activeScope === TRANSLATE_TAB || activeScope === ONLINE_TAB) {
    activeScope = ''
    renderTabs()
  }
  showPane('acc')
  setStatus('查询中…')
  expandedKey = null
  try {
    hits = await api.search(trimmed, scopeDictIds())
    if (hits.length === 0) {
      // 0 命中必须清空旧结果：否则上一个查询的分组列表残留（例：なるほど 日文命中，
      // 切到中文/英文标签返回空，日文列表还挂在下面——用户实测 v0.3.3）
      hits = []
      groups = []
      expandedKey = null
      batchIndex = 0
      for (const [, frame] of frames) frame.destroy()
      frames.clear()
      renderAccordion()
      if (isTranslateCandidate(trimmed)) {
        // 明显是句子/长短语：自动切翻译（与主界面同一策略）
        setStatus(`没有词典收录「${trimmed}」，已切换到翻译`)
        enterTranslateView(trimmed)
      } else {
        setStatus(`没有词典收录「${trimmed}」；可点「翻译」标签看译文`)
      }
      return
    }
    // 新查询从顶部开始看，否则沿用上一次的滚动位置，新词条可能整个落在视口之外
    accHost.scrollTop = 0
    regroup()
    // 默认展开排名第一的词典（该词典的全部词条合成一个文档）
    expandedKey = groups[0]?.key ?? null
    batchIndex = 0
    renderAccordion()
    const first = groups[0]
    if (first) await loadEntry(first)
  } catch (error) {
    hits = []
    groups = []
    expandedKey = null
    batchIndex = 0
    for (const [, frame] of frames) frame.destroy()
    frames.clear()
    renderAccordion()
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
    // 登录/换服务器往往发生在这里：语言标签此时才拿得到（启动时未登录会失败）
    void loadTabs()
    // 剪贴板监听开关 Rust 侧即时生效；这里不用额外处理
  },
  onClosed: () => wordInput.focus(),
})
element('p-settings-host').appendChild(modal.element)

// 调试钩子：MYDICT_DEBUG_EVAL 注入的脚本可以用它驱动灯箱（与 Rust 侧的
// MYDICT_DEBUG_EVAL 一样属于诊断基建，不参与业务逻辑）
;(window as unknown as Record<string, unknown>).__mydict = {
  // 点图 → 独立的查看器窗口（铺满显示器，词典窗口不动）
  openViewer: (payload: {
    src: string
    alt?: string
    urls: string[]
    index: number
  }) => invoke('open_viewer', payload).catch(() => undefined),
}

/* ---------------- 事件 ---------------- */

element('p-form').addEventListener('submit', (event) => {
  event.preventDefault()
  void runSearch(wordInput.value)
})

accHost.addEventListener('click', (event) => {
  // 分批导航按钮（>200 条的词典），在标题条判断之前处理
  const batchBtn = (event.target as HTMLElement).closest<HTMLButtonElement>('button[data-batch]')
  if (batchBtn) {
    gotoBatch(batchBtn.dataset.batch === 'prev' ? -1 : 1)
    return
  }
  const head = (event.target as HTMLElement).closest<HTMLButtonElement>('button.acc-head')
  if (!head || !head.dataset.key) return
  const group = groups.find((g) => g.key === head.dataset.key)
  void api.note(`acc 点击 key=${head.dataset.key} 命中=${group ? group.key : '无'}`)
  if (group) void toggleExpand(group)
})

langsRow.addEventListener('click', (event) => {
  const chip = (event.target as HTMLElement).closest<HTMLButtonElement>('button.lang-chip')
  if (!chip) return
  const lang = chip.dataset.lang ?? ''
  if (lang === activeScope) return
  if (lang === ONLINE_TAB) {
    // 在线伪标签：直进在线词典视图（懒加载，绕过词典查询）
    activeScope = ONLINE_TAB
    renderTabs()
    if (queryWord) enterOnlineView(queryWord)
    return
  }
  if (lang === TRANSLATE_TAB) {
    // 翻译伪标签：直进翻译视图（绕过线路判定——任何查询都能一键看译文）
    activeScope = TRANSLATE_TAB
    renderTabs()
    if (queryWord) enterTranslateView(queryWord)
    return
  }
  activeScope = lang
  renderTabs()
  leaveTranslateView()
  // 切范围就用当前词重查（与网页版「点标签=勾选该语言全部词典」一致）
  if (queryWord) void runSearch(queryWord)
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


window.addEventListener('unhandledrejection', (event) => {
  void invoke('note', { tag: `[unhandled] ${String(event.reason)}` }).catch(() => undefined)
})

document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape') {
    if (modal.isOpen()) modal.close()
    else void api.hideWindow()
    return
  }
  // ↑/↓ 切换展开的词典（对齐网页版 ←/→ 的 moveExpanded）。单行输入框里这两个键
  // 没有原生用途，聚焦时也接管； 原查询词不丢。
  // ←/→ 切换语言标签（检索范围）：与网页版「点标签=勾选该语言全部词典」一致，
  // 切换后用当前词重查。单行输入框里这两个键只剩移动光标一个用途，编辑靠全选+输入即可。
  if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
    // 循环序列 = 语言标签 + 末尾的翻译标签；「全部」只是点击用的重置位，不参与循环
    if (langTabs.length === 0 && !queryWord) return
    event.preventDefault()
    const ordered = [...langTabs, { lang: ONLINE_TAB }, { lang: TRANSLATE_TAB }]
    const delta = event.key === 'ArrowRight' ? 1 : -1
    const at = ordered.findIndex((t) => t.lang === activeScope)
    const next = ordered[(((at + delta) % ordered.length) + ordered.length) % ordered.length]
    if (next.lang === TRANSLATE_TAB) {
      activeScope = TRANSLATE_TAB
      renderTabs()
      if (queryWord) enterTranslateView(queryWord)
      return
    }
    if (next.lang === ONLINE_TAB) {
      activeScope = ONLINE_TAB
      renderTabs()
      if (queryWord) enterOnlineView(queryWord)
      return
    }
    activeScope = next.lang
    renderTabs()
    leaveTranslateView()
    if (queryWord) void runSearch(queryWord)
    return
  }
  if (event.key === 'ArrowUp' || event.key === 'ArrowDown') {
    const items = groups
    if (items.length === 0) return
    event.preventDefault()
    const index = items.findIndex((g) => g.key === expandedKey)
    const delta = event.key === 'ArrowDown' ? 1 : -1
    const next = items[(((index + delta) % items.length) + items.length) % items.length]
    void toggleExpand(next)
  }
})

/* ---------------- 事件桥（Rust → 本窗口） ---------------- */

void listen('mydict:shown', () => {
  // 呼出时把光标放进输入框（划词模式不会走到这里，见 Rust 侧）
  wordInput.focus()
  // 启动时未登录会拿不到语言标签；登录后第一次呼出时补载
  if (langTabs.length === 0) void loadTabs()
  wordInput.select()
})

// 托盘菜单里的「设置…」（Rust 侧 emit 到 popup；此前没人接，托盘点设置只显示面板不弹窗）
void listen('mydict:open-settings', () => modal.open())

// 主界面（或本窗）保存设置后同步：主题立即切换，不再「主界面暗色、面板亮色」；
// 已挂载的词条文档也同步换明暗
void listen<Settings>('mydict:settings-updated', (event) => {
  settings = event.payload
  applyTheme(settings.theme)
  for (const [, frame] of frames) frame.refreshTheme()
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
  void loadTabs()
  wordInput.focus()
}

void bootstrap()
