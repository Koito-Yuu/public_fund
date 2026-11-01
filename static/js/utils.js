export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

export function safeUrl(value) {
  const url = String(value ?? "").trim();
  return /^https?:\/\//i.test(url) ? url : "#";
}

export function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

export function fmtNum(value, digits = 2) {
  if (value === null || value === undefined || Number.isNaN(Number(value))) return "—";
  return Number(value).toLocaleString("en-US", {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  });
}

export function fmtInt(value) {
  if (value === null || value === undefined || Number.isNaN(Number(value))) return "—";
  return Math.round(Number(value)).toLocaleString("en-US");
}

export function fmtPct(value, digits = 2, sign = true) {
  if (value === null || value === undefined || Number.isNaN(Number(value))) return "—";
  const n = Number(value);
  return `${sign && n > 0 ? "+" : ""}${n.toFixed(digits)}%`;
}

export function fmtYi(value, digits = 2) {
  if (value === null || value === undefined || Number.isNaN(Number(value))) return "—";
  const n = Number(value);
  if (Math.abs(n) >= 10000) return `${(n / 10000).toFixed(2)}万亿`;
  if (Math.abs(n) >= 100) return `${n.toFixed(1)}亿`;
  return `${n.toFixed(digits)}亿`;
}

export function fmtYuan(value, digits = 1) {
  if (value === null || value === undefined || Number.isNaN(Number(value))) return "—";
  return fmtYi(Number(value) / 1e8, digits);
}

export function fmtWan(value) {
  if (value === null || value === undefined || Number.isNaN(Number(value))) return "—";
  return fmtYi(Number(value) / 1e4, 2);
}

export function tone(value) {
  if (value === null || value === undefined || Number.isNaN(Number(value)) || Number(value) === 0) return "flat";
  return Number(value) > 0 ? "up" : "down";
}

export function deltaChip(value, digits = 1, suffix = "%") {
  if (value === null || value === undefined) return '<span class="dim">—</span>';
  const cls = tone(value);
  const arrow = value > 0 ? "▲" : value < 0 ? "▼" : "·";
  return `<span class="delta-chip ${cls}">${arrow} ${Math.abs(Number(value)).toFixed(digits)}${suffix}</span>`;
}

export function stars(rating) {
  const n = Math.round(Number(rating) || 0);
  if (!n) return '<span class="dim">—</span>';
  return `<span class="stars">${"★".repeat(Math.min(n, 5))}${"☆".repeat(Math.max(0, 5 - n))}</span>`;
}

export function debounce(fn, ms = 250) {
  let timer;
  return (...args) => {
    clearTimeout(timer);
    timer = setTimeout(() => fn(...args), ms);
  };
}

export function pnlClass(value) {
  return tone(value);
}

export function svgIcon(name, cls = "icon") {
  return `<svg class="${cls}"><use href="#i-${name}"/></svg>`;
}

export function toast(message, type = "") {
  const root = $("#toastRoot");
  if (!root) return;
  const node = document.createElement("div");
  node.className = `toast ${type}`;
  node.innerHTML = `${type === "error" ? svgIcon("warn") : ""}<span>${escapeHtml(message)}</span>`;
  root.appendChild(node);
  setTimeout(() => {
    node.style.opacity = "0";
    node.style.transform = "translateY(6px)";
    node.style.transition = "all .22s ease";
    setTimeout(() => node.remove(), 240);
  }, 3200);
}

export function openModal(title, html) {
  const root = $("#modalRoot");
  root.innerHTML = `
    <div class="modal-backdrop">
      <div class="modal-card">
        <div class="modal-head">
          <h3>${escapeHtml(title)}</h3>
          <button class="modal-close" aria-label="关闭">${svgIcon("close")}</button>
        </div>
        <div class="modal-body">${html}</div>
      </div>
    </div>`;
  const onKey = (event) => {
    if (event.key === "Escape") close();
  };
  const close = () => {
    root.innerHTML = "";
    document.removeEventListener("keydown", onKey);
  };
  root.querySelector(".modal-close").onclick = close;
  root.querySelector(".modal-backdrop").onclick = (event) => {
    if (event.target === event.currentTarget) close();
  };
  document.addEventListener("keydown", onKey);
  return close;
}

export function pageLoading(chart = true) {
  return `
    <div class="page-loading">
      <div class="sk-title skeleton"></div>
      <div class="sk-kpis">${'<div class="sk-kpi skeleton"></div>'.repeat(4)}</div>
      ${chart ? '<div class="sk-chart skeleton"></div>' : ""}
    </div>`;
}

export function errorBox(message) {
  return `<div class="card"><div class="card-body"><div class="error-box">${svgIcon("warn")} ${escapeHtml(message)}</div></div></div>`;
}

export function emptyState(message, hint = "") {
  return `<div class="empty">${svgIcon("layers")}<div>${escapeHtml(message)}</div>${hint ? `<div class="tiny mt-8">${escapeHtml(hint)}</div>` : ""}</div>`;
}

export function parseHashQuery(hash = location.hash) {
  const [, query = ""] = hash.split("?");
  return Object.fromEntries(new URLSearchParams(query));
}

export function fmtDate(value) {
  if (!value) return "—";
  return String(value).slice(0, 10);
}

export function quarterShort(q) {
  if (!q) return "—";
  return q.replace("Q", " Q");
}

export function clamp(value, min, max) {
  return Math.min(Math.max(value, min), max);
}

export function colorForIndex(index) {
  const colors = ["#4bd6c4", "#6392f2", "#e3b467", "#a98bf5", "#f2556a", "#22c08b", "#f08a5d", "#7cc4f5"];
  return colors[index % colors.length];
}

export function downloadText(filename, text, mime = "text/plain;charset=utf-8") {
  const blob = new Blob([text], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}
