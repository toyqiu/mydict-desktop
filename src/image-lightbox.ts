/**
 * 词条图片查看器（幻灯片）——复刻网页版 components/ImageLightbox.vue 的交互：
 * 滚轮缩放（锚定光标）、拖动平移、←/→ 翻页、Esc 或点图片以外的空白退出。
 *
 * 起因是扫描版词典（辞海）——整页扫描图按容器宽度显示后多栏小字没法读，必须能放大平移。
 *
 * 事件处理与网页版同款：keydown 注册在**捕获阶段**并 stopImmediatePropagation，
 * 挡住应用自己的全局快捷键（Esc 收起窗口、↑/↓ 切换词条）——查看器开着时它们不该生效。
 */

export interface LightboxPayload {
  src: string
  alt?: string
  urls: string[]
  index: number
}

export interface LightboxMountOptions {
  /**
   * 查看器开/关时回调（true=打开）。宿主用它销毁/复用查看器窗口等。
   */
  onOpenChange?: (open: boolean) => void
}

export interface ImageLightbox {
  element: HTMLElement
  show(payload: LightboxPayload): void
  hide(): void
  isOpen(): boolean
}

// 单次滚轮的缩放步长系数；deltaY 的量级跨设备差异很大，用指数保证手感一致
const WHEEL_SENSITIVITY = 0.0015
// 相对「适应视口」的缩放上下限
const MIN_ZOOM = 0.5
const MAX_ZOOM = 20
// 超过这个位移才算拖动，否则松手时会被当成「点了空白处」而退出
const DRAG_THRESHOLD = 4

export function mountImageLightbox(options: LightboxMountOptions = {}): ImageLightbox {
  const overlay = document.createElement('div')
  overlay.className = 'lightbox'
  overlay.innerHTML = `
    <img class="lightbox-img" draggable="false" alt="" />
    <button type="button" class="lightbox-nav lightbox-nav-prev" title="上一张（←）">‹</button>
    <button type="button" class="lightbox-nav lightbox-nav-next" title="下一张（→）">›</button>
    <p class="lightbox-hint"></p>
    <button type="button" class="lightbox-bg-toggle"></button>
  `
  overlay.hidden = true
  const img = overlay.querySelector('img') as HTMLImageElement
  const prevBtn = overlay.querySelector('.lightbox-nav-prev') as HTMLButtonElement
  const nextBtn = overlay.querySelector('.lightbox-nav-next') as HTMLButtonElement
  const hint = overlay.querySelector('.lightbox-hint') as HTMLParagraphElement
  const bgBtn = overlay.querySelector('.lightbox-bg-toggle') as HTMLButtonElement

  // 背景明暗切换（桌面查看器 / 移动端页内灯箱共用）：
  // 默认**浅色**——黑色底会淹没深色图片/白底扫描件的内容（用户实测反馈）；
  // 深色照片类图片仍可一键切到深色。按钮自带半透明深色胶囊，两种背景下都清晰。
  const BG_LIGHT = '#f2f2f2'
  const BG_DARK = '#0a0a0a'
  let bgDark = false
  function applyBg(): void {
    overlay.style.background = bgDark ? BG_DARK : BG_LIGHT
    bgBtn.textContent = bgDark ? '☀ 浅色背景' : '🌙 深色背景'
  }
  applyBg()

  let images: string[] = []
  let index = 0
  let altText = ''
  let scale = 1
  let offsetX = 0
  let offsetY = 0
  let fitScale = 1
  let dragging = false
  let moved = 0
  let pointerStartX = 0
  let pointerStartY = 0
  let offsetStartX = 0
  let offsetStartY = 0
  let open = false
  let previousBodyOverflow = ''
  // 用户手动缩放/拖动过就不再自动重新适配——自动重排别覆盖用户的观察位置
  let userAdjusted = false

  const hasSiblings = (): boolean => images.length > 1

  function clampScale(next: number): number {
    const low = Math.max(fitScale * MIN_ZOOM, 0.01)
    return Math.min(Math.max(next, low), fitScale * MAX_ZOOM)
  }

  /** 让整张图完整可见，并居中 */
  function fitToViewport(): void {
    const naturalWidth = img.naturalWidth || 1
    const naturalHeight = img.naturalHeight || 1
    const viewWidth = overlay.clientWidth
    const viewHeight = overlay.clientHeight
    fitScale = Math.min(viewWidth / naturalWidth, viewHeight / naturalHeight)
    scale = fitScale
    offsetX = (viewWidth - naturalWidth * fitScale) / 2
    offsetY = (viewHeight - naturalHeight * fitScale) / 2
    applyTransform()
  }

  function applyTransform(): void {
    img.style.transform = `translate(${offsetX}px, ${offsetY}px) scale(${scale})`
  }

  /** 缩放时锚定光标：保持光标下方那个图片坐标点不动，放大时目标才不会跑出视口 */
  function onWheel(event: WheelEvent): void {
    event.preventDefault()
    userAdjusted = true
    const rect = overlay.getBoundingClientRect()
    const pointerX = event.clientX - rect.left
    const pointerY = event.clientY - rect.top
    const next = clampScale(scale * Math.exp(-event.deltaY * WHEEL_SENSITIVITY))
    const ratio = next / scale
    offsetX = pointerX - (pointerX - offsetX) * ratio
    offsetY = pointerY - (pointerY - offsetY) * ratio
    scale = next
    applyTransform()
  }

  // 多指（双指捏合）状态：手机上没有滚轮，缩放全靠捏合——锚定双指中点，与滚轮同一套公式
  const pointers = new Map<number, { x: number; y: number }>()
  let pinching = false
  let pinchStartDist = 1
  let pinchStartScale = 1
  let pinchStartOffsetX = 0
  let pinchStartOffsetY = 0

  function onPointerDown(event: PointerEvent): void {
    // 翻页按钮上的按下不能开拖：setPointerCapture 会把后续指针事件转给遮罩，
    // 那样按钮就收不到 click 了
    if (event.target !== overlay && event.target !== img) return
    pointers.set(event.pointerId, { x: event.clientX, y: event.clientY })
    ;(event.currentTarget as HTMLElement).setPointerCapture?.(event.pointerId)
    if (pointers.size === 2) {
      // 第二根手指落下：从「拖动」切成「捏合」，记下基准距离/缩放/偏移
      dragging = false
      pinching = true
      userAdjusted = true
      const [a, b] = [...pointers.values()]
      pinchStartDist = Math.hypot(b.x - a.x, b.y - a.y) || 1
      pinchStartScale = scale
      pinchStartOffsetX = offsetX
      pinchStartOffsetY = offsetY
      // 抬指时不能被当成「点了空白」而退出灯箱
      moved = DRAG_THRESHOLD + 1
      return
    }
    dragging = true
    moved = 0
    pointerStartX = event.clientX
    pointerStartY = event.clientY
    offsetStartX = offsetX
    offsetStartY = offsetY
  }

  function onPointerMove(event: PointerEvent): void {
    if (pointers.has(event.pointerId)) {
      pointers.set(event.pointerId, { x: event.clientX, y: event.clientY })
    }
    if (pinching && pointers.size >= 2) {
      const [a, b] = [...pointers.values()]
      const dist = Math.hypot(b.x - a.x, b.y - a.y) || 1
      const rect = overlay.getBoundingClientRect()
      const midX = (a.x + b.x) / 2 - rect.left
      const midY = (a.y + b.y) / 2 - rect.top
      const next = clampScale(pinchStartScale * (dist / pinchStartDist))
      const ratio = next / pinchStartScale
      // 锚定双指中点：中点下的那个图点保持不动（与滚轮缩放同一套公式）
      offsetX = midX - (midX - pinchStartOffsetX) * ratio
      offsetY = midY - (midY - pinchStartOffsetY) * ratio
      scale = next
      applyTransform()
      return
    }
    if (!dragging) return
    const dx = event.clientX - pointerStartX
    const dy = event.clientY - pointerStartY
    moved = Math.max(moved, Math.abs(dx) + Math.abs(dy))
    if (moved > DRAG_THRESHOLD) userAdjusted = true
    offsetX = offsetStartX + dx
    offsetY = offsetStartY + dy
    applyTransform()
  }

  function onPointerUp(event: PointerEvent): void {
    pointers.delete(event.pointerId)
    if (pointers.size < 2) pinching = false
    dragging = false
  }

  // 触屏/鼠标手势：**双击**在「适应视口」与 3 倍之间切换（以点击点为锚），**单击**关闭。
  // 单击关闭必须等一个「双击窗口」才能确定它不是双击的首击，所以关闭有约 280ms 延迟。
  const DOUBLE_TAP_MS = 280
  const DOUBLE_TAP_DIST = 48
  let lastTapAt = 0
  let lastTapX = 0
  let lastTapY = 0
  let tapTimer: number | undefined

  /** 双击缩放：未放大 → 以点击点为锚放大到适应视口的 3 倍；已放大 → 还原（居中适配） */
  function toggleDoubleTapZoom(clientX: number, clientY: number): void {
    userAdjusted = true
    if (scale > fitScale * 1.05) {
      fitToViewport()
      return
    }
    const rect = overlay.getBoundingClientRect()
    const px = clientX - rect.left
    const py = clientY - rect.top
    const target = clampScale(fitScale * 3)
    const ratio = target / scale
    // 锚定点击点：该点下的图保持不动（与滚轮/捏合同一套公式）
    offsetX = px - (px - offsetX) * ratio
    offsetY = py - (py - offsetY) * ratio
    scale = target
    applyTransform()
  }

  function onOverlayClick(event: MouseEvent): void {
    // 刚才是拖动或捏合，抬手不算点击
    if (moved > DRAG_THRESHOLD) return
    const now = Date.now()
    const near =
      Math.abs(event.clientX - lastTapX) < DOUBLE_TAP_DIST &&
      Math.abs(event.clientY - lastTapY) < DOUBLE_TAP_DIST
    const isDouble = now - lastTapAt <= DOUBLE_TAP_MS && near
    lastTapAt = now
    lastTapX = event.clientX
    lastTapY = event.clientY
    if (isDouble) {
      // 第二击：撤销待执行的「单击关闭」，改做双击缩放
      if (tapTimer !== undefined) {
        clearTimeout(tapTimer)
        tapTimer = undefined
      }
      toggleDoubleTapZoom(event.clientX, event.clientY)
      return
    }
    if (tapTimer !== undefined) clearTimeout(tapTimer)
    tapTimer = window.setTimeout(() => {
      tapTimer = undefined
      close()
    }, DOUBLE_TAP_MS)
  }

  function go(delta: number): void {
    if (!hasSiblings()) return
    const next = index + delta
    if (next < 0 || next >= images.length) return
    showAt(next)
  }

  /**
   * 挡住应用的全局快捷键（Esc 收起窗口、↑/↓ 切换词条）：应用在冒泡阶段监听 document，
   * 这里在捕获阶段监听同一处，stopImmediatePropagation 让事件不再往下走。
   */
  function onKeydown(event: KeyboardEvent): void {
    if (!open) return
    if (event.key === 'Escape') {
      event.preventDefault()
      event.stopImmediatePropagation()
      close()
      return
    }
    if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
      event.preventDefault()
      event.stopImmediatePropagation()
      go(event.key === 'ArrowLeft' ? -1 : 1)
    }
  }

  function render(): void {
    img.style.visibility = 'visible'
    img.src = images[index] ?? ''
    img.alt = altText
    prevBtn.hidden = !(hasSiblings() && index > 0)
    nextBtn.hidden = !(hasSiblings() && index < images.length - 1)
    // 图片下方那行操作提示不再显示（用户要求）；元素只留给「加载失败」兜底
    hint.textContent = ''
    hint.hidden = true
  }

  function showAt(next: number): void {
    index = Math.min(Math.max(next, 0), Math.max(images.length - 1, 0))
    render()
  }

  overlay.addEventListener('wheel', onWheel, { passive: false })
  overlay.addEventListener('pointerdown', onPointerDown)
  overlay.addEventListener('pointermove', onPointerMove)
  overlay.addEventListener('pointerup', onPointerUp)
  overlay.addEventListener('pointercancel', onPointerUp)
  overlay.addEventListener('click', onOverlayClick)
  img.addEventListener('load', () => fitToViewport())
  img.addEventListener('error', () => {
    // 加载失败：藏起裂图占位，这一条提示此时才显示
    img.style.visibility = 'hidden'
    hint.textContent = '图片加载失败'
    hint.hidden = false
  })
  prevBtn.addEventListener('click', (event) => {
    event.stopPropagation()
    go(-1)
  })
  nextBtn.addEventListener('click', (event) => {
    event.stopPropagation()
    go(1)
  })
  // 背景切换按钮：按下/点击都不能冒泡到遮罩（否则会被当成「点空白退出」）
  bgBtn.addEventListener('pointerdown', (event) => event.stopPropagation())
  bgBtn.addEventListener('click', (event) => {
    event.stopPropagation()
    bgDark = !bgDark
    applyBg()
  })
  // 捕获阶段挡住应用全局快捷键（见 onKeydown 的说明）
  window.addEventListener('keydown', onKeydown, true)

  // 视口尺寸变了（窗口创建后到位、显示器切换等）：图片加载那一刻的视口不一定
  // 是最终视口，不重算的话「适应视口」就是按旧尺寸算的——图片既不居中也不够大。
  function refitIfUntouched(): void {
    if (!open || userAdjusted) return
    // 图还没解码完时 naturalWidth 是 0，fitToViewport 会按 1×1 算出离谱的缩放；
    // 加载完 load 事件自己会适配
    if (!img.complete || !img.naturalWidth) return
    fitToViewport()
  }
  window.addEventListener('resize', refitIfUntouched)
  // 窗口里没有别的布局源，ResizeObserver 兜住 window resize 覆盖不到的场景（如缩放后
  // 才挂载到 DOM）
  if (typeof ResizeObserver !== 'undefined') {
    new ResizeObserver(refitIfUntouched).observe(document.documentElement)
  }

  function close(): void {
    // 有挂起的「单击关闭」就撤销（例如双击的第二击已把它取消，或外部直接关灯箱）
    if (tapTimer !== undefined) {
      clearTimeout(tapTimer)
      tapTimer = undefined
    }
    overlay.hidden = true
    open = false
    document.body.style.overflow = previousBodyOverflow
    options.onOpenChange?.(false)
  }

  return {
    element: overlay,
    show(payload: LightboxPayload): void {
      images = payload.urls.length ? payload.urls : [payload.src]
      altText = payload.alt ?? ''
      overlay.hidden = false
      open = true
      userAdjusted = false
      // 新开一次灯箱：清掉上一次遗留的点击计时，避免首击被当成「双击的第二击」
      lastTapAt = 0
      if (tapTimer !== undefined) {
        clearTimeout(tapTimer)
        tapTimer = undefined
      }
      previousBodyOverflow = document.body.style.overflow
      document.body.style.overflow = 'hidden'
      options.onOpenChange?.(true)
      showAt(payload.index)
    },
    hide: close,
    isOpen: () => open,
  }
}
