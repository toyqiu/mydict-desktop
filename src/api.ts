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

/** `/api/dict/random` 的返回：随机挑中的一条词条 */
export interface RandomEntry {
  dictionary_id: number
  dictionary_name: string
  word: string
  entry_id: number
}

/** 生词本条目（`VocabItemOut`）：definition 是收藏时的快照，不是实时的 */
export interface VocabItem {
  id: number
  word: string
  phonetic: string | null
  definition: string | null
  note: string | null
  dictionary_id: number | null
  dictionary_name: string | null
  created_at: string
  due_at: string | null
  reps: number
  lapses: number
  last_review_at: string | null
  context_sentence: string | null
  context_match: string | null
  context_source: string | null
  context_url: string | null
}

export interface VocabCounts {
  total: number
  /** 未复习过的新词 */
  new: number
  /** 已到期待复习 */
  due: number
}

export interface VocabList {
  items: VocabItem[]
  total: number
  page: number
  page_size: number
}

export interface VocabDue {
  items: VocabItem[]
  counts: VocabCounts
}

export interface VocabReviewResult {
  item: VocabItem
  counts: VocabCounts
}

export interface VocabStats extends VocabCounts {
  learned: number
  reviewed_today: number
  scheduled_total: number
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
  /** 随机浏览：随机挑一条词条（可限定在当前语言标签的词典组内） */
  randomBrowse: (dictIds?: number[]) =>
    invoke<RandomEntry>('random_browse', { dictIds: dictIds ?? null }),
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
  /** 生词本列表（服务端 web 会话接口，与网页版同一份数据） */
  vocabList: (search: string | null, page = 1, pageSize = 50) =>
    invoke<VocabList>('vocab_list', { search, page, pageSize }),
  vocabStats: () => invoke<VocabStats>('vocab_stats'),
  /** 本次要复习的卡片：到期优先，不够用新词补 */
  vocabDue: (limit = 20, newLimit = 10) =>
    invoke<VocabDue>('vocab_due', { limit, newLimit }),
  /** 提交一次评分：1=重来 2=困难 3=记得 4=简单 */
  vocabReview: (itemId: number, rating: number, clientReviewId: string) =>
    invoke<VocabReviewResult>('vocab_review', { itemId, rating, clientReviewId }),
  /** 复习卡背面的词条 HTML（收藏时的快照） */
  vocabEntryHtml: (itemId: number, theme?: string) =>
    invoke<string>('vocab_entry_html', { itemId, theme: theme ?? null }),
  /** 取走「系统分享进来」的文本（取走即清）；没有则 null */
  takeSharedText: () => invoke<string | null>('take_shared_text').catch(() => null),
}
