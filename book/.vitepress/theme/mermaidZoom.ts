/*
 * 给页面里的 mermaid 图加交互：
 *  - 正文中按宽度自适应显示（保持原图、整洁）；
 *  - 点击图 → 弹出全屏遮罩，支持滚轮缩放、拖拽平移、+/−/复位按钮；
 *  - Esc 或点击遮罩空白处关闭。
 *
 * 实现要点：把原 .mermaid 容器临时「搬」进遮罩（用占位注释记住原位），
 * 关闭时再搬回 —— 避免克隆 SVG 导致的重复 id / 箭头 marker 失效问题。
 * svg-pan-zoom 仅在首次点击时按需动态加载。
 */

let panZoomLib: ((el: SVGElement, opts?: any) => any) | null = null;

async function loadPanZoom() {
  if (panZoomLib) return panZoomLib;
  const mod: any = await import("svg-pan-zoom");
  panZoomLib = (mod && mod.default) || mod;
  return panZoomLib!;
}

function openOverlay(container: HTMLElement) {
  const svg = container.querySelector("svg");
  if (!svg) return;

  // 记住原位置，关闭时搬回。
  const placeholder = document.createComment("mermaid-zoom-placeholder");
  container.parentNode?.insertBefore(placeholder, container);

  const overlay = document.createElement("div");
  overlay.className = "mermaid-zoom-overlay";

  const inner = document.createElement("div");
  inner.className = "mermaid-zoom-inner";

  const hint = document.createElement("div");
  hint.className = "mermaid-zoom-hint";
  hint.textContent = "滚轮缩放 · 拖拽平移 · Esc / 点击空白关闭";

  const closeBtn = document.createElement("button");
  closeBtn.className = "mermaid-zoom-close";
  closeBtn.setAttribute("aria-label", "关闭");
  closeBtn.textContent = "✕";

  inner.appendChild(container);
  overlay.appendChild(inner);
  overlay.appendChild(hint);
  overlay.appendChild(closeBtn);
  document.body.appendChild(overlay);
  document.documentElement.style.overflow = "hidden";

  // 让 SVG 填满遮罩内容区，便于 fit/center。
  const prevStyle = svg.getAttribute("style") || "";
  svg.style.maxWidth = "none";
  svg.style.width = "100%";
  svg.style.height = "100%";

  let instance: any = null;
  loadPanZoom()
    .then((spz) => {
      instance = spz(svg as unknown as SVGElement, {
        zoomEnabled: true,
        controlIconsEnabled: true,
        fit: true,
        center: true,
        minZoom: 0.2,
        maxZoom: 20,
        zoomScaleSensitivity: 0.4,
      });
    })
    .catch(() => {
      /* 加载失败则退化为静态全屏查看，不影响关闭 */
    });

  const close = () => {
    try {
      instance?.destroy();
    } catch {
      /* ignore */
    }
    svg.setAttribute("style", prevStyle);
    placeholder.parentNode?.insertBefore(container, placeholder);
    placeholder.remove();
    overlay.remove();
    document.documentElement.style.overflow = "";
    document.removeEventListener("keydown", onKey);
  };

  const onKey = (e: KeyboardEvent) => {
    if (e.key === "Escape") close();
  };

  document.addEventListener("keydown", onKey);
  overlay.addEventListener("click", (e) => {
    if (e.target === overlay) close();
  });
  closeBtn.addEventListener("click", close);
}

function enhance(container: HTMLElement) {
  if (container.dataset.zoomable) return;
  container.dataset.zoomable = "1";
  container.addEventListener("click", () => {
    // 已经在遮罩里则不重复打开。
    if (container.closest(".mermaid-zoom-overlay")) return;
    openOverlay(container);
  });
}

function scan() {
  document
    .querySelectorAll<HTMLElement>(".vp-doc .mermaid")
    .forEach((el) => enhance(el));
}

export function setupMermaidZoom() {
  if (typeof window === "undefined") return; // SSR 跳过

  const start = () => {
    scan();
    // mermaid 异步渲染 + SPA 路由切换都会增删 .mermaid 节点，用观察器统一兜住。
    const obs = new MutationObserver(() => scan());
    obs.observe(document.body, { childList: true, subtree: true });
  };

  if (document.readyState === "loading") {
    window.addEventListener("DOMContentLoaded", start);
  } else {
    start();
  }
}
