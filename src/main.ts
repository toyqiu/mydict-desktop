import { listen } from '@tauri-apps/api/event'
import { getCurrentWindow } from '@tauri-apps/api/window'

import { api, type Hit, type Settings } from './api'
import { createEntryFrame, type EntryFrame } from './entry-frame'
import './theme.css'
import './styles.css'

/**
 * 悬浮窗界面：搜索框 + 命中列表 + 词条区；设置收进模态窗。
 *
 * 视觉照 cal 的 aurora 皮肤（令牌见 theme.css）；本项目仍然只管三件事——
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

  <div class="modal-mask" id="settings-modal" hidden>
    <form class="modal-card" id="settings-form">
      <header class="modal-head">
        <h2>设置</h2>
        <button class="icon-btn" id="modal-close" type="button" title="关闭">✕</button>
      </header>
      <div class="modal-body">
        <div class="field-group">
          <div class="group-label">服务器</div>
          <label><span>地址</span><input id="cfg-server" type="text" placeholder="http://192.168.1.10:4815" /></label>
        </div>
        <div class="field-group">
          <div class="group-label">账号</div>
          <label><span>用户名</span><input id="cfg-username" type="text" /></label>
          <label><span>密码</span><input id="cfg-password" type="password" placeholder="留空则只保存设置、不重新登录" /></label>
        </div>
        <div class="field-group">
          <div class="group-label">呼出热键</div>
          <label><span>组合键</span><input id="cfg-hotkey" type="text" placeholder="super+shift+d" /></label>
          <p class="hint" id="hotkey-hint"></p>
        </div>
        <div class="field-group">
          <div class="group-label">行为</div>
          <label class="switch"><input type="checkbox" id="cfg-hide-blur" /><span>失焦自动收起</span></label>
          <label class="switch"><input type="checkbox" id="cfg-selection" /><span>划词优先：有选中文字时直接查它</span></label>
        </div>
      </div>
      <footer class="modal-foot">
        <span class="status-inline" id="modal-status"></span>
        <button class="primary" id="btn-save" type="submit">保存</button>
      </footer>
    </form>
  </div>
`

const input = element<HTMLInputElement>('word-input')
const hitsList = element<HTMLUListElement>('hits')
const entryHost = element('entry')
const statusBox = element('status')
const emptyBox = element('empty')
const resultsPane = element('results')
const hotkeyChip = element('hotkey-chip')
const modal = element('settings-modal')
const modalStatus = element('modal-status')
const hotkeyHint = element('hotkey-hint')

let settings: Settings = {
  server_url: '',
  username: '',
  hotkey: 'super+shift+d',
  theme: 'dark',
  hide_on_blur: true,
  selection_first: true,
}
let hits: Hit[] = []
let activeIndex = -1
let queryWord = ''
let entryFrame: EntryFrame | null = null
const win = getCurrentWindow()

function applyTheme(theme: string) {
  document.documentElement.dataset.theme = theme === 'light' ? 'light' : 'dark'
}

function setStatus(message: string, kind: 'info' | 'error' = 'info') {
  statusBox.textContent = message
  statusBox.className = `status ${kind}`
  statusBox.hidden = !message
}

function setModalStatus(message: string, kind: 'info' | 'error' = 'info') {
  modalStatus.textContent = message
  modalStatus.className = `status-inline ${kind}`
}

function escapeHtml(raw: string): string {
  return raw.replace(
    /[&<>"]/g,
    (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[ch] ?? ch,
  )
}

/* ---------------- 设置模态窗 ---------------- */

function openSettings() {
  const server = element<HTMLInputElement>('cfg-server')
  const username = element<HTMLInputElement>('cfg-username')
  server.value = settings.server_url
  username.value = settings.username
  element<HTMLInputElement>('cfg-hotkey').value = settings.hotkey
  element<HTMLInputElement>('cfg-hide-blur').checked = settings.hide_on_blur
  element<HTMLInputElement>('cfg-selection').checked = settings.selection_first
  hotkeyHint.textContent = '写法：super+shift+d、ctrl+alt+d、f9…保存后立即生效；被别的程序占用时会在这里报出来。'
  setModalStatus('')
  modal.hidden = false
  // 焦点落到第一个需要填的字段：地址 → 用户名
  const target = !server.value ? server : !username.value ? username : server
  target.focus()
  target.select()
}

function closeSettings() {
  modal.hidden = true
  input.focus()
}

async function saveSettings(event: Event) {
  event.preventDefault()
  const server = element<HTMLInputElement>('cfg-server').value.trim()
  const username = element<HTMLInputElement>('cfg-username').value.trim()
  const password = element<HTMLInputElement>('cfg-password').value
  const hotkey = element<HTMLInputElement>('cfg-hotkey').value.trim() || 'super+shift+d'
  if (!server || !username) {
    setModalStatus('服务器地址与用户名都要填', 'error')
    return
  }
  const next: Settings = {
    ...settings,
    server_url: server,
    username,
    hotkey,
    hide_on_blur: element<HTMLInputElement>('cfg-hide-blur').checked,
    selection_first: element<HTMLInputElement>('cfg-selection').checked,
  }
  try {
    setModalStatus('保存中…')
    await api.saveSettings(next)
    settings = next
    hotkeyChip.textContent = hotkey
    hotkeyChip.hidden = false
    const hotkeyProblem = await api.hotkeyError()
    if (password) {
      setModalStatus('登录中…')
      await api.login(username, password)
      element<HTMLInputElement>('cfg-password').value = ''
    }
    if (hotkeyProblem) {
      setModalStatus(hotkeyProblem, 'error')
      return
    }
    setModalStatus(password ? '已保存并登录' : '已保存')
    const status = await api.authStatus()
    if (status.logged_in) {
      showEmpty(true)
      setEmptyContent('输入词语开始查词', '按 Enter 查询；↑/↓ 切换命中的词典，Esc 收起窗口。', null)
      if (input.value.trim()) void runSearch(input.value)
    } else {
      showEmpty(true)
      setEmptyContent('连接你的 MyDict', '账号或密码不对？改完再保存一次。', '打开设置')
    }
    if (password) setTimeout(closeSettings, 500)
    else setTimeout(closeSettings, 300)
  } catch (error) {
    setModalStatus(String(error), 'error')
  }
}

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
element('modal-close').addEventListener('click', closeSettings)
element('empty-cta').addEventListener('click', openSettings)
element('settings-form').addEventListener('submit', (event) => void saveSettings(event))

// 点遮罩空白处关闭（点在卡片内部不关）
modal.addEventListener('mousedown', (event) => {
  if (event.target === modal) closeSettings()
})

element('btn-theme').addEventListener('click', async () => {
  settings.theme = settings.theme === 'light' ? 'dark' : 'light'
  applyTheme(settings.theme)
  await api.saveSettings(settings)
})

// 键盘：Esc 先关弹窗、否则收起窗口；↑/↓ 选命中
document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape') {
    if (!modal.hidden) {
      closeSettings()
    } else {
      void api.note('Esc 收起（键盘事件到了）')
      void api.hideWindow()
    }
    return
  }
  if (!modal.hidden) return
  if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
    if (hits.length === 0) return
    event.preventDefault()
    const delta = event.key === 'ArrowDown' ? 1 : -1
    void selectHit((activeIndex + delta + hits.length) % hits.length)
  }
})

/*
 * 失焦收起（M2）：Rust 侧在热键呼出后会发 `mydict:shown` / `mydict:word`。
 *
 * 「武装」只能挂在**真正的焦点事件**（onFocusChanged(true)）上，不能挂在 mydict:shown 上：
 * Rust 的 show() 返回时窗口还没被 WM 聚焦，此刻就武装的话，X11 随后那次过渡失焦会把刚呼出的
 * 窗口收掉——正是 M1 踩过的坑。划词模式窗口从不拿焦点，也就永远不会武装（它靠 Esc/热键收起）。
 */
let canHideOnBlur = false
/**
 * 划词模式下，呼出后会立刻把焦点归还给用户原来的窗口（见 Rust 的 hand_focus_back）——
 * 那次失焦不是「用户离开了」，不能被当成收起信号。给它一段时间窗。
 */
let suppressBlurUntil = 0
/** 上次武装的时刻：用来忽略「刚聚焦就失焦」的抖动 */
let armedAt = 0

void listen<{ focused: boolean }>('mydict:shown', (event) => {
  if (event.payload.focused) {
    // 普通呼出：把光标放进输入框，等焦点事件到了再武装
    input.focus()
    input.select()
    suppressBlurUntil = 0
  } else {
    // 划词：不动输入框；焦点归还带来的失焦在 1.5s 内不算数
    suppressBlurUntil = Date.now() + 1500
  }
})

void listen<string>('mydict:word', (event) => {
  // 划词：直接查选中的文字，不动输入框焦点（窗口也没拿焦点）
  if (typeof event.payload === 'string' && event.payload.trim()) {
    void runSearch(event.payload)
  }
})

void listen('mydict:hidden', () => {
  canHideOnBlur = false
  suppressBlurUntil = 0
})

void win.onFocusChanged(({ payload: focused }) => {
  if (focused) {
    if (settings.hide_on_blur) {
      canHideOnBlur = true
      armedAt = Date.now()
    }
    return
  }
  if (!canHideOnBlur) return
  // 刚拿到焦点就失焦，是 show/focus 的抖动（XFCE 防焦点窃取会把焦点还回去），
  // 不是「用户离开了」——实测踩到过：每次呼出都被自己立刻收起。
  if (Date.now() - armedAt < 700) return
  if (Date.now() < suppressBlurUntil) return
  void handleBlur()
})

/** 失焦：先确认焦点真的落到别的窗口了，再收起 */
async function handleBlur() {
  const probe = await api.focusProbe()
  const [id, name = ''] = probe.split('|')
  const ours = /^(my)?dict|MyDict/i.test(name)
  if (!id || id === '0' || ours) {
    // 幽灵失焦（焦点交给了空窗口/自己的辅助窗口）：不算用户离开
    void api.note(`忽略幽灵失焦：${probe}`)
    return
  }
  canHideOnBlur = false
  void api.note(`失焦收起：焦点去了 ${probe}`)
  void api.hideWindow()
}

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
  onEscape: () => {
    if (!modal.hidden) closeSettings()
    else void api.hideWindow()
  },
  onAudioUnsupported: () => setStatus('这条发音放不了（词典里的音频格式或文件缺失）', 'error'),
})
entryHost.appendChild(entryFrame.element)

void bootstrap()
