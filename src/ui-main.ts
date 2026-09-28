import { listen } from '@tauri-apps/api/event'

import { api, type Hit, type Settings } from './api'
import { createEntryFrame, type EntryFrame } from './entry-frame'
import { mountSettingsModal } from './settings-modal'
import './theme.css'
import './styles.css'

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
  </div>
`

const input = element<HTMLInputElement>('word-input')
const hitsList = element<HTMLUListElement>('hits')
const entryHost = element('entry')
const statusBox = element('status')
const emptyBox = element('empty')
const resultsPane = element('results')
const hotkeyChip = element('hotkey-chip')

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

function renderHits() {
  hitsList.innerHTML = hits
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
  setStatus('查询中…')
  try {
    hits = await api.search(trimmed)
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
  input.focus()
}

/* ---------------- 事件 ---------------- */

element('search-form').addEventListener('submit', (event) => {
  event.preventDefault()
  void runSearch(input.value)
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
    void api.hideWindow()
    return
  }
  if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
    if (hits.length === 0) return
    event.preventDefault()
    const delta = event.key === 'ArrowDown' ? 1 : -1
    void selectHit((activeIndex + delta + hits.length) % hits.length)
  }
})

// 托盘菜单里的「设置…」
void listen('mydict:open-settings', () => openSettings())

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
