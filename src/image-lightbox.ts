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
   * 查看器开/关时回调（true=打开）。宿主用它把窗口铺满显示器：灯箱的遮罩是 fixed 铺满
   * **视口**，视口就是应用窗口——要铺满整个显示器只能把窗口本身拉到显示器大小。
   */
  onOpenChange?: (open: boolean) => void
  /** 窗口会铺满屏幕时传 true：遮罩的四角圆角会露出桌面，铺屏状态下要去掉。 */
  fullscreen?: boolean
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
  `
  overlay.hidden = true
  const img = overlay.querySelector('img') as HTMLImageElement
  const prevBtn = overlay.querySelector('.lightbox-nav-prev') as HTMLButtonElement
  const nextBtn = overlay.querySelector('.lightbox-nav-next') as HTMLButtonElement
  const hint = overlay.querySelector('.lightbox-hint') as HTMLParagraphElement

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

  function onPointerDown(event: PointerEvent): void {
    // 翻页按钮上的按下不能开拖：setPointerCapture 会把后续指针事件转给遮罩，
    // 那样按钮就收不到 click 了
    if (event.target !== overlay && event.target !== img) return
    dragging = true
    moved = 0
    pointerStartX = event.clientX
    pointerStartY = event.clientY
    offsetStartX = offsetX
    offsetStartY = offsetY
    ;(event.currentTarget as HTMLElement).setPointerCapture?.(event.pointerId)
  }

  function onPointerMove(event: PointerEvent): void {
    if (!dragging) return
    const dx = event.clientX - pointerStartX
    const dy = event.clientY - pointerStartY
    moved = Math.max(moved, Math.abs(dx) + Math.abs(dy))
    offsetX = offsetStartX + dx
    offsetY = offsetStartY + dy
    applyTransform()
  }

  function onPointerUp(): void {
    dragging = false
  }

  /** 只有点在图片以外的空白、且刚才没在拖动时才退出 */
  function onOverlayClick(event: MouseEvent): void {
    if (moved > DRAG_THRESHOLD) return
    if (event.target === overlay) close()
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
    hint.textContent = hasSiblings()
      ? `${index + 1} / ${images.length} · 滚轮缩放 · 拖动移动 · ← → 翻页 · Esc 或点空白处退出`
      : '滚轮缩放 · 拖动移动 · Esc 或点空白处退出'
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
    // 加载失败：藏起裂图占位，提示文字已经在兜底
    img.style.visibility = 'hidden'
    hint.textContent = '图片加载失败'
  })
  prevBtn.addEventListener('click', (event) => {
    event.stopPropagation()
    go(-1)
  })
  nextBtn.addEventListener('click', (event) => {
    event.stopPropagation()
    go(1)
  })
  // 捕获阶段挡住应用全局快捷键（见 onKeydown 的说明）
  window.addEventListener('keydown', onKeydown, true)

  function close(): void {
    overlay.hidden = true
    overlay.classList.remove('lightbox-full')
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
      overlay.classList.toggle('lightbox-full', !!options.fullscreen)
      open = true
      previousBodyOverflow = document.body.style.overflow
      document.body.style.overflow = 'hidden'
      options.onOpenChange?.(true)
      showAt(payload.index)
    },
    hide: close,
    isOpen: () => open,
  }
}
