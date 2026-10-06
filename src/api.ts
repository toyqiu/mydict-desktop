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
  /** 翻译链路的默认目标语言（Edge 免 key 端点） */
  translate_target_lang: string
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
  /** Edge 免 key 翻译：texts 与返回译文顺序一一对应；from 传 null 即自动检测 */
  translate: (texts: string[], from: string | null, to: string) =>
    invoke<string[]>('translate', { texts, from, to }),
  /** 在线词典聚合（Wikipedia/Wiktionary/百度百科，服务端纯文本化）。403=功能未开启 */
  onlineLookup: (serverUrl: string, token: string | null, word: string, lang: string) =>
    invoke<unknown>('online_lookup', { serverUrl, token: token ?? null, word, lang }),
  /** 读系统剪贴板文本（失败给空串）：移动端「打开/回到前台时预填搜索框」用 */
  readClipboard: () => invoke<string>('clipboard_text').catch(() => ''),
  /** 取走「系统分享进来」的文本（取走即清）；没有则 null */
  takeSharedText: () => invoke<string | null>('take_shared_text').catch(() => null),
}
