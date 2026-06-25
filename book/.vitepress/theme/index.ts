import DefaultTheme from "vitepress/theme";
import "./custom.css";
import { setupMermaidZoom } from "./mermaidZoom";

export default {
  extends: DefaultTheme,
  setup() {
    // 仅在浏览器端启用：给所有 mermaid 图加「点击放大 + 滚轮缩放 + 拖拽平移」。
    setupMermaidZoom();
  },
};
