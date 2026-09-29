/**
 * 词典主界面窗口的入口（窗口与页面的对应见 popup.html / vite.config 的多页输入）：
 * main 窗口 → index.html → 本文件 → ui-main；popup 窗口 → popup.html → popup.ts → ui-popup。
 *
 * 曾经用单页 + window.label 动态 import 分流——vite 会把动态分支的 CSS 拆成独立
 * chunk，其 <link> 在 tauri 的 asset 协议下不会注入（实测 popup 拿不到自己的样式表，
 * 手风琴整个瘪掉），所以改成多页入口、各加载各的。
 */
import './ui-main'
