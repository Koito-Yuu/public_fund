import { api } from "../api.js";
import { C, axisX, axisY, disposeCharts, donutChart, makeChart, palette, tooltipStyle } from "../charts.js";
import { $, $$, debounce, escapeHtml, fmtPct, fmtYi, pageLoading, safeUrl, tone } from "../utils.js";

const shortName = (name) => (name || "").length > 9 ? `${name.slice(0, 8)}…` : name;
const tenureSpan = (months) => {
  const value = Number(months) || 0;
  if (value < 12) return `${Math.round(value)}个月`;
  const years = Math.floor(value / 12);
  const rest = Math.round(value - years * 12);
  return rest ? `${years}年${rest}个月` : `${years}年`;
};
const reportCache = new Map();
let reportRequest = 0;

function correlationPairs(correlation) {
  const names = correlation?.names || [];
  const matrix = correlation?.matrix || [];
  const pairs = [];
  for (let i = 0; i < names.length; i += 1) {
    for (let j = i + 1; j < names.length; j += 1) {
      const value = matrix[i]?.[j];
      if (value !== null && value !== undefined && Number.isFinite(Number(value))) {
        pairs.push({ a: names[i], b: names[j], value: Number(value) });
      }
    }
  }
  return pairs.sort((x, y) => y.value - x.value);
}

function correlationHtml(correlation) {
  const pairs = correlationPairs(correlation);
  if (!pairs.length) {
    return `<div class="chart-empty">${escapeHtml(correlation?.note || "共同交易日不足，暂无法计算相关性")}</div>`;
  }
  return `<div class="corr-list">
    ${pairs.slice(0, 6).map((pair) => `<div class="corr-row">
      <div class="corr-names"><span>${escapeHtml(shortName(pair.a))}</span><span class="dim">×</span><span>${escapeHtml(shortName(pair.b))}</span></div>
      <div class="corr-track"><i style="width:${Math.max(4, Math.min(100, pair.value * 100)).toFixed(1)}%"></i></div>
      <strong class="mono">${pair.value.toFixed(3)}</strong>
    </div>`).join("")}
  </div>
  <div class="card-note">相关系数基于共同交易日日收益；越接近 1，产品风格与持仓节奏越同步。</div>`;
}

const toReturnSeries = (series) => (series || []).map(([day, value]) => [day, Number((value - 100).toFixed(2))]);

function managerRow(manager, selected) {
  return `<div class="manager-row ${manager.name === selected ? "active" : ""}" data-name="${escapeHtml(manager.name)}" data-company="${escapeHtml(manager.company)}">
    <div class="manager-rank">${manager.rank}</div>
    <div class="manager-main">
      <div class="manager-row-name">${escapeHtml(manager.name)}</div>
      <div class="manager-row-meta">${escapeHtml(manager.company)} · ${manager.product_count || manager.fund_count} 只产品</div>
    </div>
    <div class="manager-row-nums" title="总管理规模 ${fmtYi(manager.aum)}">
      <div class="manager-row-aum">${fmtYi(manager.equity_aum || manager.aum)}</div>
      <div class="manager-row-years">${manager.years ? `${Number(manager.years).toFixed(1)}年` : "—"}${manager.best_return !== null && manager.best_return !== undefined ? ` · ${fmtPct(manager.best_return)}` : ""}</div>
    </div>
  </div>`;
}

function renderList(managers, selected) {
  if (!managers.length) return '<div class="empty">未找到基金经理</div>';
  return managers.map((manager, index) => managerRow({ ...manager, rank: index + 1 }, selected)).join("");
}

function detailSkeleton() {
  return `<div class="page-loading"><div class="sk-title skeleton"></div><div class="sk-kpis">${'<div class="sk-kpi skeleton"></div>'.repeat(4)}</div><div class="sk-chart skeleton"></div></div>`;
}

function paragraphs(text) {
  return String(text || "")
    .split(/\n+/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => `<p>${escapeHtml(line)}</p>`)
    .join("");
}

function reportCard(reportFund) {
  return `<div class="card span-12" id="managerReportCard">
    <div class="card-head">
      <div><h3 class="card-title">最新季报 / 年报观点</h3><p class="card-sub" id="managerReportSub">代表产品：${escapeHtml(reportFund?.name || "—")}${reportFund?.tenure ? ` · 任职 ${tenureSpan(reportFund.tenure.months)}` : ""}</p></div>
      <div class="card-actions">
        <div class="segmented report-switch" id="managerReportTabs">
          <button class="seg-btn active" data-report="latest">最新季报</button>
          <button class="seg-btn" data-report="annual">最新年报</button>
        </div>
        <span class="badge badge-dim" id="managerReportKind">加载中</span>
      </div>
    </div>
    <div class="card-body" id="managerReportBody"><div class="skeleton" style="height:150px"></div></div>
  </div>`;
}

function drawManagerCharts(manager) {
  const data = manager.combined;
  if (data?.series?.length) {
    const series = (manager.funds || [])
      .filter((fund) => fund.series?.length)
      .map((fund, index) => ({
        name: fund.name,
        type: "line",
        data: toReturnSeries(fund.series),
        showSymbol: false,
        smooth: true,
        lineStyle: { width: 1.2, opacity: 0.75, color: palette[(index + 1) % palette.length] },
        itemStyle: { color: palette[(index + 1) % palette.length] },
      }));
    series.push({
      name: "等权组合",
      type: "line",
      data: toReturnSeries(data.series),
      showSymbol: false,
      smooth: true,
      lineStyle: { width: 2.8, color: C.accent },
      itemStyle: { color: C.accent },
      areaStyle: { color: C.accentFade },
      z: 5,
    });
    makeChart($("#managerNavChart"), {
      animationDuration: 500,
      grid: { left: 12, right: 20, top: 36, bottom: 12, containLabel: true },
      legend: { top: 0, left: 0, type: "scroll", icon: "roundRect", itemWidth: 8, itemHeight: 8, textStyle: { color: C.muted, fontSize: 11 } },
      tooltip: {
        ...tooltipStyle,
        trigger: "axis",
        formatter: (params) => {
          const rows = params.filter((p) => p.value !== null).map((p) => `${p.marker} ${escapeHtml(p.seriesName)} <b style="color:${Number(p.value[1]) >= 0 ? C.up : C.down}">${Number(p.value[1]) >= 0 ? "+" : ""}${Number(p.value[1]).toFixed(1)}%</b>`);
          return `<div style="color:${C.muted};font-size:11px;margin-bottom:3px">${params[0].axisValueLabel}</div>${rows.join("<br/>")}`;
        },
      },
      xAxis: { type: "time", axisLine: { lineStyle: { color: C.grid } }, axisTick: { show: false }, axisLabel: { color: C.dim, fontSize: 11 }, splitLine: { show: false } },
      yAxis: axisY({ scale: true, axisLabel: { color: C.dim, fontSize: 11, formatter: "{value}%" } }),
      series,
    });
  }
  if (manager.industry?.length) {
    donutChart($("#managerIndustry"), {
      items: manager.industry.slice(0, 8),
      centerLabel: "代表重仓",
      centerValue: `${manager.industry.slice(0, 5).reduce((s, x) => s + (x.share || 0), 0).toFixed(0)}%`,
      colors: palette,
    });
  }
}

async function loadReport(code, container, reportType = "latest") {
  const request = ++reportRequest;
  $("#managerReportKind").textContent = reportType === "annual" ? "年报加载中" : "加载中";
  container.innerHTML = '<div class="skeleton" style="height:150px"></div>';
  try {
    const cacheKey = `${code}:${reportType}`;
    const report = reportCache.get(cacheKey) || await api.fundReport(code, reportType);
    reportCache.set(cacheKey, report);
    if (!container.isConnected || request !== reportRequest) return;
    if (!report.available) {
      $("#managerReportKind").textContent = "暂无原文";
      container.innerHTML = `<div class="empty">暂无${reportType === "annual" ? "最新年报" : "最新定期报告"}正文。</div>`;
      return;
    }
    $("#managerReportKind").textContent = `${report.kind} · ${report.date}`;
    $("#managerReportSub").innerHTML = `代表产品：${escapeHtml(container.dataset.fundName || "")}${container.dataset.tenure ? ` · 任职 ${escapeHtml(container.dataset.tenure)}` : ""} · ${escapeHtml(report.title || "")}`;
    const blocks = [
      ["投资策略与运作分析", report.strategy],
      ["业绩表现", report.performance],
      ["后市展望", report.outlook],
    ].filter(([, text]) => text);
    container.innerHTML = `
      <div class="report-layout">
        <div class="report-text">
          ${blocks.map(([title, text]) => `<details class="report-block" open><summary>${escapeHtml(title)}</summary><div class="report-body">${paragraphs(text)}</div></details>`).join("")}
          <div class="note mt-8">以上为基金定期报告原文摘录，来源：<a href="${safeUrl(report.source)}" target="_blank" rel="noreferrer">东方财富公告</a>。</div>
        </div>
        <div class="report-side">
          <div class="stat"><div class="stat-label">报告期</div><div class="stat-value">${escapeHtml(report.date || "—")}</div></div>
          <div class="stat"><div class="stat-label">报告类型</div><div class="stat-value">${escapeHtml(report.kind || "—")}</div></div>
          <div class="stat"><div class="stat-label">原文长度</div><div class="stat-value">${Math.round((report.text_length || 0) / 1000)}k 字</div></div>
          <div class="note">“投资策略与运作分析”是基金经理在定期报告中的原文表述，不构成投资建议。</div>
        </div>
      </div>`;
  } catch (error) {
    if (!container.isConnected || request !== reportRequest) return;
    $("#managerReportKind").textContent = "加载失败";
    container.innerHTML = `<div class="error-box">${escapeHtml(error.message)}</div>`;
  }
}

function renderDetail(root, manager) {
  disposeCharts(root);
  const metrics = manager.combined?.metrics || {};
  const style = manager.style || {};
  const funds = manager.funds || [];
  root.innerHTML = `
    <div class="manager-hero card">
      <div class="card-body">
        <div class="detail-hero">
          <div class="fund-id">
            <div class="manager-avatar">${escapeHtml((manager.name || "").slice(0, 1))}</div>
            <div>
              <h1 class="fund-title" style="margin:0">${escapeHtml(manager.name)}</h1>
              <div class="fund-tags mt-8">
                <span class="badge badge-teal">${escapeHtml(manager.company || "—")}</span>
                <span class="badge badge-dim">从业 ${Number(manager.years || 0).toFixed(1)} 年</span>
                <span class="badge badge-dim">在管 ${manager.product_count || manager.fund_count || 0} 只产品</span>
                ${manager.best_return !== null ? `<span class="badge badge-gold">最佳回报 ${fmtPct(manager.best_return)}</span>` : ""}
              </div>
              <div class="fund-meta mt-8">${manager.matches?.length > 1 ? `同名经理 ${manager.matches.length} 位，当前展示在管规模最大者` : "数据按公开披露的任职基金与规模汇总"}</div>
            </div>
          </div>
          <div class="head-actions"><span class="badge badge-gold">在管规模 ${fmtYi(manager.aum)}</span></div>
        </div>
        <div class="stats-strip mt-16">
          <div class="stat"><div class="stat-label">在管规模</div><div class="stat-value">${fmtYi(manager.aum)}</div></div>
          <div class="stat"><div class="stat-label">产品数量</div><div class="stat-value">${manager.product_count || manager.fund_count || 0}</div></div>
          <div class="stat"><div class="stat-label">等权组合近3年</div><div class="stat-value ${tone(metrics.total_return)}">${fmtPct(metrics.total_return)}</div></div>
          <div class="stat"><div class="stat-label">组合最大回撤</div><div class="stat-value down">${fmtPct(metrics.max_drawdown)}</div></div>
          <div class="stat"><div class="stat-label">重仓集中度</div><div class="stat-value">${style.top10_weight ?? "—"}%</div></div>
          <div class="stat"><div class="stat-label">代表产品任期</div><div class="stat-value">${manager.report_fund?.tenure ? tenureSpan(manager.report_fund.tenure.months) : "—"}</div></div>
        </div>
      </div>
    </div>

    <div class="grid mt-16 manager-detail-grid">
      <div class="card span-7">
        <div class="card-head"><div><h3 class="card-title">在管产品收益</h3><p class="card-sub">近 3 年 · 区间累计收益率 · 起点 0% · 等权组合</p></div></div>
        <div class="card-body"><div id="managerNavChart" class="chart" style="height:360px"></div></div>
      </div>
      <div class="card span-5">
        <div class="card-head"><div><h3 class="card-title">风格指纹</h3><p class="card-sub">在管产品最新前十大合并口径</p></div></div>
        <div class="card-body">
          <div class="two-col">
            <div><div id="managerIndustry" class="chart" style="height:190px"></div></div>
            <div class="legend-list">
              ${(manager.industry || []).slice(0, 6).map((item, index) => `<div class="legend-row"><span class="legend-dot" style="background:${palette[index % palette.length]}"></span><span class="legend-name">${escapeHtml(item.name)}</span><span class="legend-val">${item.share.toFixed(1)}%</span></div>`).join("") || '<div class="dim small">暂无行业数据</div>'}
            </div>
          </div>
          <div class="style-facts">
            <div><span>前十大集中度</span><strong>${style.top10_weight === null || style.top10_weight === undefined ? "—" : `${Number(style.top10_weight).toFixed(1)}%`}</strong></div>
            <div><span>重仓留存度</span><strong>${style.retention === null || style.retention === undefined ? "—" : `${Number(style.retention).toFixed(0)}%`}</strong></div>
            <div><span>机构持有人</span><strong>${style.institution === null || style.institution === undefined ? "—" : `${Number(style.institution).toFixed(1)}%`}</strong></div>
          </div>
          <div class="card-note">市值风格：${(manager.cap || []).map((item) => `${item.name} ${item.share.toFixed(0)}%`).join(" · ") || "—"}</div>
        </div>
      </div>

      <div class="card span-12">
        <div class="card-head"><div><h3 class="card-title">在管产品业绩</h3><p class="card-sub">同时展示同经理管理的其他基金 · 按规模优先</p></div></div>
        <div class="card-body">
          <div class="data-table-wrap"><table class="data-table">
            <thead><tr><th>基金</th><th>类型</th><th class="num">近1年</th><th class="num">近3年</th><th class="num">规模</th><th class="num">夏普</th><th class="num">最大回撤</th><th>持仓期</th></tr></thead>
            <tbody>${funds.map((fund) => `<tr class="clickable" data-fund="${fund.code}">
              <td><div class="name-cell"><strong>${escapeHtml(fund.name)}</strong><span>${fund.code}</span></div></td>
              <td><span class="badge badge-dim">${escapeHtml(fund.type || "—")}</span></td>
              <td class="num ${tone(fund.r1y)}">${fmtPct(fund.r1y)}</td>
              <td class="num ${tone(fund.r3y)}">${fmtPct(fund.r3y)}</td>
              <td class="num">${fund.scale ? fmtYi(fund.scale) : "—"}</td>
              <td class="num">${fund.sharpe ?? "—"}</td>
              <td class="num down">${fmtPct(fund.max_drawdown)}</td>
              <td><span class="badge badge-dim">${fund.holdings_quarter || "—"}</span></td>
            </tr>`).join("")}</tbody>
          </table></div>
        </div>
      </div>

      <div class="card span-12 manager-synergy">
        <div class="card-head"><div><h3 class="card-title">组合协同诊断</h3><p class="card-sub">收益相关性、前十大重仓交集与组合层面的风险提示</p></div></div>
        <div class="card-body">
          <div class="synergy-grid">
            <div class="synergy-col">
              <div class="related-title">收益相关性</div>
              ${correlationHtml(manager.correlation)}
            </div>
            <div class="synergy-col">
              <div class="related-title">前十大重仓交集</div>
              <div class="pair-list">${(manager.overlap?.pairs || []).slice(0, 4).map((pair) => `<div class="pair-row"><span class="grow">${escapeHtml(shortName(pair.a_name))} × ${escapeHtml(shortName(pair.b_name))}</span><span class="pair-track"><i style="width:${Math.min(100, Number(pair.score) || 0)}%"></i></span><span class="mono">${pair.score}%</span></div>`).join("") || '<div class="dim small">暂无重叠数据</div>'}</div>
              <div class="insights mt-16">${(manager.insights || []).map((item) => `<div class="insight ${item.level}"><span class="insight-dot"></span><div><div class="insight-title">${escapeHtml(item.title)}</div><div class="insight-text">${escapeHtml(item.text)}</div></div></div>`).join("")}</div>
            </div>
          </div>
        </div>
      </div>

      ${manager.report_fund ? reportCard(manager.report_fund) : ""}
    </div>`;

  drawManagerCharts(manager);
  $$("tr[data-fund]").forEach((row) => {
    row.addEventListener("click", () => { location.hash = `#/fund/${row.dataset.fund}`; });
  });
  if (manager.report_fund) {
    const container = $("#managerReportBody");
    container.dataset.fundName = manager.report_fund.name;
    container.dataset.tenure = manager.report_fund.tenure ? tenureSpan(manager.report_fund.tenure.months) : "";
    loadReport(manager.report_fund.code, container, "latest");
    $$("#managerReportTabs [data-report]").forEach((btn) => {
      btn.addEventListener("click", () => {
        $$("#managerReportTabs [data-report]").forEach((b) => b.classList.toggle("active", b === btn));
        loadReport(manager.report_fund.code, container, btn.dataset.report);
      });
    });
  }
}

export async function render(el, params) {
  let selected = params.name || "";
  let selectedCompany = params.company || "";
  let listSort = params.sort || sessionStorage.getItem("fundscope.managerSort") || "best";
  let list = [];
  el.innerHTML = `
    <div class="page-head">
      <div>
        <div class="eyebrow">Manager Lens</div>
        <h1 class="page-title">基金经理</h1>
        <p class="page-sub">看一位经理在管的所有产品：业绩分化、重仓重叠、风格指纹、任期超额，以及最新季报与年报中的原始投资观点。</p>
      </div>
    </div>
    <div class="manager-layout">
      <div class="card manager-list-card">
        <div class="card-head">
          <div><h3 class="card-title">经理列表</h3><p class="card-sub" id="managerListSub">按最佳回报排序</p></div>
          <div class="segmented" id="managerSort">
            <button class="seg-btn active" data-sort="best">回报</button>
            <button class="seg-btn" data-sort="aum">规模</button>
            <button class="seg-btn" data-sort="years">年限</button>
          </div>
        </div>
        <div class="card-body">
          <div class="input-group"><svg class="icon"><use href="#i-search"/></svg><input class="input" id="managerSearch" placeholder="搜索经理姓名 / 基金公司"></div>
          <div class="manager-list mt-8" id="managerList"><div class="skeleton" style="height:300px"></div></div>
        </div>
      </div>
      <div id="managerDetail">${detailSkeleton()}</div>
    </div>`;

  const listEl = $("#managerList");
  const detailEl = $("#managerDetail");
  let requestId = 0;
  let listRequest = 0;

  const loadList = async (query = "") => {
    const currentList = ++listRequest;
    listEl.innerHTML = '<div class="skeleton" style="height:300px"></div>';
    try {
      const data = await api.managers({ q: query, limit: 40, sort: listSort });
      if (currentList !== listRequest || !el.isConnected) return;
      list = data.managers || [];
      listEl.innerHTML = renderList(list, selected);
      const sortLabel = { best: "最佳回报", aum: "权益类在管规模", years: "从业年限" }[listSort] || "最佳回报";
      $("#managerListSub").textContent = query ? `搜索到 ${Number(data.total).toLocaleString("en-US")} 位` : `${sortLabel} · ${Number(data.total).toLocaleString("en-US")} 位`;
      $$("#managerSort .seg-btn").forEach((btn) => btn.classList.toggle("active", btn.dataset.sort === listSort));
      $$(".manager-row", listEl).forEach((row) => {
        row.addEventListener("click", () => {
          selected = row.dataset.name;
          selectedCompany = row.dataset.company;
          history.replaceState(null, "", `#/managers?name=${encodeURIComponent(selected)}&company=${encodeURIComponent(selectedCompany)}`);
          loadDetail(selected, selectedCompany);
          $$(".manager-row", listEl).forEach((r) => r.classList.toggle("active", r === row));
        });
      });
      if (!selected && list.length) {
        const preferred = list.find((item) => (item.product_count || 0) >= 2) || list[0];
        selected = preferred.name;
        selectedCompany = preferred.company;
      }
    } catch (error) {
      if (currentList !== listRequest || !el.isConnected) return;
      listEl.innerHTML = `<div class="error-box">${escapeHtml(error.message)}</div>`;
    }
  };

  const loadDetail = async (name, company) => {
    if (!name) return;
    const current = ++requestId;
    detailEl.innerHTML = detailSkeleton();
    try {
      const manager = await api.manager(name, company);
      if (current !== requestId || !detailEl.isConnected) return;
      renderDetail(detailEl, manager);
    } catch (error) {
      if (current !== requestId || !detailEl.isConnected) return;
      detailEl.innerHTML = `<div class="card"><div class="card-body"><div class="error-box">${escapeHtml(error.message)}</div></div></div>`;
    }
  };

  const search = debounce(() => loadList($("#managerSearch").value.trim()), 300);
  $("#managerSearch").addEventListener("input", search);
  $$("#managerSort .seg-btn").forEach((btn) => {
    btn.addEventListener("click", () => {
      listSort = btn.dataset.sort;
      sessionStorage.setItem("fundscope.managerSort", listSort);
      loadList($("#managerSearch").value.trim());
    });
  });
  await loadList("");
  if (selected) loadDetail(selected, selectedCompany);
}
