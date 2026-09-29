import { defineConfig } from 'vite'

// Tauri 约定：端口固定 + strictPort，devUrl 与 src-tauri/tauri.conf.json 保持一致；
// 不监听 src-tauri（Rust 侧由 tauri dev 自己看文件变化，重复重启没意义）。
export default defineConfig({
  clearScreen: false,
  server: {
    port: 1420,
    strictPort: true,
    watch: { ignored: ['**/src-tauri/**'] },
  },
  build: {
    target: 'es2021',
    sourcemap: true,
    rollupOptions: {
      // 多页输入：main 窗口用 index.html，popup 窗口用 popup.html——两个窗口各自的
      // js/css 打进各自的 chunk，谁也不会拿错样式
      input: {
        main: 'index.html',
        popup: 'popup.html',
      },
    },
  },
})
