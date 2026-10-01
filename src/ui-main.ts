import { listen } from '@tauri-apps/api/event'

import { api, type Hit, type Settings } from './api'
import { createEntryFrame, type EntryFrame } from './entry-frame'
import { mountSettingsModal } from './settings-modal'
import { langGroupLabel, langGroupOf } from './langs'
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
const settingsHost = element('settings-host')

let settings: Settings = {
  server_url: '',
  username: '',
  hotkey: 'super+shift+d',
  theme: 'dark',
  hide_on_blur: true,
  selection_first: true,
  clipboard_watch: true,
}
let hits: Hit[] = []
let activeIndex = -1
let queryWord = ''
let entryFrame: EntryFrame | null = null
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
  const chips = [{ lang: '', label: '全部', dictIds: [] as number[] }, ...langTabs]
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

function renderHits() {
  const items = hits
  hitsList.innerHTML = items
    .map(
      (hit, index) => `
      <li class="hit ${index === activeIndex ? 'active' : ''}" data-index="${index}">
        <span class="word">${escapeHtml(hit.word)}</span>
        ${hit.phonetic ? `<span class="phonetic">${escapeHtml(hit.phonetic)}</span>` : ''}
        <span class="dict ${hit.lang_match === false ? 'fallback' : ''}">${escapeHtml(hit.dictionary_name)}</span>
      </li>`,
    )
    .join('')
}

async function runSearch(next: string) {
  const trimmed = next.trim()
  if (!trimmed) return
  queryWord = trimmed
  input.value = trimmed
  // 不显示「查询中…」：状态条隐现（带边框底色的一整条）会让结果区上下弹跳——
  // 切语言标签时这就是用户看到的闪动。本地查询毫秒级，完成前保留旧内容即可。
  try {
    hits = await api.search(trimmed, scopeDictIds())
    if (hits.length === 0) {
      activeIndex = -1
      hitsList.innerHTML = ''
      entryHost.innerHTML = ''
      showEmpty(true)
      setEmptyContent(`没有找到「${trimmed}」`, '换个词试试，或者在设置里检查检索范围与账号。', null)
      setStatus('')
      return
    }
    showEmpty(false)
    setStatus('')
    activeIndex = 0
    entryHost.scrollTop = 0
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
  const hit = hits[index]
  if (!hit) return
  activeIndex = index
  renderHits()
  try {
    const html = await api.entryHtml(hit.dictionary_id, queryWord, [hit.id])
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
  activeScope = lang
  renderTabs()
  // 切范围就用当前词重查（与网页版「点标签=勾选该语言全部词典」一致）
  if (queryWord) void runSearch(queryWord)
})

hitsList.addEventListener('click', (event) => {
  const li = (event.target as HTMLElement).closest<HTMLLIElement>('li.hit')
  if (!li) return
  void selectHit(Number(li.dataset.index))
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
  if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
    const items = hits
    if (items.length === 0) return
    event.preventDefault()
    const delta = event.key === 'ArrowDown' ? 1 : -1
    void selectHit((activeIndex + delta + items.length) % items.length)
  }
})

// 托盘菜单里的「设置…」
void listen('mydict:open-settings', () => openSettings())

// 另一个窗口保存了设置：同步副本并立即换主题（此前「主界面暗色、面板亮色」就是这么来的）
void listen<Settings>('mydict:settings-updated', (event) => {
  settings = event.payload
  applyTheme(settings.theme)
  if (settings.hotkey) {
    hotkeyChip.textContent = settings.hotkey
    hotkeyChip.hidden = false
  }
})

// 模态必须挂进 DOM：此前只创建未 append，主窗口的 ⚙/「打开设置」点了没有任何反应
settingsHost.appendChild(settingsModal.element)

entryFrame = createEntryFrame({
  baseUrl: () => settings.server_url,
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
})
entryHost.appendChild(entryFrame.element)

void bootstrap()
