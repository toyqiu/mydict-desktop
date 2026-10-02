/**
 * 翻译链路（与 MyDict 浏览器扩展 v0.2.0 的已验证实现同款语义）：
 *  - 线路判定：输入像句子/长短语 → 翻译；像单词 → 词典
 *  - 服务：Edge 免 key 接口（Rust 侧 `translate` 命令，无 CORS、UA 可控）
 *  - 会话缓存：LRU 200，同一文本第二次秒回
 *
 * 源语言粗猜 / 同语种纠偏 / provider 抽象均照扩展实现，坑都踩过（见各函数注释）。
 */

import { invoke } from '@tauri-apps/api/core'
import type { Settings } from './api'

/** 翻译伪标签的 value：不会与任何语言码冲突 */
export const TRANSLATE_TAB = '__translate__'

/**
 * 输入应走翻译还是词典？
 *  - 不含英文字母：长度 ≥ 6 → 翻译（「政府」「ペン」等短词仍查词典）
 *  - 含英文字母：英文单词数（空白分隔）≥ 3 → 翻译（单词/两词组仍查词典）
 */
export function isTranslateCandidate(text: string): boolean {
  const raw = (text ?? '').trim()
  if (raw.length < 6) return false
  if (!/[A-Za-z]/.test(raw)) return true
  const words = raw.split(/\s+/).filter((w) => /[A-Za-z]/.test(w))
  return words.length >= 3
}

/** 粗猜源语言：假名→ja、谚文→ko、西里尔→ru、希腊→el、汉字→zh、其余→en */
export function guessSourceLang(text: string): string {
  const raw = text ?? ''
  if (/[\u3040-\u30ff]/.test(raw)) return 'ja'
  if (/[\uac00-\ud7af]/.test(raw)) return 'ko'
  if (/[\u0400-\u04ff]/.test(raw)) return 'ru'
  if (/[\u0370-\u03ff]/.test(raw)) return 'el'
  if (/[\u4e00-\u9fff]/.test(raw)) return 'zh'
  return 'en'
}

/** 目标语言与源语言同语种时纠偏（译成自己没意义） */
export function effectiveTargetLang(text: string, setting: string): string {
  const source = guessSourceLang(text)
  const target = setting || 'zh-Hans'
  if (source === 'zh' && (target === 'zh-Hans' || target === 'zh-Hant')) return 'en'
  if (source !== 'zh' && target.startsWith(source)) return 'zh-Hans'
  return target
}

/* ---------------- provider 抽象（未来可插拔正式翻译服务） ---------------- */

export interface TranslationProvider {
  name: string
  /** 返回与 texts 顺序一一对应的译文数组 */
  translate(texts: string[], from: string, to: string): Promise<string[]>
}

const providers: Record<string, TranslationProvider> = {
  edge: {
    name: 'edge',
    translate: (texts, from, to) =>
      invoke<string[]>('translate', { texts, from: from || null, to }),
  },
}

let providerName = 'edge'

export function setTranslationProvider(name: string): void {
  if (providers[name]) providerName = name
}

/* ---------------- 会话缓存（LRU） ---------------- */

const cache = new Map<string, string>()
const CACHE_LIMIT = 200

export async function translateText(
  text: string,
  targetLang: string,
  exact = false,
): Promise<string> {
  const raw = (text ?? '').trim()
  if (!raw) return ''
  // exact=true：用户在弹窗下拉里显式选过目标语言，跳过同语种纠偏
  const to = exact ? targetLang : effectiveTargetLang(raw, targetLang)
  const key = `auto:${to}:${raw}`
  const hit = cache.get(key)
  if (hit !== undefined) {
    cache.delete(key)
    cache.set(key, hit)
    return hit
  }
  const [out] = await (providers[providerName] ?? providers.edge).translate([raw], 'auto', to)
  if (out === undefined) throw new Error('翻译服务返回了空结果')
  if (cache.size >= CACHE_LIMIT) {
    const oldest = cache.keys().next().value
    if (oldest !== undefined) cache.delete(oldest)
  }
  cache.set(key, out)
  return out
}

/* ---------------- 翻译视图（双窗格，popup / 主界面共用） ---------------- */

export const TRANSLATE_TARGET_OPTIONS: [string, string][] = [
  ['zh-Hans', '简体中文'],
  ['zh-Hant', '繁體中文'],
  ['en', 'English'],
  ['ja', '日本語'],
  ['ko', '한국어'],
  ['fr', 'Français'],
  ['de', 'Deutsch'],
  ['es', 'Español'],
  ['ru', 'Русский'],
]

export interface TranslateView {
  /** 换了要翻译的文本（同一窗口复用时）：重置为加载态并发起翻译 */
  translate(text: string): void
  element: HTMLElement
}

/**
 * 在 container 里渲染翻译视图：
 *   [译成 (下拉▾)]
 *   原文（弱化、pre-wrap）
 *   译文（loading / 失败 + 重试 / 译文）
 *
 * getTargetLang 返回设置里的默认目标语言；用户在下拉里显式改语言走 exact=true。
 * translateText 的失败按来源分档报错（网络 / HTTP 状态码），不笼统「翻译失败」。
 */
export function mountTranslateView(
  container: HTMLElement,
  options: {
    text: string
    getTargetLang: () => string
  },
): TranslateView {
  container.classList.add('trans-view')
  container.innerHTML = `
    <div class="trans-head">
      <label class="trans-target-label">译成
        <select class="trans-target">
          ${TRANSLATE_TARGET_OPTIONS.map(
            ([value, label]) =>
              `<option value="${value}">${label}</option>`,
          ).join('')}
        </select>
      </label>
    </div>
    <div class="trans-original"></div>
    <div class="trans-result"></div>
  `
  const originalBox = container.querySelector('.trans-original') as HTMLElement
  const resultBox = container.querySelector('.trans-result') as HTMLElement
  const select = container.querySelector('.trans-target') as HTMLSelectElement

  let currentText = ''
  // 请求序号：快速切换语言/文本时，迟到的旧响应不能覆盖新结果
  let seq = 0

  async function run(text: string, target: string, exact: boolean): Promise<void> {
    const mySeq = ++seq
    originalBox.textContent = text
    resultBox.innerHTML = '<span class="trans-loading">翻译中…</span>'
    try {
      const out = await translateText(text, target, exact)
      if (mySeq !== seq) return
      resultBox.textContent = out
    } catch (error) {
      if (mySeq !== seq) return
      const message = String(error)
      const reason = message.includes('HTTP')
        ? `翻译服务出错（${message}）`
        : message.includes('网络失败')
          ? message
          : `网络失败：${message}`
      resultBox.innerHTML = ''
      const text_ = document.createElement('span')
      text_.className = 'trans-error'
      text_.textContent = reason
      const retry = document.createElement('button')
      retry.type = 'button'
      retry.className = 'trans-retry'
      retry.textContent = '重试'
      retry.addEventListener('click', () => void run(text, target, exact))
      resultBox.append(text_, retry)
    }
  }

  function start(text: string): void {
    currentText = (text ?? '').trim()
    const target = select.value || options.getTargetLang() || 'zh-Hans'
    select.value = TRANSLATE_TARGET_OPTIONS.some(([v]) => v === target) ? target : 'zh-Hans'
    if (!currentText) return
    void run(currentText, select.value, false)
  }

  select.value = options.getTargetLang() || 'zh-Hans'
  select.addEventListener('change', () => {
    // 用户显式选择目标语言：exact=true 绕过同语种纠偏，
    // 否则选「简体中文」翻中文文本会被偷偷改成英文
    if (currentText) void run(currentText, select.value, true)
  })

  start(options.text)

  return {
    element: container,
    translate(text: string): void {
      start(text)
    },
  }
}

/** 设置里「译成」下拉的当前值（settings.translate_target_lang 缺省时兜底） */
export function defaultTargetLang(settings: Pick<Settings, 'translate_target_lang'>): string {
  return settings.translate_target_lang || 'zh-Hans'
}
