import { api, type Settings } from './api'

/**
 * 设置模态窗（main / popup 两个窗口共用同一份实现）。
 *
 * 保存流程都在这里：落盘 → 热键注册失败的提示 → 密码非空则重新登录。
 * 窗口各自的差异通过 onSaved 回调表达（比如 popup 保存后要刷新语言标签）。
 */

export interface SettingsModal {
  element: HTMLDivElement
  open: () => void
  close: () => void
  isOpen: () => boolean
}

export interface SettingsModalOptions {
  /** 读当前设置（模态打开时回填表单） */
  getSettings: () => Settings
  /** 保存成功后的回调（设置已被落盘并应用到 Rust 侧） */
  onSaved: (next: Settings) => void
  /** 关闭后的回调（可选） */
  onClosed?: () => void
}

export function mountSettingsModal(options: SettingsModalOptions): SettingsModal {
  const mask = document.createElement('div')
  mask.className = 'modal-mask'
  mask.hidden = true
  mask.innerHTML = `
    <form class="modal-card" id="settings-form">
      <header class="modal-head">
        <h2>设置</h2>
        <button class="icon-btn" data-role="close" type="button" title="关闭">✕</button>
      </header>
      <div class="modal-body">
        <div class="field-group">
          <div class="group-label">服务器</div>
          <label><span>地址</span><input data-role="server" type="text" placeholder="http://192.168.1.10:4815" /></label>
        </div>
        <div class="field-group">
          <div class="group-label">账号</div>
          <label><span>用户名</span><input data-role="username" type="text" /></label>
          <label><span>密码</span><input data-role="password" type="password" placeholder="留空则只保存设置、不重新登录" /></label>
        </div>
        <div class="field-group">
          <div class="group-label">呼出热键</div>
          <label><span>组合键</span><input data-role="hotkey" type="text" placeholder="super+shift+d" /></label>
          <p class="hint">点击输入框后直接按下组合键即可录入；也可手写 super+shift+d、ctrl+alt+d、f9 等写法。保存后立即生效；被别的程序占用时会在这里报出来。</p>
        </div>
        <div class="field-group">
          <div class="group-label">行为</div>
          <label class="switch"><input type="checkbox" data-role="hide-blur" /><span>失焦自动收起（快捷搜索窗）</span></label>
          <label class="switch"><input type="checkbox" data-role="selection" /><span>划词优先：有选中文字时直接查它</span></label>
          <label class="switch"><input type="checkbox" data-role="clipboard" /><span>剪贴板监听：复制文字自动查（只认 ≤60 字的文本）</span></label>
        </div>
        <div class="field-group">
          <div class="group-label">翻译</div>
          <label><span>译成</span>
            <select data-role="translate-target">
              <option value="zh-Hans">简体中文</option>
              <option value="zh-Hant">繁體中文</option>
              <option value="en">English</option>
              <option value="ja">日本語</option>
              <option value="ko">한국어</option>
              <option value="fr">Français</option>
              <option value="de">Deutsch</option>
              <option value="es">Español</option>
              <option value="ru">Русский</option>
            </select>
          </label>
          <p class="hint">长句/长短语自动走翻译线路；目标语言与原文同语种时自动改译其它语言。</p>
        </div>
      </div>
      <footer class="modal-foot">
        <span class="status-inline" data-role="status"></span>
        <button class="primary" type="submit">保存</button>
      </footer>
    </form>
  `
  const field = <T extends HTMLElement>(role: string): T =>
    mask.querySelector(`[data-role="${role}"]`) as T
  const statusBox = field<HTMLSpanElement>('status')
  const setStatus = (message: string, kind: 'info' | 'error' = 'info') => {
    statusBox.textContent = message
    statusBox.className = `status-inline ${kind}`
  }

  const open = () => {
    const settings = options.getSettings()
    ;(field<HTMLInputElement>('server')).value = settings.server_url
    ;(field<HTMLInputElement>('username')).value = settings.username
    ;(field<HTMLInputElement>('hotkey')).value = settings.hotkey
    ;(field<HTMLInputElement>('hide-blur')).checked = settings.hide_on_blur
    ;(field<HTMLInputElement>('selection')).checked = settings.selection_first
    ;(field<HTMLInputElement>('clipboard')).checked = settings.clipboard_watch
    ;(field<HTMLSelectElement>('translate-target')).value = settings.translate_target_lang || 'zh-Hans'
    ;(field<HTMLInputElement>('password')).value = ''
    setStatus('')
    mask.hidden = false
    const server = field<HTMLInputElement>('server')
    const username = field<HTMLInputElement>('username')
    const target = !server.value ? server : !username.value ? username : server
    target.focus()
    target.select()
  }

  const close = () => {
    mask.hidden = true
    options.onClosed?.()
  }

  mask.addEventListener('mousedown', (event) => {
    if (event.target === mask) close()
  })
  mask.querySelector('[data-role="close"]')?.addEventListener('click', close)

  // 组合键录入：聚焦「组合键」输入框后直接按下组合键即可填入。用物理键位 e.code
  // 而不是 e.key——Windows 的中文输入法会把 keydown 的 key 改写成 'Process'，
  // 按 e.key 记录会拿到乱码（Windows 实测「无法正常设置热键」的原因）。
  const hotkeyInput = field<HTMLInputElement>('hotkey')
  const KEY_NAMES: Record<string, string> = {
    Space: 'space',
    Enter: 'enter',
    Tab: 'tab',
    Backspace: 'backspace',
    Delete: 'delete',
    Slash: 'slash',
    Backslash: 'backslash',
    Comma: 'comma',
    Period: 'period',
    Semicolon: 'semicolon',
    Quote: 'quote',
    Minus: 'minus',
    Equal: 'equal',
    BracketLeft: 'bracketleft',
    BracketRight: 'bracketright',
  }
  hotkeyInput.addEventListener('keydown', (event) => {
    const hasMods = event.ctrlKey || event.altKey || event.shiftKey || event.metaKey
    if (!hasMods) return // 无修饰键的按键放行：用户仍可手动输入写法
    const mods = [
      event.ctrlKey ? 'ctrl' : '',
      event.altKey ? 'alt' : '',
      event.shiftKey ? 'shift' : '',
      event.metaKey ? 'super' : '',
    ].filter(Boolean)
    const code = event.code
    let key: string | undefined = KEY_NAMES[code]
    if (code.startsWith('Key')) key = code.slice(3).toLowerCase()
    else if (code.startsWith('Digit')) key = code.slice(5)
    else if (/^F([1-9]|1[0-2])$/.test(code)) key = code.toLowerCase()
    if (!key) return // 方向键等暂不支持的主键：忽略，不覆盖已有写法
    event.preventDefault()
    event.stopPropagation()
    hotkeyInput.value = [...mods, key].join('+')
  })

  mask.addEventListener('submit', async (event) => {
    event.preventDefault()
    const server = field<HTMLInputElement>('server').value.trim()
    const username = field<HTMLInputElement>('username').value.trim()
    const password = field<HTMLInputElement>('password').value
    const hotkey = field<HTMLInputElement>('hotkey').value.trim() || 'super+shift+d'
    if (!server || !username) {
      setStatus('服务器地址与用户名都要填', 'error')
      return
    }
    const next: Settings = {
      ...options.getSettings(),
      server_url: server,
      username,
      hotkey,
      hide_on_blur: field<HTMLInputElement>('hide-blur').checked,
      selection_first: field<HTMLInputElement>('selection').checked,
      clipboard_watch: field<HTMLInputElement>('clipboard').checked,
      translate_target_lang: field<HTMLSelectElement>('translate-target').value || 'zh-Hans',
    }
    try {
      setStatus('保存中…')
      await api.saveSettings(next)
      options.onSaved(next)
      const hotkeyProblem = await api.hotkeyError()
      if (password) {
        setStatus('登录中…')
        await api.login(username, password)
        field<HTMLInputElement>('password').value = ''
      }
      if (hotkeyProblem) {
        setStatus(hotkeyProblem, 'error')
        return
      }
      setStatus(password ? '已保存并登录' : '已保存')
      setTimeout(close, 400)
    } catch (error) {
      setStatus(String(error), 'error')
    }
  })

  return { element: mask, open, close, isOpen: () => !mask.hidden }
}
