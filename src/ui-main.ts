import { listen } from '@tauri-apps/api/event'
import { invoke } from '@tauri-apps/api/core'

import { api, type Hit, type Settings } from './api'
import { createEntryFrame, type EntryFrame } from './entry-frame'
import { mountSettingsModal } from './settings-modal'
import { langGroupLabel, langGroupOf } from './langs'
import {
  TRANSLATE_TAB,
  isTranslateCandidate,
  mountTranslateView,
  type TranslateView,
} from './translate'
import { ONLINE_TAB, mountOnlineView, type OnlineView } from './online'
import './theme.css'
import './styles.css'

// mousedown 诊断：真实点击是否到达 DOM（写 stderr，见 /tmp/mydict-desktop.log）
window.addEventListener(
  'mousedown',
  (e) => void api.note(`main mousedown ${e.clientX},${e.clientY} trusted=${e.isTrusted} target=${(e.target as HTMLElement)?.tagName}`),
  true,
)

/**
 * 词典主界面：搜索框 + 命中列表 + 词条区。
 *
 * 这是「浏览」形态的窗口；热键/划词/剪贴板唤起的是快捷搜索窗（ui-popup）。
 * 视觉照 cal 的 aurora 皮肤（令牌见 theme.css）；本项目只管三件事——
 * 把词交给 MyDict 查、把命中列出来、把词条 HTML 交给 entry-frame 渲染。
 */

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
      <span class="hotkey-chip" id="hotkey-chip" data-tauri-drag-region hidden></span>
      <span class="spacer" data-tauri-drag-region></span>
      <button class="icon-btn" id="btn-theme" title="切换明暗">◐</button>
      <button class="icon-btn" id="btn-settings" title="设置">⚙</button>
      <button class="icon-btn" id="btn-hide" title="收起（Esc）">✕</button>
    </header>

    <form class="search" id="search-form">
      <input id="word-input" type="text" placeholder="输入词语，Enter 查询" autocomplete="off" spellcheck="false" />
      <button class="primary" type="submit">查询</button>
    </form>

    <div class="status" id="status" hidden></div>

    <nav class="langs" id="langs" hidden></nav>

    <main class="results" id="results" hidden>
      <ul class="hits" id="hits"></ul>
      <section class="entry" id="entry"></section>
    </main>

    <div class="trans-host" id="trans" hidden></div>
    <div class="online-host" id="online" hidden></div>

    <div class="batch-nav" id="batch-nav" hidden>
      <button type="button" data-batch="prev">‹ 上一批</button>
      <span id="batch-label"></span>
      <button type="button" data-batch="next">下一批 ›</button>
    </div>

    <div class="empty" id="empty">
      <span class="empty-logo"></span>
      <span class="empty-title" id="empty-title">连接你的 MyDict</span>
      <span class="empty-sub" id="empty-sub">
        填好服务器地址与账号就能开始查词。词条排版、发音、词条内跳转都由 MyDict 提供，本项目不重写渲染。
      </span>
      <button class="primary" id="empty-cta" type="button">打开设置</button>
    </div>

    <div id="settings-host"></div>
  </div>
`

const input = element<HTMLInputElement>('word-input')
const hitsList = element<HTMLUListElement>('hits')
const entryHost = element('entry')
const statusBox = element('status')
const emptyBox = element('empty')
const resultsPane = element('results')
const hotkeyChip = element('hotkey-chip')
const langsRow = element<HTMLDivElement>('langs')
const transHost = element<HTMLDivElement>('trans')
let queryIsTranslate = false
let translateView: TranslateView | null = null
const onlineHost = element<HTMLDivElement>('online')
let onlineView: OnlineView | null = null

/** 三块面板互斥显示：结果区 / 翻译视图 / 在线词典视图 */
function showPane(name: 'results' | 'trans' | 'online'): void {
  transHost.hidden = name !== 'trans'
  onlineHost.hidden = name !== 'online'
  // 结果区的显隐与空态逻辑耦合，单独处理
  if (name === 'results') {
    if (groups.length === 0) {
      showEmpty(true)
      setEmptyContent('没有词典收录这个词', '也可以改走翻译线路，或换个词试试。', '翻译')
    } else {
      showEmpty(false)
    }
  } else {
    showEmpty(false)
  }
}
const settingsHost = element('settings-host')

let settings: Settings = {
  server_url: '',
  username: '',
  hotkey: 'super+shift+d',
  theme: 'dark',
  hide_on_blur: true,
  selection_first: true,
  clipboard_watch: true,
  translate_target_lang: 'zh-Hans',
}
let hits: Hit[] = []
let activeIndex = -1
let queryWord = ''
let entryFrame: EntryFrame | null = null
// 按词典分组：同一部词典命中多条（同形词、多词形）合并成一个面板，展开时一次渲染该词典
// 的全部词条——服务端把多条合成一个文档（条目间有标题分隔），对齐网页版 HomeView 的 groups
interface DictGroup {
  key: string
  dictionaryId: number
  dictionaryName: string
  word: string
  phonetic?: string | null
  entries: Hit[]
}
let groups: DictGroup[] = []
let batchIndex = 0
// 词条渲染接口对 entry_ids 有 200 条上限（防伪造，见后端 dict.py）
const BATCH_SIZE = 200
// 命中按词典源语言分组（语义对齐网页版：zh/zh-Hans/zh-Hant 都归「中文」），
// 标签行点选切换，命中列表只显示当前组
// 语言标签 = 检索范围选择器（对齐网页版）：数据源是**词典库**而不是命中结果，
// 库里有哪几种语言就显示哪几项。scope 为空 = 全部（服务端按输入语言路由）。
let langTabs: { lang: string; label: string; dictIds: number[] }[] = []
let activeScope = ''

function applyTheme(theme: string) {
  document.documentElement.dataset.theme = theme === 'light' ? 'light' : 'dark'
}

function setStatus(message: string, kind: 'info' | 'error' = 'info') {
  statusBox.textContent = message
  statusBox.className = `status ${kind}`
  statusBox.hidden = !message
}

function escapeHtml(raw: string): string {
  return raw.replace(
    /[&<>"]/g,
    (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[ch] ?? ch,
  )
}

/* ---------------- 设置模态（共享实现，见 settings-modal.ts） ---------------- */

const settingsModal = mountSettingsModal({
  getSettings: () => settings,
  onSaved: (next) => {
    settings = next
    applyTheme(settings.theme)
    // 登录/换服务器往往发生在这里：语言标签此时才拿得到（启动时未登录会失败）
    void loadTabs()
    if (settings.hotkey) {
      hotkeyChip.textContent = settings.hotkey
      hotkeyChip.hidden = false
    }
  },
  onClosed: () => input.focus(),
})

const openSettings = () => settingsModal.open()

/* ---------------- 搜索与结果 ---------------- */

function showEmpty(visible: boolean) {
  emptyBox.hidden = !visible
  resultsPane.hidden = visible
}

/** 空态的三个槽位：标题 / 说明 / 按钮（按钮传 null 就藏起来） */
function setEmptyContent(title: string, sub: string, cta: string | null) {
  element('empty-title').textContent = title
  element('empty-sub').textContent = sub
  const button = element<HTMLButtonElement>('empty-cta')
  button.textContent = cta ?? ''
  button.hidden = cta === null
}

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
  langsRow.hidden = chips.length <= 2 && langTabs.length <= 1
}

const scopeDictIds = (): number[] | undefined =>
  langTabs.find((t) => t.lang === activeScope && t.dictIds.length)?.dictIds

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

function renderBatchNav(): void {
  const group = groups[activeIndex]
  const nav = element<HTMLDivElement>('batch-nav')
  const batchCount = group ? Math.ceil(group.entries.length / BATCH_SIZE) : 1
  if (!group || batchCount <= 1) {
    nav.hidden = true
    return
  }
  const start = batchIndex * BATCH_SIZE + 1
  const end = Math.min((batchIndex + 1) * BATCH_SIZE, group.entries.length)
  element<HTMLSpanElement>('batch-label').textContent =
    `第 ${batchIndex + 1}/${batchCount} 批 · 第 ${start}-${end} 条`
  const prev = nav.querySelector<HTMLButtonElement>('[data-batch="prev"]')
  const next = nav.querySelector<HTMLButtonElement>('[data-batch="next"]')
  if (prev) prev.disabled = batchIndex === 0
  if (next) next.disabled = batchIndex + 1 >= batchCount
  nav.hidden = false
}

function gotoBatch(delta: number): void {
  const group = groups[activeIndex]
  if (!group) return
  const batchCount = Math.ceil(group.entries.length / BATCH_SIZE)
  const next = batchIndex + delta
  if (next < 0 || next >= batchCount) return
  batchIndex = next
  void loadGroup(group)
}

async function loadGroup(group: DictGroup): Promise<void> {
  const ids = group.entries
    .slice(batchIndex * BATCH_SIZE, (batchIndex + 1) * BATCH_SIZE)
    .map((item) => item.id)
  try {
    const html = await api.entryHtml(group.dictionaryId, queryWord, ids, settings.theme)
    entryFrame?.load(html)
    entryHost.scrollTop = 0
  } catch (error) {
    setStatus(String(error), 'error')
  }
  renderBatchNav()
}

function renderHits() {
  hitsList.innerHTML = groups
    .map(
      (group, index) => `
      <li class="hit ${index === activeIndex ? 'active' : ''}" data-index="${index}">
        <span class="dict ${group.entries.some((item) => item.lang_match === false) ? 'fallback' : ''}">${escapeHtml(group.dictionaryName)}</span>
        <span class="word">${escapeHtml(group.word)}</span>
        ${group.phonetic ? `<span class="phonetic">${escapeHtml(group.phonetic)}</span>` : ''}
        ${group.entries.length > 1 ? `<span class="entries-count">共 ${group.entries.length} 条</span>` : ''}
      </li>`,
    )
    .join('')
}

/** 进入在线词典视图（主界面）：懒加载（缓存命中秒回） */
function enterOnlineView(text: string): void {
  queryIsTranslate = false
  activeScope = ONLINE_TAB
  renderTabs()
  showPane('online')
  if (!onlineView) {
    onlineView = mountOnlineView(onlineHost, {
      settings,
      getToken: () => '',
      text,
    })
  } else {
    onlineView.lookup(text)
  }
}

/** 进入翻译视图（主界面）：结果区隐藏，翻译视图懒加载 */
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

/** 离开翻译视图：显示结果区 */
function leaveTranslateView(): void {
  if (!queryIsTranslate) return
  queryIsTranslate = false
  if (activeScope === TRANSLATE_TAB) {
    activeScope = ''
    renderTabs()
  }
  showPane('results')
}

async function runSearch(next: string) {
  const trimmed = next.trim()
  if (!trimmed) return
  queryWord = trimmed
  input.value = trimmed
  // 线路自动判定：像句子/长短语 → 翻译视图（词典查询不做，切回词典标签再查）
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
  showPane('results')
  // 不显示「查询中…」：状态条隐现（带边框底色的一整条）会让结果区上下弹跳——
  // 切语言标签时这就是用户看到的闪动。本地查询毫秒级，完成前保留旧内容即可。
  try {
    hits = await api.search(trimmed, scopeDictIds())
    if (hits.length === 0) {
      activeIndex = -1
      groups = []
      hitsList.innerHTML = ''
      entryHost.innerHTML = ''
      showEmpty(true)
      if (isTranslateCandidate(trimmed)) {
        // 明显是句子/长短语：自动切翻译（视图先立起来，不打断）
        setEmptyContent(`没有词典收录「${trimmed}」`, '已切换到翻译线路。', null)
        setStatus(`没有词典收录「${trimmed}」，已切换到翻译`)
        enterTranslateView(trimmed)
      } else {
        // 短词查不到是常态：留在错误页，给「翻译」手动出口
        setEmptyContent('没有词典收录这个词', '也可以改走翻译线路。', '翻译')
        const cta = element<HTMLButtonElement>('empty-cta')
        const onCta = () => {
          cta.removeEventListener('click', onCta)
          enterTranslateView(trimmed)
        }
        cta.addEventListener('click', onCta)
      }
      setStatus('')
      return
    }
    showEmpty(false)
    setStatus('')
    activeIndex = 0
    entryHost.scrollTop = 0
    regroup()
    batchIndex = 0
    renderHits()
    await selectHit(0)
  } catch (error) {
    hits = []
    hitsList.innerHTML = ''
    showEmpty(true)
    setEmptyContent('查不了', String(error), '打开设置')
    setStatus(String(error), 'error')
  }
}

async function selectHit(index: number) {
  const group = groups[index]
  if (!group) return
  activeIndex = index
  batchIndex = 0
  renderHits()
  try {
    const ids = group.entries
      .slice(0, BATCH_SIZE)
      .map((item) => item.id)
    const html = await api.entryHtml(group.dictionaryId, queryWord, ids, settings.theme)
    entryFrame?.load(html)
    // 换词条必须把词条区滚回顶部：容器是 overflow:auto，长词条滚下去之后再看一条短词条，
    // 视口会停在短词条下方——整块看起来是空的（用户报的「点开词条看不到任何内容」）。
    entryHost.scrollTop = 0
  } catch (error) {
    setStatus(String(error), 'error')
  }
}

/* ---------------- 启动 ---------------- */

async function bootstrap() {
  settings = await api.getSettings()
  applyTheme(settings.theme)
  if (settings.hotkey) {
    hotkeyChip.textContent = settings.hotkey
    hotkeyChip.hidden = false
  }
  const hotkeyProblem = await api.hotkeyError()
  if (hotkeyProblem) setStatus(hotkeyProblem, 'error')

  const status = await api.authStatus()
  if (!status.logged_in) {
    // 没登录：直接弹设置，别让用户对着空界面猜
    showEmpty(true)
    setEmptyContent(
      '连接你的 MyDict',
      '填好服务器地址与账号就能查词；词条排版、发音、词条内跳转都由 MyDict 提供。',
      '打开设置',
    )
    openSettings()
    return
  }
  showEmpty(true)
  setEmptyContent('输入词语开始查词', '按 Enter 查询；↑/↓ 切换命中的词典，Esc 收起窗口。', null)
  void loadTabs()
  input.focus()
}

/* ---------------- 事件 ---------------- */

element('search-form').addEventListener('submit', (event) => {
  event.preventDefault()
  void runSearch(input.value)
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

hitsList.addEventListener('click', (event) => {
  const li = (event.target as HTMLElement).closest<HTMLLIElement>('li.hit')
  if (!li) return
  void selectHit(Number(li.dataset.index))
})

element('batch-nav').addEventListener('click', (event) => {
  const btn = (event.target as HTMLElement).closest<HTMLButtonElement>('button[data-batch]')
  if (!btn) return
  gotoBatch(btn.dataset.batch === 'prev' ? -1 : 1)
})

element('btn-hide').addEventListener('click', () => void api.hideWindow())
element('btn-settings').addEventListener('click', openSettings)
element('empty-cta').addEventListener('click', openSettings)
element('btn-theme').addEventListener('click', async () => {
  settings.theme = settings.theme === 'light' ? 'dark' : 'light'
  applyTheme(settings.theme)
  await api.saveSettings(settings)
})

// 键盘：Esc 收起窗口（主界面没有弹窗要管）；↑/↓ 选命中
document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape') {
    // 设置模态开着时先关模态，别把整个窗口收起来
    if (settingsModal.isOpen()) settingsModal.close()
    else void api.hideWindow()
    return
  }
  // ←/→ 切换语言标签（检索范围），切换后用当前词重查
  if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
    // 循环序列 = 语言标签 + 末尾的翻译标签；「全部」只是点击用的重置位，不参与循环
    if (langTabs.length === 0 && !queryWord) return
    event.preventDefault()
    const ordered = [...langTabs, { lang: TRANSLATE_TAB }]
    const delta = event.key === 'ArrowRight' ? 1 : -1
    const at = ordered.findIndex((t) => t.lang === activeScope)
    const next = ordered[(((at + delta) % ordered.length) + ordered.length) % ordered.length]
    if (next.lang === TRANSLATE_TAB) {
      activeScope = TRANSLATE_TAB
      renderTabs()
      if (queryWord) enterTranslateView(queryWord)
      return
    }
    activeScope = next.lang
    renderTabs()
    leaveTranslateView()
    if (queryWord) void runSearch(queryWord)
    return
  }
  if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
    if (groups.length === 0) return
    event.preventDefault()
    const delta = event.key === 'ArrowDown' ? 1 : -1
    void selectHit((activeIndex + delta + groups.length) % groups.length)
  }
})

// 托盘菜单里的「设置…」
void listen('mydict:open-settings', () => openSettings())

// 激活（托盘/弹窗 ⧉ 打开）即聚焦搜索框并全选：随时可以改词重查
void listen('mydict:main-shown', () => {
  input.focus()
  input.select()
})

// 另一个窗口保存了设置：同步副本并立即换主题（此前「主界面暗色、面板亮色」就是这么来的）
void listen<Settings>('mydict:settings-updated', (event) => {
  // 启动时未登录会拿不到语言标签；设置保存（含登录）后补载
  if (langTabs.length === 0) void loadTabs()
  settings = event.payload
  applyTheme(settings.theme)
  // 已挂载的词条文档同步换明暗（iframe 保留着播放位置，不能重建）
  entryFrame?.refreshTheme()
  if (settings.hotkey) {
    hotkeyChip.textContent = settings.hotkey
    hotkeyChip.hidden = false
  }
})

// 模态必须挂进 DOM：此前只创建未 append，主窗口的 ⚙/「打开设置」点了没有任何反应
settingsHost.appendChild(settingsModal.element)

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

entryFrame = createEntryFrame({
  baseUrl: () => settings.server_url,
  theme: () => settings.theme,
  onHeight: (height) => {
    if (entryFrame && height > 0) entryFrame.element.style.height = `${height}px`
  },
  onEntry: (word) => {
    void runSearch(word)
    input.focus()
  },
  onExternal: (url) => {
    if (url) void api.openExternal(url)
  },
  onEscape: () => void api.hideWindow(),
  onAudioUnsupported: () => setStatus('这条发音放不了（词典里的音频格式或文件缺失）', 'error'),
  onImage: (payload) => {
    void invoke('note', { tag: `[image->viewer] main ${payload.src.slice(-56)}` }).catch(
      () => undefined,
    )
    invoke('open_viewer', payload).catch((err) =>
      invoke('note', { tag: `[viewer-err] ${String(err)}` }).catch(() => undefined),
    )
  },
})
entryHost.appendChild(entryFrame.element)

void bootstrap()
