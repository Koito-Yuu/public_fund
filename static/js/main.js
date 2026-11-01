import { api } from "./api.js";
import { disposeCharts, resizeCharts } from "./charts.js";
import { addRecent, getLastQuarter, setLastQuarter } from "./store.js";
import { $, $$, debounce, escapeHtml, parseHashQuery, svgIcon } from "./utils.js";
import { render as marketView } from "./views/market.js";
import { render as screenerView } from "./views/screener.js";
import { render as fundsView } from "./views/funds.js";
import { render as fundView } from "./views/fund.js";
import { render as managersView } from "./views/managers.js";
import { render as portfolioView } from "./views/portfolio.js";
import { render as stocksView } from "./views/stocks.js";
import { render as aboutView } from "./views/about.js";

export const appState = { meta: null };

const routes = [
  { test: /^\/?$/, view: marketView, nav: "market", crumb: "市场全景", title: "市场全景" },
  { test: /^\/market$/, view: marketView, nav: "market", crumb: "市场全景", title: "市场全景" },
  { test: /^\/screener$/, view: screenerView, nav: "screener", crumb: "基金筛选", title: "基金筛选" },
  { test: /^\/funds$/, view: fundsView, nav: "funds", crumb: "基金档案", title: "基金档案" },
  { test: /^\/fund\/\d{6}$/, view: fundView, nav: "funds", crumb: "基金档案 / 基金详情", title: "基金详情" },
  { test: /^\/fund(?:\/.*)?$/, view: fundView, nav: "funds", crumb: "基金档案 / 基金详情", title: "基金详情" },
  { test: /^\/managers$/, view: managersView, nav: "managers", crumb: "基金经理", title: "基金经理" },
  { test: /^\/portfolio$/, view: portfolioView, nav: "portfolio", crumb: "组合工坊", title: "组合工坊" },
  { test: /^\/stocks$/, view: stocksView, nav: "stocks", crumb: "重仓股透视", title: "重仓股透视" },
  { test: /^\/about$/, view: aboutView, nav: "about", crumb: "数据与方法", title: "数据与方法" },
];

let renderToken = 0;

function currentRoute() {
  const raw = location.hash.replace(/^#/, "") || "/market";
  const [path] = raw.split("?");
  const route = routes.find((item) => item.test.test(path));
  return { route: route || routes[1], path, params: parseHashQuery(location.hash) };
}

function setActiveNav(nav) {
  $$("#nav a, .nav a[data-nav]").forEach((link) => {
    link.classList.toggle("active", link.dataset.nav === nav);
  });
}

let closeSearch = () => {};

export async function navigate(hash) {
  if (location.hash === hash) {
    await renderRoute();
  } else {
    location.hash = hash;
  }
}

async function renderRoute() {
  const token = ++renderToken;
  const { route, params } = currentRoute();
  disposeCharts();
  closeSearch();
  setActiveNav(route.nav);
  $("#crumb").textContent = route.crumb;
  document.title = `${route.title} · FundScope`;
  const previous = $("#view");
  const view = previous ? previous.cloneNode(false) : document.createElement("main");
  view.id = "view";
  if (previous) previous.replaceWith(view);
  else $("#view-root")?.appendChild(view);
  window.scrollTo({ top: 0, behavior: "instant" });
  try {
    await route.view(view, params, appState);
  } catch (error) {
    if (token !== renderToken) return;
    view.innerHTML = `<div class="card"><div class="card-body"><div class="error-box">${escapeHtml(error.message || "页面加载失败")}</div></div></div>`;
  }
  if (token !== renderToken) return;
  setActiveNav(route.nav);
  resizeCharts();
}

/* ------------------------------------------------------------- search --- */
function setupSearch() {
  const input = $("#globalSearch");
  const panel = $("#searchPanel");
  let results = null;
  let activeIndex = -1;
  let searchRequest = 0;

  closeSearch = () => {
    searchRequest += 1;
    results = null;
    input.value = "";
    panel.classList.remove("open");
    input.blur();
  };

  const renderPanel = () => {
    if (!results) return;
    const { funds = [], stocks = [] } = results;
    if (!funds.length && !stocks.length) {
      panel.innerHTML = '<div class="search-empty">没有找到匹配的基金或重仓股</div>';
      panel.classList.add("open");
      return;
    }
    let html = "";
    if (funds.length) {
      html += '<div class="search-group">基金</div>';
      funds.forEach((fund, index) => {
        html += `<div class="search-item" data-kind="fund" data-code="${fund.code}" data-index="${index}">
          <div class="si-main"><div class="si-name">${escapeHtml(fund.name)}</div>
          <div class="si-meta">${escapeHtml(fund.code)} · ${escapeHtml(fund.type || "基金")}${fund.r1y !== null && fund.r1y !== undefined ? ` · 近1年 ${fund.r1y > 0 ? "+" : ""}${fund.r1y}%` : ""}</div></div>
          <span class="si-tag">基金</span>
        </div>`;
      });
    }
    if (stocks.length) {
      html += '<div class="search-group">重仓股</div>';
      stocks.forEach((stock, index) => {
        html += `<div class="search-item" data-kind="stock" data-code="${stock.code}" data-index="${index}">
          <div class="si-main"><div class="si-name">${escapeHtml(stock.name)}</div>
          <div class="si-meta">${escapeHtml(stock.code)} · ${escapeHtml(stock.industry || "—")} · ${stock.fund_count ?? "—"} 只基金持有</div></div>
          <span class="si-tag">股票</span>
        </div>`;
      });
    }
    panel.innerHTML = html;
    panel.classList.add("open");
    activeIndex = -1;
  };

  const doSearch = debounce(async () => {
    const query = input.value.trim();
    const current = ++searchRequest;
    if (!query) {
      panel.classList.remove("open");
      results = null;
      return;
    }
    panel.innerHTML = '<div class="search-empty">搜索中…</div>';
    panel.classList.add("open");
    try {
      const data = await api.search(query);
      if (current !== searchRequest || input.value.trim() !== query || !panel.isConnected) return;
      results = data;
      renderPanel();
    } catch (error) {
      if (current !== searchRequest || input.value.trim() !== query || !panel.isConnected) return;
      panel.innerHTML = `<div class="search-empty">${escapeHtml(error.message)}</div>`;
    }
  }, 260);

  input.addEventListener("input", doSearch);
  input.addEventListener("focus", () => {
    if (results && input.value.trim()) panel.classList.add("open");
  });

  panel.addEventListener("mousedown", (event) => {
    const item = event.target.closest(".search-item");
    if (!item) return;
    event.preventDefault();
    const code = item.dataset.code;
    if (item.dataset.kind === "fund") {
      const fund = results.funds.find((f) => f.code === code);
      addRecent(fund);
      navigate(`#/fund/${code}`);
    } else {
      const stock = results.stocks.find((s) => s.code === code);
      navigate(`#/stocks?code=${code}${stock?.quarter ? `&quarter=${stock.quarter}` : ""}`);
    }
    input.value = "";
    results = null;
    panel.classList.remove("open");
  });

  input.addEventListener("keydown", (event) => {
    if (event.key === "Escape") {
      closeSearch();
      return;
    }
    if (!results) return;
    const items = $$(".search-item", panel);
    if (!items.length) return;
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      activeIndex = event.key === "ArrowDown"
        ? Math.min(items.length - 1, activeIndex + 1)
        : Math.max(0, activeIndex - 1);
      items.forEach((item, index) => item.classList.toggle("active", index === activeIndex));
    }
    if (event.key === "Enter") {
      event.preventDefault();
      (items[activeIndex >= 0 ? activeIndex : 0]).dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
    }
  });

  document.addEventListener("click", (event) => {
    if (!event.target.closest(".global-search")) panel.classList.remove("open");
  });
  document.addEventListener("keydown", (event) => {
    if (event.key === "/" && !["INPUT", "TEXTAREA"].includes(document.activeElement.tagName)) {
      event.preventDefault();
      input.focus();
    }
  });
}

/* ---------------------------------------------------------------- boot --- */
async function loadMeta() {
  try {
    const meta = await api.meta();
    appState.meta = meta;
    const updated = meta.updated_at || "—";
    $("#sideQuarter").textContent = `${meta.latest_label} · ${meta.fund_total.toLocaleString("en-US")} 只基金`;
    $("#sideCount").textContent = `最近更新 ${updated}`;
    $("#quarterPill").textContent = `${meta.latest_label} · 持仓`;
    $("#updatedAt").textContent = updated === "—" ? "" : `上次抓取 ${updated.slice(5)}`;
    if (!getLastQuarter()) setLastQuarter(meta.latest_quarter);
    return meta;
  } catch (error) {
    $("#sideQuarter").textContent = "数据服务未就绪";
    $("#sideCount").textContent = "请先运行 scripts/warmup.py";
    return null;
  }
}

function setupSidebar() {
  const shell = $("#sidebar");
  const backdrop = $("#mobileBackdrop");
  const menuBtn = $("#menuBtn");
  const setOpen = (open) => {
    shell.classList.toggle("open", open);
    backdrop.classList.toggle("show", open);
    menuBtn.setAttribute("aria-expanded", String(open));
    document.body.style.overflow = open ? "hidden" : "";
  };
  menuBtn.setAttribute("aria-expanded", "false");
  menuBtn.setAttribute("aria-controls", "sidebar");
  menuBtn.addEventListener("click", () => setOpen(!shell.classList.contains("open")));
  backdrop.addEventListener("click", () => setOpen(false));
  $$("#nav a, .nav a[data-nav], .sidebar .brand").forEach((link) => {
    link.addEventListener("click", () => setOpen(false));
  });
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && shell.classList.contains("open")) setOpen(false);
  });
  window.addEventListener("resize", () => {
    if (window.innerWidth > 900 && shell.classList.contains("open")) setOpen(false);
  });
}

function setupQuarterPill() {
  $("#quarterPill").addEventListener("click", () => navigate("#/market"));
}

function currentTheme() {
  return document.documentElement.dataset.theme === "light" ? "light" : "dark";
}

function updateThemeButton() {
  const button = $("#themeBtn");
  if (!button) return;
  const theme = currentTheme();
  button.innerHTML = `<svg class="icon"><use href="#i-${theme === "light" ? "moon" : "sun"}"/></svg>`;
  button.title = theme === "light" ? "切换深色模式" : "切换浅色模式";
  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta) meta.setAttribute("content", theme === "light" ? "#f4f6fa" : "#080a0f");
}

function setupTheme() {
  updateThemeButton();
  $("#themeBtn")?.addEventListener("click", async () => {
    const next = currentTheme() === "light" ? "dark" : "light";
    const scrollY = window.scrollY;
    document.documentElement.dataset.theme = next;
    try {
      localStorage.setItem("fundscope.theme", next);
    } catch (error) { /* ignore */ }
    updateThemeButton();
    await renderRoute();
    window.scrollTo({ top: scrollY, behavior: "instant" });
  });
}

async function boot() {
  setupSidebar();
  setupSearch();
  setupQuarterPill();
  setupTheme();
  window.addEventListener("hashchange", renderRoute);
  window.addEventListener("resize", resizeCharts);
  await loadMeta();
  if (!location.hash) location.hash = "#/market";
  await renderRoute();
}

boot();
