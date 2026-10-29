/**
 * 生词本 + 复习（主窗口的「生词本」伪标签）。
 *
 * 数据全部走服务端 web 会话接口（`/api/vocab*`，经 Rust 侧 `vocab_*` 命令转发），
 * 与网页版是同一份生词本；调度算法只在服务端跑，这里只负责「取卡 → 翻面 → 报评分」。
 *
 * 背面复用 `EntryFrame` 渲染收藏时的词条快照，和查词页同一套排版；正面在能挖空时
 * 显示原句，否则退回裸词卡（老生词、桌面端手动收藏都没有语境）。
 */

import { api, type VocabCounts, type VocabItem } from './api'
import { createEntryFrame, type EntryFrame } from './entry-frame'

/** 生词本伪标签值，与「在线」「随机」「翻译」同一套机制 */
export const VOCAB_TAB = '__vocab__'

export interface VocabViewOptions {
  /** 服务器根地址：词条快照里的 /dict-res/… 是根相对路径，iframe 要靠 <base> 指回服务端 */
  baseUrl: () => string
  theme: () => string
  onEntry: (word: string) => void
  onExternal: (url: string) => void
  onHide: () => void
  onStatus: (message: string, kind?: 'info' | 'error') => void
}

export interface VocabView {
  element: HTMLElement
  /** 切到生词本标签时调用：拉统计 + 列表 */
  enter: () => void
  /** 设置变更（登录态/主题）后重新拉一次 */
  refresh: () => void
}

const RATING_LABEL: Record<number, string> = {
  1: '重来',
  2: '困难',
  3: '记得',
  4: '简单',
}

function escapeHtml(raw: string): string {
  return raw.replace(/[&<>"]/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[ch] ?? ch)
}

/** 与网页版同一套边界规则：拉丁词两侧不能粘字母数字，CJK 直接匹配 */
const WORD_CHAR = /[\p{L}\p{N}]/u
const CJK_CHAR = /[\u3400-\u9FFF\u3040-\u30FF\uAC00-\uD7AF]/

function findWordAt(sentence: string, form: string): { at: number; text: string } | null {
  if (CJK_CHAR.test(form)) {
    const at = sentence.indexOf(form)
    return at < 0 ? null : { at, text: form }
  }
  const escaped = form.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const pattern = new RegExp(escaped, 'gi')
  for (let match = pattern.exec(sentence); match; match = pattern.exec(sentence)) {
    const before = sentence[match.index - 1]
    const after = sentence[match.index + match[0].length]
    const leftOk = !before || !WORD_CHAR.test(before)
    const rightOk = !after || !WORD_CHAR.test(after)
    if (leftOk && rightOk) return { at: match.index, text: match[0] }
    if (pattern.lastIndex === match.index) pattern.lastIndex += 1
  }
  return null
}

interface Cloze {
  before: string
  match: string
  after: string
}

function buildCloze(item: VocabItem): Cloze | null {
  const sentence = item.context_sentence?.trim()
  if (!sentence) return null
  const word = item.word
  const forms = [item.context_match, word, `${word}s`, `${word}es`, `${word}ed`, `${word}d`, `${word}ing`]
    .filter((value): value is string => Boolean(value && value.trim()))
    .sort((a, b) => b.length - a.length)
  for (const form of forms) {
    const hit = findWordAt(sentence, form)
    if (hit) {
      return {
        before: sentence.slice(0, hit.at),
        match: hit.text,
        after: sentence.slice(hit.at + hit.text.length),
      }
    }
  }
  return null
}

function badgeOf(item: VocabItem): string {
  if (item.reps === 0) return '新词'
  if (!item.due_at) return '已学'
  return '待复习'
}

function reviewId(): string {
  // 每次提交一个新 id：服务端据此幂等，重试同一张卡不会被计两次
  return `desk-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
}

export function mountVocabView(options: VocabViewOptions): VocabView {
  const host = document.createElement('div')
  host.className = 'vocab-host'
  host.hidden = true
  host.innerHTML = `
    <div class="vocab-top">
      <div class="vocab-summary">
        <span class="vocab-name">生词本</span>
        <span class="vocab-meta" data-role="meta"></span>
      </div>
      <div class="vocab-tools">
        <input class="vocab-search" data-role="search" type="search" placeholder="搜索生词" autocomplete="off" />
        <button class="primary" type="button" data-role="start">开始复习</button>
      </div>
    </div>
    <div class="vocab-scroll" data-role="scroll">
      <ul class="vocab-rows" data-role="rows"></ul>
      <p class="vocab-empty" data-role="empty" hidden></p>
    </div>
    <div class="vocab-review" data-role="review" hidden></div>
  `

  const top = host.querySelector<HTMLElement>('.vocab-top')!
  const meta = host.querySelector<HTMLElement>('[data-role="meta"]')!
  const searchInput = host.querySelector<HTMLInputElement>('[data-role="search"]')!
  const startBtn = host.querySelector<HTMLButtonElement>('[data-role="start"]')!
  const scroll = host.querySelector<HTMLElement>('[data-role="scroll"]')!
  const rows = host.querySelector<HTMLUListElement>('[data-role="rows"]')!
  const empty = host.querySelector<HTMLElement>('[data-role="empty"]')!
  const reviewHost = host.querySelector<HTMLElement>('[data-role="review"]')!

  let counts: VocabCounts = { total: 0, new: 0, due: 0 }
  let list: VocabItem[] = []
  let queue: VocabItem[] = []
  let reviewing = false
  let revealed = false
  let busy = false
  let reviewed = 0
  let searchTimer: ReturnType<typeof setTimeout> | undefined
  // 同一张卡的提交 id 要稳定：超时重试若换新 id，服务端幂等就失效、复习会被计两次
  const reviewIds = new Map<number, string>()
  let answerFrame: EntryFrame | null = null

  function setMeta(text: string): void {
    meta.textContent = text
  }

  function renderList(): void {
    const keyword = searchInput.value.trim()
    setMeta(
      keyword
        ? `搜索「${keyword}」· 共 ${counts.total} 条`
        : `到期 ${counts.due} · 新词 ${counts.new} · 共 ${counts.total} 条`,
    )
    startBtn.textContent = counts.due + counts.new > 0 ? `开始复习 ${counts.due + counts.new}` : '开始复习'
    startBtn.disabled = counts.due + counts.new === 0

    empty.hidden = list.length > 0
    if (list.length === 0) {
      empty.textContent = keyword ? '没有匹配的生词' : '生词本还是空的，在网页或扩展里收藏几个词吧'
    }
    rows.innerHTML = list
      .map(
        (item) => `
        <li class="vocab-row" data-id="${item.id}" data-word="${escapeHtml(item.word)}">
          <span class="vocab-word">${escapeHtml(item.word)}</span>
          <span class="vocab-dict">${escapeHtml(item.dictionary_name ?? '')}</span>
          <span class="vocab-badge${item.reps === 0 ? ' is-new' : ''}">${badgeOf(item)}</span>
        </li>`,
      )
      .join('')
  }

  async function refresh(): Promise<void> {
    try {
      const [stats, page] = await Promise.all([
        api.vocabStats(),
        api.vocabList(searchInput.value.trim() || null, 1, 100),
      ])
      counts = { total: stats.total, new: stats.new, due: stats.due }
      list = page.items
      if (!reviewing) renderList()
    } catch (error) {
      setMeta(`生词本加载失败：${String(error)}`)
    }
  }

  /* ---------------- 复习 ---------------- */

  function ensureAnswerFrame(): EntryFrame {
    if (!answerFrame) {
      answerFrame = createEntryFrame({
        baseUrl: options.baseUrl,
        theme: options.theme,
        onEntry: (word) => {
          exitReview()
          options.onEntry(word)
        },
        onExternal: (url) => {
          if (url) options.onExternal(url)
        },
        onEscape: () => options.onHide(),
        onAudioUnsupported: () => options.onStatus('这条发音放不了（词典里的音频格式或文件缺失）', 'error'),
        onHeight: (height) => {
          if (answerFrame && height > 0) answerFrame.element.style.height = `${height}px`
        },
      })
    }
    return answerFrame
  }

  function current(): VocabItem | null {
    return queue[0] ?? null
  }

  function renderReview(): void {
    const item = current()
    if (!item) {
      renderDone()
      return
    }
    const cloze = buildCloze(item)
    const front = cloze
      ? `<p class="review-cloze">${escapeHtml(cloze.before)}<span class="review-blank">____</span>${escapeHtml(cloze.after)}</p>
         <div class="review-source">—— ${escapeHtml(item.context_source ?? '收藏时的原句')}</div>`
      : `<div class="review-word">${escapeHtml(item.word)}</div>
         ${item.phonetic ? `<div class="review-phonetic">${escapeHtml(item.phonetic)}</div>` : ''}
         <div class="review-source">${escapeHtml(item.dictionary_name ?? '')}</div>`

    reviewHost.innerHTML = `
      <div class="review-progress"><span style="width:${reviewed + queue.length === 0 ? 0 : Math.round((reviewed / (reviewed + queue.length)) * 100)}%"></span></div>
      <section class="review-card">
        <div class="review-front">${front}</div>
        <div class="review-answer" data-role="answer" ${revealed ? '' : 'hidden'}></div>
      </section>
      <div class="review-actions" data-role="actions"></div>
      <div class="review-foot">
        <span>本次已复习 ${reviewed} 条</span>
        <button type="button" class="link-btn" data-role="quit">结束复习</button>
      </div>
    `

    const actions = reviewHost.querySelector<HTMLElement>('[data-role="actions"]')!
    if (revealed) {
      actions.innerHTML = [1, 2, 3, 4]
        .map(
          (rating) =>
            `<button type="button" class="rate-btn rate-${rating}" data-rating="${rating}"${busy ? ' disabled' : ''}>
               <span class="rate-key">${rating}</span>${RATING_LABEL[rating]}
             </button>`,
        )
        .join('')
    } else {
      actions.innerHTML =
        '<button type="button" class="primary" data-role="show">显示答案<span class="key-hint">（空格）</span></button>'
    }

    reviewHost.querySelector('[data-role="quit"]')?.addEventListener('click', () => exitReview())
    // 触屏没有空格键：点卡片正面翻面
    if (!revealed) {
      reviewHost.querySelector('.review-front')?.addEventListener('click', () => reveal())
    }
    reviewHost.querySelector<HTMLButtonElement>('[data-role="show"]')?.addEventListener('click', () => reveal())
    reviewHost.querySelectorAll<HTMLButtonElement>('button[data-rating]').forEach((btn) => {
      btn.addEventListener('click', () => void rate(Number(btn.dataset.rating)))
    })

    if (revealed) mountAnswer(item)
  }

  function mountAnswer(item: VocabItem): void {
    const holder = reviewHost.querySelector<HTMLElement>('[data-role="answer"]')
    if (!holder) return
    if (!item.definition) {
      holder.innerHTML = '<p class="review-muted">（收藏时没有取到释义，可回到列表重新收藏）</p>'
      return
    }
    const frame = ensureAnswerFrame()
    holder.replaceChildren(frame.element)
    frame.element.style.height = '160px'
    void api
      .vocabEntryHtml(item.id, options.theme())
      .then((html) => frame.load(html))
      .catch((error) => options.onStatus(`取释义失败：${String(error)}`, 'error'))
  }

  function reveal(): void {
    if (!current() || revealed) return
    revealed = true
    renderReview()
  }

  async function rate(rating: number): Promise<void> {
    const item = current()
    if (!item || !revealed || busy) return
    busy = true
    try {
      let submitId = reviewIds.get(item.id)
      if (!submitId) {
        submitId = reviewId()
        reviewIds.set(item.id, submitId)
      }
      const result = await api.vocabReview(item.id, rating, submitId)
      reviewIds.delete(item.id)
      counts = result.counts
      reviewed += 1
      queue.shift()
      revealed = false
      if (queue.length === 0) {
        const next = await api.vocabDue()
        queue = next.items
        counts = next.counts
      }
    } catch (error) {
      options.onStatus(`提交失败：${String(error)}`, 'error')
    } finally {
      busy = false
      if (reviewing) renderReview()
    }
  }

  function renderDone(): void {
    reviewing = false
    rows.hidden = true
    empty.hidden = true
    scroll.hidden = true
    reviewHost.hidden = false
    reviewHost.innerHTML = `
      <section class="review-card review-done">
        <h3>${reviewed > 0 ? '这一轮复习完了' : '现在没有到期的卡片'}</h3>
        <p>本次复习 <strong>${reviewed}</strong> 条${counts.due + counts.new > 0 ? `，还有 ${counts.due + counts.new} 条可以继续` : ''}。</p>
        <div class="review-actions">
          ${counts.due + counts.new > 0 ? '<button type="button" class="primary" data-role="again">再来一轮</button>' : ''}
          <button type="button" class="link-btn" data-role="quit">返回列表</button>
        </div>
      </section>
    `
    reviewHost.querySelector('[data-role="again"]')?.addEventListener('click', () => void startReview())
    reviewHost.querySelector('[data-role="quit"]')?.addEventListener('click', () => exitReview())
    // 触屏没有空格键：点卡片正面翻面
    if (!revealed) {
      reviewHost.querySelector('.review-front')?.addEventListener('click', () => reveal())
    }
    void refresh()
  }

  async function startReview(): Promise<void> {
    try {
      const due = await api.vocabDue()
      counts = due.counts
      queue = due.items
      reviewed = 0
      revealed = false
      reviewing = true
      // 复习时收起列表头（标题/统计/搜索框），别让它们占着版面
      top.hidden = true
      rows.hidden = true
      empty.hidden = true
      scroll.hidden = true
      reviewHost.hidden = false
      renderReview()
    } catch (error) {
      options.onStatus(`取复习卡片失败：${String(error)}`, 'error')
    }
  }

  function exitReview(): void {
    reviewing = false
    revealed = false
    queue = []
    reviewHost.hidden = true
    reviewHost.innerHTML = ''
    top.hidden = false
    scroll.hidden = false
    rows.hidden = false
    void refresh()
  }

  /* ---------------- 事件 ---------------- */

  startBtn.addEventListener('click', () => void startReview())
  searchInput.addEventListener('input', () => {
    clearTimeout(searchTimer)
    searchTimer = setTimeout(() => void refresh(), 300)
  })
  rows.addEventListener('click', (event) => {
    const row = (event.target as HTMLElement).closest<HTMLLIElement>('li.vocab-row')
    if (!row) return
    const word = row.dataset.word
    if (word) options.onEntry(word)
  })

  /**
   * 复习态要独占键盘：主窗口的 ←/→ 会切标签、Esc 会收起窗口，正在看卡时这些都
   * 会把用户踢出复习。用捕获阶段拦下并阻止冒泡。
   */
  document.addEventListener(
    'keydown',
    (event) => {
      if (!reviewing || host.hidden) return
      if (event.key === 'Escape') {
        event.stopPropagation()
        exitReview()
        return
      }
      if (event.code === 'Space' || event.key === 'Enter') {
        event.preventDefault()
        event.stopPropagation()
        reveal()
        return
      }
      if (['1', '2', '3', '4'].includes(event.key)) {
        event.preventDefault()
        event.stopPropagation()
        void rate(Number(event.key))
        return
      }
      if (event.key.startsWith('Arrow')) event.stopPropagation()
    },
    true,
  )

  return {
    element: host,
    enter: () => {
      host.hidden = false
      void refresh()
    },
    refresh: () => void refresh(),
  }
}
