import { api, type Hit, type Settings } from './api'
import { createEntryFrame, type EntryFrame } from './entry-frame'
import './styles.css'

/**
 * 悬浮窗界面：搜索框 + 命中列表 + 词条区。
 *
 * 只有三件事：把词交给 MyDict 查、把命中列出来、把词条 HTML 交给 entry-frame 渲染。
 * 其余（排版、发音、词条内跳转、选中查词）都在 MyDict 的词条文档里，本项目不重写。
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
      <span class="brand" data-tauri-drag-region>MyDict</span>
      <span class="hotkey" id="hotkey-hint" data-tauri-drag-region></span>
      <span class="spacer" data-tauri-drag-region></span>
      <button class="icon" id="btn-settings" title="设置">⚙</button>
      <button class="icon" id="btn-hide" title="收起（Esc）">✕</button>
    </header>

    <form class="search" id="search-form">
      <input id="word-input" type="text" placeholder="输入词语，Enter 查询" autocomplete="off" spellcheck="false" />
    </form>

    <div class="status" id="status" hidden></div>

    <form class="panel" id="setup" hidden>
      <label>服务器地址<input id="cfg-server" placeholder="http://192.168.1.10:4815" /></label>
      <label>用户名<input id="cfg-username" /></label>
      <label>密码<input id="cfg-password" type="password" /></label>
      <label>呼出热键<input id="cfg-hotkey" placeholder="super+shift+d" /></label>
      <button class="primary" id="btn-save-login" type="submit">保存并登录</button>
      <p class="hint">
        热键写法：<code>super+shift+d</code>、<code>super+shift+space</code>、<code>f9</code>…保存后立即生效。
        密码只用于换取登录令牌，不落盘；令牌存本机配置目录。
      </p>
    </form>

    <main class="results" id="results" hidden>
      <ul class="hits" id="hits"></ul>
      <div class="entry" id="entry"></div>
    </main>
  </div>
`

const input = element<HTMLInputElement>('word-input')
const hitsList = element<HTMLUListElement>('hits')
const entryHost = element('entry')
const statusBox = element('status')
const setupPanel = element('setup')
const resultsPane = element('results')
const hotkeyHint = element('hotkey-hint')

let settings: Settings = { server_url: '', username: '', hotkey: 'super+shift+d' }
let hits: Hit[] = []
let activeIndex = -1
let queryWord = ''
let entryFrame: EntryFrame | null = null

function showStatus(message: string, kind: 'info' | 'error' = 'info') {
  statusBox.textContent = message
  statusBox.className = `status ${kind}`
  statusBox.hidden = !message
}

function showSetup(visible: boolean) {
  setupPanel.hidden = !visible
  resultsPane.hidden = visible
  if (visible) element<HTMLInputElement>('cfg-server').value = settings.server_url
  if (visible) element<HTMLInputElement>('cfg-username').value = settings.username
  element<HTMLInputElement>('cfg-hotkey').value = settings.hotkey
  if (visible) element<HTMLInputElement>('cfg-server').focus()
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
  resultsPane.hidden = hits.length === 0
}

function escapeHtml(raw: string): string {
  return raw.replace(
    /[&<>"]/g,
    (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[ch] ?? ch,
  )
}

async function runSearch(next: string) {
  const trimmed = next.trim()
  if (!trimmed) return
  queryWord = trimmed
  input.value = trimmed
  showStatus('查询中…')
  try {
    hits = await api.search(trimmed)
    if (hits.length === 0) {
      activeIndex = -1
      renderHits()
      entryHost.innerHTML = ''
      showStatus(`没有找到「${trimmed}」`)
      return
    }
    showStatus('')
    activeIndex = 0
    renderHits()
    await selectHit(0)
  } catch (error) {
    hits = []
    renderHits()
    showStatus(String(error), 'error')
  }
}

async function selectHit(index: number) {
  const hit = hits[index]
  if (!hit) return
  activeIndex = index
  renderHits()
  showStatus('载入词条…')
  try {
    const html = await api.entryHtml(hit.dictionary_id, queryWord, [hit.id])
    entryFrame?.load(html)
    showStatus('')
  } catch (error) {
    showStatus(String(error), 'error')
  }
}

async function bootstrap() {
  settings = await api.getSettings()
  hotkeyHint.textContent = settings.hotkey ? `呼出：${settings.hotkey}` : ''
  const hotkeyProblem = await api.hotkeyError()
  if (hotkeyProblem) showStatus(hotkeyProblem, 'error')

  const status = await api.authStatus()
  if (!status.logged_in) {
    showSetup(true)
    return
  }
  showSetup(false)
  showStatus('')
  input.focus()
}

// —— 事件绑定 ——

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

element('btn-settings').addEventListener('click', () => {
  showSetup(setupPanel.hidden)
})

element('setup').addEventListener('submit', async (event) => {
  event.preventDefault()
  const server = element<HTMLInputElement>('cfg-server').value.trim()
  const username = element<HTMLInputElement>('cfg-username').value.trim()
  const password = element<HTMLInputElement>('cfg-password').value
  const hotkey = element<HTMLInputElement>('cfg-hotkey').value.trim() || 'super+shift+d'
  if (!server || !username || !password) {
    showStatus('服务器地址、用户名、密码都要填', 'error')
    return
  }
  try {
    settings.server_url = server
    settings.username = username
    await api.saveSettings({ ...settings, hotkey })
    settings.hotkey = hotkey
    hotkeyHint.textContent = `呼出：${hotkey}`
    const problem = await api.hotkeyError()
    await api.login(username, password)
    element<HTMLInputElement>('cfg-password').value = ''
    if (problem) showStatus(problem, 'error')
    else showStatus('')
    showSetup(false)
    input.focus()
    void runSearch(input.value)
  } catch (error) {
    showStatus(String(error), 'error')
  }
})

// 键盘：↑/↓ 选命中、Esc 收起（表单开着时先关表单）、输入框里也是同一套
document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape') {
    if (!setupPanel.hidden) {
      showSetup(false)
    } else {
      void api.hideWindow()
    }
    return
  }
  if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
    if (hits.length === 0) return
    event.preventDefault()
    const delta = event.key === 'ArrowDown' ? 1 : -1
    const next = (activeIndex + delta + hits.length) % hits.length
    void selectHit(next)
  }
})

/*
 * 失焦收起先不做（M2 再说）。
 *
 * 实测：X11 下 `show()` 会先给一次「失焦」（show/focus 的过渡），前端的失焦收起会立刻把
 * 刚呼出的窗口收掉；而这次 `hide()` 又落在映射过渡里被丢掉，结果是「窗口还在、记账说已隐藏」，
 * 下一次热键于是只做 hide——表现为**热键第二次之后完全没反应**。
 * 要做对，得由 Rust 侧在真正 show 之后给前端发一个「已显示」事件来复位守卫，M1 不背这个复杂度。
 */

// 词条区：接上 MyDict 的词条文档。baseUrl 传函数——设置页改完地址后下一次渲染即生效，
// 不必重建 frame（重建会丢掉正在显示的内容）。
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
  onAudioUnsupported: () => showStatus('这条发音放不了（词典里的音频格式或文件缺失）', 'error'),
})
entryHost.appendChild(entryFrame.element)

void bootstrap()
