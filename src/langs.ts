/**
 * 词典语言分组——与网页版 `frontend/src/utils/language.ts` 同一套语义：
 * `zh / zh-Hans / zh-Hant` 都归成「中文」一组（查询路由本来就不区分简繁）。
 */

const LANG_GROUP_LABELS: Record<string, string> = {
  zh: '中文',
  en: '英文',
  ja: '日文',
  ko: '韩文',
  fr: '法文',
  de: '德文',
  ru: '俄文',
}

/** 中文系的全部 lang_from 取值（含早期数据里的裸 `zh`）。 */
const ZH_CODES = ['zh', 'zh-Hans', 'zh-Hant']

/** 把 lang_from 归到分组键；简繁都归成 `zh`。 */
export function langGroupOf(code: string | null | undefined): string {
  if (!code) return 'other'
  return ZH_CODES.includes(code) ? 'zh' : code
}

/** 分组键的显示名；表里没有的原样返回（配合计数仍可辨认）。 */
export function langGroupLabel(group: string): string {
  return LANG_GROUP_LABELS[group] ?? group
}
