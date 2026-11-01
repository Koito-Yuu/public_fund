import { api } from "../api.js";

let outsideClickBound = false;
import { getRecent } from "../store.js";
import { $, debounce, escapeHtml, fmtPct, pageLoading, tone } from "../utils.js";

function fundRow(fund) {
  return `<a class="search-item" href="#/fund/${fund.code}">
    <div class="si-main"><div class="si-name">${escapeHtml(fund.name)}</div>
    <div class="si-meta">${escapeHtml(fund.code)} · ${escapeHtml(fund.type || "基金")}</div></div>
    <span class="si-tag ${tone(fund.r1y)}">${fund.r1y === null || fund.r1y === undefined ? "—" : fmtPct(fund.r1y)}</span>
  </a>`;
}

function miniTable(rows, emptyText) {
  if (!rows?.length) return `<div class="empty">${emptyText}</div>`;
  return `<div class="legend-list">
    ${rows.map((row) => `<a class="legend-row" href="#/fund/${row.code}" style="padding:7px 0;border-bottom:1px solid var(--line-soft)">
      <span class="legend-name">${escapeHtml(row.name)} <span class="dim tiny">${row.code}</span></span>
      <span class="legend-val ${row.r1y === null || row.r1y === undefined ? "dim" : tone(row.r1y)}">${row.r1y === null || row.r1y === undefined ? escapeHtml(row.type || "—") : fmtPct(row.r1y)}</span>
    </a>`).join("")}
  </div>`;
}

export async function render(el) {
  el.innerHTML = `
    <div class="page-head">
      <div>
        <div class="eyebrow">Fund Profile</div>
        <h1 class="page-title">基金档案</h1>
        <p class="page-sub">输入基金代码或名称，查看净值曲线、风险指标、前十大持仓、行业暴露、规模与持有人结构。</p>
      </div>
    </div>

    <div class="card">
      <div class="card-body">
        <div class="add-fund" style="max-width:720px">
          <div class="input-group">
            <svg class="icon"><use href="#i-search"/></svg>
            <input class="input" id="fundSearch" style="height:46px;font-size:14px;padding-left:38px" placeholder="输入基金代码或名称，如 110022 / 易方达消费">
          </div>
          <div class="add-menu" id="fundResults" style="display:none"></div>
        </div>
        <div class="chip-row mt-12">
          <span class="tiny dim" style="line-height:29px">快捷入口</span>
          <a class="chip" href="#/fund/110022">易方达消费行业</a>
          <a class="chip" href="#/fund/510300">沪深300ETF</a>
          <a class="chip" href="#/fund/161725">招商中证白酒</a>
          <a class="chip" href="#/fund/003095">中欧医疗健康</a>
          <a class="chip" href="#/fund/163406">兴全合润</a>
        </div>
      </div>
    </div>

    <div class="grid mt-16">
      <div class="card span-7">
        <div class="card-head"><div><h3 class="card-title">最近查看</h3><p class="card-sub">保存在本地浏览器</p></div></div>
        <div class="card-body" id="recentWrap"></div>
      </div>
      <div class="card span-5">
        <div class="card-head"><div><h3 class="card-title">档案包含什么</h3><p class="card-sub">从净值到持仓的一体化视图</p></div></div>
        <div class="card-body">
          <div class="legend-list">
            <div class="legend-row"><span class="badge badge-teal">01</span><span class="legend-name">累计净值、回撤与沪深300基准</span></div>
            <div class="legend-row"><span class="badge badge-teal">02</span><span class="legend-name">前十大重仓、行业与市值风格</span></div>
            <div class="legend-row"><span class="badge badge-teal">03</span><span class="legend-name">规模、持有人结构与资产配置</span></div>
            <div class="legend-row"><span class="badge badge-teal">04</span><span class="legend-name">经理能力雷达与规则化诊断</span></div>
          </div>
        </div>
      </div>
      <div class="card span-6">
        <div class="card-head"><div><h3 class="card-title">近一年表现 <span class="badge badge-gold">筛选器</span></h3><p class="card-sub">按近一年收益排序，仅作入口参考</p></div><a class="btn btn-sm" href="#/screener">全部筛选</a></div>
        <div class="card-body" id="leadersWrap"><div class="skeleton" style="height:180px"></div></div>
      </div>
      <div class="card span-6">
        <div class="card-head"><div><h3 class="card-title">4433 精选 <span class="badge badge-teal">四周期前 25%</span></h3><p class="card-sub">近1/2/3年与今年来均位于同类前 25%</p></div><a class="btn btn-sm" href="#/screener">查看筛选</a></div>
        <div class="card-body" id="fourWrap"><div class="skeleton" style="height:180px"></div></div>
      </div>
    </div>
  `;

  const recent = getRecent();
  $("#recentWrap").innerHTML = recent.length
    ? miniTable(recent, "")
    : `<div class="empty">还没有浏览记录，搜索或点击上方快捷入口开始。</div>`;

  const input = $("#fundSearch");
  const panel = $("#fundResults");
  let searchRequest = 0;
  const search = debounce(async () => {
    const q = input.value.trim();
    const current = ++searchRequest;
    if (!q) {
      panel.style.display = "none";
      return;
    }
    try {
      const data = await api.search(q);
      if (current !== searchRequest || !panel.isConnected) return;
      panel.innerHTML = data.funds.length
        ? `<div class="search-group">基金结果</div>${data.funds.map(fundRow).join("")}`
        : '<div class="search-empty">未找到基金</div>';
      panel.style.display = "block";
    } catch (error) {
      if (current !== searchRequest || !panel.isConnected) return;
      panel.innerHTML = `<div class="search-empty">${escapeHtml(error.message)}</div>`;
      panel.style.display = "block";
    }
  }, 260);
  input.addEventListener("input", search);
  input.addEventListener("keydown", (event) => {
    if (event.key === "Enter") {
      const first = panel.querySelector("a.search-item");
      if (first) location.hash = first.getAttribute("href");
    }
  });
  if (!outsideClickBound) {
    outsideClickBound = true;
    document.addEventListener("click", (event) => {
      if (event.target.closest(".add-fund")) return;
      const node = document.getElementById("fundResults");
      if (node) node.style.display = "none";
    });
  }

  try {
    const [leaders, four] = await Promise.all([
      api.screener({ sort: "r1y", order: "desc", page_size: 5 }),
      api.screener({ four: "1", sort: "r1y", order: "desc", page_size: 5 }),
    ]);
    if (!el.isConnected) return;
    $("#leadersWrap").innerHTML = miniTable(leaders.rows, "暂无数据");
    $("#fourWrap").innerHTML = miniTable(four.rows, "当前市场没有同时满足 4433 的基金");
  } catch (error) {
    $("#leadersWrap").innerHTML = `<div class="empty">${escapeHtml(error.message)}</div>`;
    $("#fourWrap").innerHTML = "";
  }
}
