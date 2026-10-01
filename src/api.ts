import { invoke } from '@tauri-apps/api/core'

export interface Hit {
  id: number
  dictionary_id: number
  dictionary_name: string
  word: string
  phonetic?: string | null
  /** 命中词典的源语言（zh-Hans/ja/…）：快捷搜索窗用它做语言标签分组 */
  lang_from?: string | null
  /** false = 该词典语言方向与输入不一致（服务端退到其它语言的兜底结果） */
  lang_match?: boolean
}

export interface Settings {
  server_url: string
  username: string
  hotkey: string
  /** dark（默认）| light */
  theme: string
  /** 失焦自动收起 */
  hide_on_blur: boolean
  /** 划词优先：有选中文字时直接查它，并以不抢焦点的方式展示 */
  selection_first: boolean
  /** 剪贴板监听：复制文字自动查（≤60 字） */
  clipboard_watch: boolean
}

export interface AuthStatus {
  logged_in: boolean
  username: string
  server_url: string
}

export interface DictInfo {
  id: number
  name: string
  lang_from: string
  lang_to: string
}

export const api = {
  getSettings: () => invoke<Settings>('get_settings'),
  saveSettings: (settings: Settings) => invoke<void>('save_settings', { settings }),
  hotkeyError: () => invoke<string | null>('hotkey_error'),
  authStatus: () => invoke<AuthStatus>('auth_status'),
  login: (username: string, password: string) => invoke<void>('login', { username, password }),
  logout: () => invoke<void>('logout'),
  /** 词典列表（scope=usable 当前可用）：语言标签行的数据源来自词典库 */
  dictionaries: (scope = 'usable') => invoke<DictInfo[]>('dictionaries', { scope }),
  search: (word: string, dictIds?: number[]) =>
    invoke<Hit[]>('search', { word, dictIds: dictIds ?? null }),
  entryHtml: (dictionaryId: number, word: string, entryIds: number[], theme?: string) =>
    invoke<string>('entry_html', { dictionaryId, word, entryIds, theme: theme ?? null }),
  hideWindow: () => invoke<void>('hide_window'),
  note: (tag: string) => invoke<void>('note', { tag }),
  focusProbe: () => invoke<string>('focus_probe'),
  openMain: () => invoke<void>('open_main'),
  openExternal: (url: string) => invoke<void>('open_external', { url }),
}
