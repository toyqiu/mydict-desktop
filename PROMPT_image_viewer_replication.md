# 复刻「词条图片点击展开 / 再点弹全屏查看器」实现 Prompt

> 背景项目：MyDict（FastAPI + Vue 词典服务，`/vol1/1000/docker/mydict-src`）。
> 词条以**自包含 HTML**渲染，由宿主（网页 / 桌面端 / 浏览器扩展）放进
> `<iframe sandbox="allow-scripts" srcdoc>` 里展示。沙箱是不透明源，iframe 与宿主
> 之间只靠 postMessage 通信，协议前缀 `mydict:`。
>
> 目标：在一部「图片带词典自带展开/收起交互」的词典（牛津高阶第 9/10 版实测，
> MDict 转制）里，实现——
> ① 点缩略图 → 词典自带 JS 原地展开类目大图（保留，不弹查看器）；
> ② 点**已展开的大图** → 拦掉词典的「缩回去」，改弹**全屏图片查看器**。

## 一、词典自带交互的 DOM 形态（第 10 版与第 9 版混用，同一词条可能两种并存）

第 10 版（oald10）：
```html
<div id="ox-enlarge" onclick="toggle_enlarger(this);">
  <a class="topic" title="">
    <img class="fullsize" style="display:none" src="/dict-res/{id}/res/fullsize_X.png">
    <img class="thumb" src="/dict-res/{id}/res/thumb_X.png">       <!-- 150×120 -->
    <span class="ox-enlarge-label">enlarge image</span>            <!-- 悬停放大镜角标 -->
  </a>
</div>
```
第 9 版：
```html
<div onclick='expand_big(this)' class='pic_thumb' idd="1">
  <img src="/dict-res/{id}/res/thumb_house.png">                   <!-- 可能 ≥160px -->
</div>
…
<div onclick='expand_thumb(this)' class='big_pic' idd="1">
  <img src="/dict-res/{id}/res/house_labels_comp.png">             <!-- 2276×2461 -->
</div>
```
配套词典 CSS 要点：`.fullsize/.big_pic` 默认 `display:none`；`.thumb` 固定小尺寸；
`.ox-enlarge-label` 是 24×24、SVG data-URI 背景的**悬停放大镜角标**（absolute 定位在
图右下角）。词典自带 JS（toggle_enlarger / expand_big / expand_thumb）挂在**容器
onclick** 上，做「缩略图 ⇄ 原图」切换。

## 二、点击分流算法（核心，注入词条文档的引导脚本，document 捕获阶段）

**血泪教训：不能依赖 `event.target` 是 `<img>`。** 合成 click（`dispatchEvent`）的
target 恰好是 img、测试全绿；**真实鼠标点击命中的是悬停浮层 / `<a>` / 伪元素宿主**，
target 是容器一类的元素。所以必须按容器识别：

```js
document.addEventListener('click', function (event) {
  var node = event.target;
  var anchorEl = findAnchor(event);                       // 向上找 <a>
  var href = anchorEl ? anchorEl.getAttribute('href') : null;

  // 1) 词典自管图片：向上找带 onclick 属性的词典容器
  if (node && node.closest && !href) {
    var ctl = dictClickContainer(node);                   // 最近带 onclick 属性的祖先
    var visibleImg = ctl ? visibleImageIn(ctl) : null;    // 容器里当前有布局盒的 img
    if (visibleImg) {
      if (isEnlargedTopicImage(ctl, visibleImg)) {
        // 展开态：词典 JS 只会缩回去 → 拦截，改弹查看器
        event.preventDefault();
        event.stopPropagation();                          // capture 阶段拦掉，容器 onclick 不再执行
        openImageInViewer(visibleImg);
        return;
      }
      return;                                             // 收起态：放行给词典 JS 原地展开
    }
    // 容器里没有显示着的图 → 落回通用逻辑
  }

  // 2) 通用大图：无链接包裹、渲染尺寸 ≥160px 的 <img> 直接弹查看器
  if (!href && node && node.tagName === 'IMG') {
    var box = node.getBoundingClientRect();
    if (box.width >= 160 || box.height >= 160) {
      event.preventDefault();
      openImageInViewer(node);
      return;
    }
  }
  // 3) 其余走原有链接逻辑（entry://、sound://、外链…）
}, true);
```

辅助函数：
```js
// 最近带 onclick 属性的祖先（含自身）
function dictClickContainer(el) {
  for (var p = el; p && p !== document; p = p.parentElement) {
    if (p.getAttribute && p.getAttribute('onclick')) return p;
  }
  return null;
}
// 容器里当前显示（getBoundingClientRect().width > 0）的 img；全隐藏返回 null
function visibleImageIn(container) { /* querySelectorAll('img') 逐个量宽 */ }
// 展开态判定：容器 class 含 big_pic（第 9 版），或可见图 class 含 fullsize（第 10 版）
function isEnlargedTopicImage(container, visibleImg) { /* 见上 */ }
```

弹查看器的消息（同一词条里所有 ≥160px 的图收集成 urls 一起给，可翻页；
点中的图不在表里就退化为单张）：
```js
send('image', { src: current, alt: clicked.alt || '', urls: urls, index: index });
// 父页监听 message，event.source === iframe.contentWindow 认证，type === 'mydict:image'
```

## 三、查看器（宿主侧）规格

- **全屏**：铺满整个视口/显示器。桌面端（Tauri）不要用 `set_fullscreen()`——
  xfwm4/xrdp 对无边框透明窗口跑 WM 全屏会把窗口弄丢；改为**新建专用无边框窗口**
  （置顶、铺满所在显示器，尺寸按 `scale_factor` 换算逻辑单位），词典窗口一行不动；
  关闭时销毁窗口。浏览器扩展则用 `position:fixed; inset:0; z-index:3000` 的遮罩层。
- 背景 `rgba(0,0,0,.86)`（或纯黑），图片 `position:absolute; transform-origin:0 0`。
- **适配与居中**：`fitScale = min(viewW/natW, viewH/natH)`，居中偏移
  `offset = (view - nat*fit)/2`。**必须在 window resize / ResizeObserver 时重新
  fit**（图片加载那一刻的视口不一定是最终视口），但用户手动缩放过
  （滚轮/拖动置 userAdjusted 标记）就不再自动重排；换页/新图由 img load 事件重新 fit。
- 交互：滚轮缩放（`scale *= exp(-deltaY*k)`，锚定光标：缩放前后光标下的图片坐标点
  不动）、拖动平移（位移 >4px 记为拖动，松手不算「点空白」）、←/→ 翻页（多图时）、
  Esc 或点图片以外空白退出。键盘监听放**捕获阶段**并 `stopImmediatePropagation`，
  防止宿主全局快捷键（如 Esc 收起窗口）抢走。
- 换页时更新「i / n · 滚轮缩放 · 拖动移动 · ←→ 翻页 · Esc 退出」提示。

## 四、验证方法（务必照做，别用合成事件下结论）

1. **合成 click 只能过冒烟**：`img.dispatchEvent(new MouseEvent('click',
   {bubbles:true}))` 能验证 JS 逻辑，但 target 恒为 img，覆盖不了真实命中路径。
2. **真机验证用真实鼠标事件**：Xvfb + WebKitGTK MiniBrowser（或无头 Chrome）加载
   同一份渲染文档，`xdotool mousemove x y click 1` 在缩略图、展开大图的实际坐标上
   各点一次，检查：a) 是否原地展开；b) 消息是否发出；c) 图是否被缩回去。
3. 小图与展开图两态各点一轮；两套 DOM 形态（ox-enlarge / pic_thumb+big_pic）各测。
4. 已知环境坑：WebKitGTK（软件渲染）下真实点击这批图可能崩掉整个进程
   （疑似悬停浮层 SVG 背景的绘制崩溃）；注入
   `.ox-enlarge-label{display:none!important;background-image:none!important}`
   后实测 3 连点存活。若宿主出现「应用静默消失」，优先怀疑这条。

## 五、MyDict 侧已落地的参考实现

- 引导脚本（点击分流 + 消息协议）：
  `mydict-src/backend/app/services/iframe_bootstrap.js`，提交 a04fb7c；
- 网页版查看器：`frontend/src/components/ImageLightbox.vue`（EntryFrame.vue 接
  `mydict:image`）；
- 桌面端（Tauri 专用窗口方案）：`mydict-desktop/src/ui-viewer.ts` + `viewer.html`
  + `src-tauri/src/main.rs` 的 `open_viewer/take_viewer_payload/close_viewer`
  （payload 经 Rust 暂存兜底「窗口新建早于页面监听」的竞态）。
