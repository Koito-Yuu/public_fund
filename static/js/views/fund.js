import { api } from "../api.js";
import { C, axisX, axisY, grad, lineChart, makeChart, palette, radarChart, stackedBarChart, tooltipStyle, treemapChart } from "../charts.js";
import { addRecent, addToPortfolio } from "../store.js";
import {
  $, $$, debounce, escapeHtml, fmtDate, fmtNum, fmtPct, fmtYi, pageLoading, safeUrl, stars, toast, tone,
} from "../utils.js";

const ACTION_CLASS = { 新进: "action-new", 加仓: "action-add", 减仓: "action-cut", 清仓: "action-exit", 不变: "action-hold" };
const reportCache = new Map();
let reportRequest = 0;

function rangeCutoff(lastDate, span) {
  if (span === "all") return null;
  const d = new Date(`${lastDate}T00:00:00`);
  if (span === "1y") d.setFullYear(d.getFullYear() - 1);
  if (span === "3y") d.setFullYear(d.getFullYear() - 3);
  if (span === "5y") d.setFullYear(d.getFullYear() - 5);
  return d.toISOString().slice(0, 10);
}

function buildRange(nav, span) {
  const dates = nav.dates || [];
  const values = nav.values || [];
  if (!dates.length) return null;
  const cutoff = rangeCutoff(dates[dates.length - 1], span);
  let start = 0;
  if (cutoff) {
    const found = dates.findIndex((d) => d >= cutoff);
    start = found < 0 ? 0 : found;
  }
  const rangeDates = dates.slice(start);
  const rangeValues = values.slice(start);
  const base = rangeValues[0] || 1;
  const returns = rangeValues.map((v) => Number(((v / base - 1) * 100).toFixed(2)));
  let peak = -Infinity;
  const drawdown = rangeValues.map((value) => {
    peak = Math.max(peak, value);
    return Number(((value / peak - 1) * 100).toFixed(2));
  });

  const benchmarkValues = nav.benchmark?.values || [];
  const bmDates = benchmarkValues.map((item) => item[0]);
  const bmMap = new Map(benchmarkValues);
  let pointer = 0;
  let lastBm = null;
  let bmBase = null;
  const benchmark = rangeDates.map((day) => {
    while (pointer < bmDates.length && bmDates[pointer] <= day) {
      lastBm = bmMap.get(bmDates[pointer]);
      pointer += 1;
    }
    if (bmBase === null && lastBm !== null) bmBase = lastBm;
    return lastBm !== null && bmBase ? Number(((lastBm / bmBase - 1) * 100).toFixed(2)) : null;
  });
  return { dates: rangeDates, returns, drawdown, benchmark, benchmarkName: nav.benchmark?.name || "沪深300" };
}

function annualReturns(nav) {
  const dates = nav?.dates || [];
  const values = nav?.values || [];
  const years = new Map();
  dates.forEach((day, index) => {
    const year = day.slice(0, 4);
    const value = Number(values[index]);
    if (!Number.isFinite(value)) return;
    const entry = years.get(year) || { first: value, last: value };
    entry.last = value;
    years.set(year, entry);
  });
  const keys = [...years.keys()].sort();
  const out = [];
  for (let index = 1; index < keys.length; index += 1) {
    const previous = years.get(keys[index - 1]);
    const current = years.get(keys[index]);
    if (!previous?.last || !current?.last) continue;
    out.push({ year: keys[index].slice(2), value: Number(((current.last / previous.last - 1) * 100).toFixed(2)) });
  }
  return out.slice(-6);
}

function drawAnnualReturns(el, nav) {
  if (!el) return;
  const items = annualReturns(nav);
  if (!items.length) {
    el.innerHTML = '<div class="chart-empty">净值历史不足两个自然年</div>';
    return;
  }
  makeChart(el, {
    animationDuration: 500,
    grid: { left: 6, right: 10, top: 24, bottom: 6, containLabel: true },
    tooltip: { ...tooltipStyle, trigger: "axis", formatter: (params) => `${params[0].axisValue} 年<br/>收益 <b style="color:${params[0].value >= 0 ? C.up : C.down}">${params[0].value >= 0 ? "+" : ""}${Number(params[0].value).toFixed(2)}%</b>` },
    xAxis: axisX({ data: items.map((item) => item.year), axisLabel: { color: C.dim, fontSize: 11 } }),
    yAxis: axisY({ axisLabel: { color: C.dim, fontSize: 11, formatter: "{value}%" } }),
    series: [{
      type: "bar",
      data: items.map((item) => ({
        value: item.value,
        itemStyle: { color: item.value >= 0 ? C.up : C.down, borderRadius: item.value >= 0 ? [3, 3, 0, 0] : [0, 0, 3, 3], opacity: 0.82 },
      })),
      barMaxWidth: 24,
      label: { show: true, position: "top", color: C.muted, fontSize: 11, formatter: ({ value }) => `${value >= 0 ? "+" : ""}${Number(value).toFixed(1)}%` },
    }],
  });
}

function managerMarkers(history, dates) {
  if (!history?.length || dates.length < 2) return [];
  const startDate = dates[0];
  const endDate = dates[dates.length - 1];
  const grouped = new Map();
  history.forEach((item) => {
    if (!item.start || item.start <= startDate || item.start > endDate) return;
    const index = dates.findIndex((day) => day >= item.start);
    if (index < 0) return;
    const day = dates[index];
    const names = String(item.manager || "").split(/\s+/).filter(Boolean);
    const short = names.length > 1 ? `${names[0]}等` : names[0] || "经理";
    const label = `${short} ${item.current ? "现任" : "上任"}`;
    if (!grouped.has(day)) grouped.set(day, []);
    grouped.get(day).push(label);
  });
  return [...grouped.entries()]
    .map(([date, labels], index) => ({ date, label: labels.join(" / "), position: index % 2 ? "insideEndBottom" : "insideEndTop" }))
    .slice(-10);
}

function drawNavChart(el, nav, span, managerHistory) {
  const data = buildRange(nav, span);
  if (!data) {
    el.innerHTML = '<div class="chart-empty">暂无净值数据</div>';
    return;
  }
  const hasBenchmark = data.benchmark.some((v) => v !== null);
  const markers = managerMarkers(managerHistory, data.dates);
  const denseMarkers = markers.length > 3 || (el.clientWidth < 700 && markers.length > 1);
  const markerLegend = document.getElementById("managerMarkerLegend");
  if (markerLegend) {
    markerLegend.innerHTML = denseMarkers && markers.length
      ? `<span class="marker-legend-label">经理变更</span>${markers.map((marker) => `<span class="marker-legend-item"><i></i>${escapeHtml(marker.date.slice(0, 7))} ${escapeHtml(marker.label)}</span>`).join("")}`
      : "";
  }
  const values = data.drawdown.filter((value) => value !== null && Number.isFinite(Number(value))).map(Number);
  const axisMin = values.length ? Math.max(-100, Math.floor(Math.min(...values) * 1.18 / 5) * 5) : -10;
  const option = {
    animationDuration: 500,
    grid: [
      { left: 12, right: 56, top: 34, height: "53%", containLabel: true },
      { left: 12, right: 56, top: "74%", height: "19%", containLabel: true },
    ],
    legend: {
      top: 0,
      left: 0,
      icon: "roundRect",
      itemWidth: 8,
      itemHeight: 8,
      textStyle: { color: C.muted, fontSize: 11 },
      data: ["累计收益", ...(hasBenchmark ? [data.benchmarkName] : []), "回撤"],
    },
    tooltip: {
      ...tooltipStyle,
      trigger: "axis",
      axisPointer: { link: [{ xAxisIndex: "all" }], lineStyle: { color: C.crosshair, type: "dashed" } },
      formatter: (params) => {
        if (!params.length) return "";
        const index = params[0].dataIndex;
        let html = `<div style="color:${C.muted};font-size:11px;margin-bottom:4px">${data.dates[index]}</div>`;
        params.forEach((p) => {
          if (p.value === null || p.value === undefined) return;
          if (p.seriesName === "回撤") {
            html += `<div style="margin-top:3px">回撤 <b style="color:${C.up}">${Number(p.value).toFixed(2)}%</b></div>`;
          } else {
            const value = Number(p.value);
            html += `<div>${p.seriesName} <b style="color:${value >= 0 ? C.up : C.down}">${value >= 0 ? "+" : ""}${value.toFixed(2)}%</b></div>`;
          }
        });
        return html;
      },
    },
    axisPointer: { link: [{ xAxisIndex: "all" }] },
    xAxis: [
      {
        type: "category",
        data: data.dates,
        boundaryGap: false,
        axisLine: { lineStyle: { color: C.grid } },
        axisTick: { show: false },
        axisLabel: { show: false },
      },
      {
        type: "category",
        gridIndex: 1,
        data: data.dates,
        boundaryGap: false,
        axisLine: { lineStyle: { color: C.grid } },
        axisTick: { show: false },
        axisLabel: { color: C.dim, fontSize: 11, hideOverlap: true },
      },
    ],
    yAxis: [
      {
        type: "value",
        scale: true,
        axisLabel: { color: C.dim, fontSize: 11, formatter: "{value}%" },
        splitLine: { lineStyle: { color: C.grid, type: "dashed" } },
      },
      {
        type: "value",
        gridIndex: 1,
        max: 0,
        min: axisMin,
        splitNumber: 2,
        axisLabel: { color: C.dim, fontSize: 11, formatter: "{value}%" },
        splitLine: { show: false },
      },
    ],
    series: [
      {
        name: "累计收益",
        type: "line",
        data: data.returns,
        showSymbol: false,
        smooth: true,
        lineStyle: { color: C.accent, width: 1.9 },
        itemStyle: { color: C.accent },
        areaStyle: { color: grad(C.accentArea, C.accentFade0) },
        z: 3,
        markLine: markers.length ? {
          silent: true,
          symbol: "none",
          animation: false,
          lineStyle: { color: C.gold, type: "dashed", width: 1, opacity: 0.65 },
          label: {
            show: !denseMarkers,
            position: "insideEndTop",
            rotate: 0,
            color: C.gold,
            fontSize: 11,
            backgroundColor: C.panel,
            padding: [2, 4],
            borderRadius: 3,
            formatter: (params) => params.name,
          },
          data: markers.map((marker) => ({
            xAxis: marker.date,
            name: marker.label,
            label: { position: marker.position },
          })),
        } : undefined,
      },
      ...(hasBenchmark
        ? [{
            name: data.benchmarkName,
            type: "line",
            data: data.benchmark,
            showSymbol: false,
            smooth: true,
            lineStyle: { color: C.gold, width: 1.2, type: "dashed" },
            itemStyle: { color: C.gold },
            z: 2,
          }]
        : []),
      {
        name: "回撤",
        type: "line",
        xAxisIndex: 1,
        yAxisIndex: 1,
        data: data.drawdown,
        showSymbol: false,
        smooth: false,
        lineStyle: { color: "rgba(242,85,106,.75)", width: 1.2 },
        areaStyle: { color: "rgba(242,85,106,.16)" },
        z: 1,
      },
    ],
  };
  makeChart(el, option);
}

function holdingsTable(data) {
  const stocks = data.holdings.latest?.stocks || [];
  if (!stocks.length) {
    return `<div class="empty">该基金最新报告期没有直接股票持仓（可能为债券 / 货币 / ETF 联接基金，或尚未披露）。</div>`;
  }
  const maxWeight = Math.max(...stocks.map((s) => s.weight || 0), 1);
  return `<div class="data-table-wrap">
    <table class="data-table">
      <thead><tr>
        <th>股票</th><th>行业</th><th class="num">占净值</th><th class="num">持仓市值</th>
        <th class="num">PE</th><th>较上季</th>
      </tr></thead>
      <tbody>
        ${stocks.map((stock) => `
          <tr class="clickable" data-stock="${stock.code}">
            <td><div class="name-cell"><strong>${escapeHtml(stock.name)}</strong><span>${stock.code}</span></div></td>
            <td><span class="badge badge-dim">${escapeHtml(stock.industry || "—")}</span></td>
            <td class="num">
              <div style="display:flex;align-items:center;justify-content:flex-end;gap:8px">
                <span class="weight-bar" style="width:56px"><i style="width:${(stock.weight / maxWeight) * 100}%"></i></span>
                <span>${Number(stock.weight).toFixed(2)}%</span>
              </div>
            </td>
            <td class="num">${stock.value_wan ? fmtYi(stock.value_wan / 1e4, 2) : "—"}</td>
            <td class="num ${stock.pe ? "" : "dim"}">${stock.pe ? Number(stock.pe).toFixed(1) : "—"}</td>
            <td><span class="${ACTION_CLASS[stock.action] || "action-hold"}">${stock.action || "—"}</span></td>
          </tr>`).join("")}
      </tbody>
    </table>
  </div>`;
}

function changeTable(change) {
  const items = (change.items || []).filter((item) => item.action !== "不变");
  if (!items.length) return '<div class="empty">最新两期前十大重仓没有变化。</div>';
  return `<div class="data-table-wrap">
    <table class="data-table">
      <thead><tr><th>股票</th><th>动作</th><th class="num">本期权重</th><th class="num">上期权重</th><th class="num">权重变化</th><th class="num">持股数变化</th><th class="num">本期市值</th></tr></thead>
      <tbody>
        ${items.map((item) => `
          <tr class="clickable" data-stock="${item.code}">
            <td><div class="name-cell"><strong>${escapeHtml(item.name)}</strong><span>${item.code}</span></div></td>
            <td><span class="${ACTION_CLASS[item.action] || "action-hold"}">${item.action}</span></td>
            <td class="num">${item.weight_now !== null && item.weight_now !== undefined ? `${Number(item.weight_now).toFixed(2)}%` : "—"}</td>
            <td class="num">${item.weight_prev !== null && item.weight_prev !== undefined ? `${Number(item.weight_prev).toFixed(2)}%` : "—"}</td>
            <td class="num ${tone(item.weight_delta)}">${item.weight_delta === null ? "—" : `${item.weight_delta > 0 ? "+" : ""}${Number(item.weight_delta).toFixed(2)}pp`}</td>
            <td class="num ${tone(item.shares_delta_pct)}">${item.shares_delta_pct === null ? "—" : fmtPct(item.shares_delta_pct)}</td>
            <td class="num">${item.value_wan ? fmtYi(item.value_wan / 1e4, 2) : "—"}</td>
          </tr>`).join("")}
      </tbody>
    </table>
  </div>`;
}

function metricsTable(metrics, achievement) {
  const rows = [
    ["近1年", metrics["1y"]],
    ["近3年", metrics["3y"]],
    ["成立以来", metrics.all],
  ];
  return `<div class="data-table-wrap">
    <table class="data-table">
      <thead><tr><th>区间</th><th class="num">收益</th><th class="num">年化</th><th class="num">最大回撤</th><th class="num">夏普</th></tr></thead>
      <tbody>
        ${rows.map(([label, m]) => `<tr>
          <td>${label}</td>
          <td class="num ${tone(m.total_return)}">${fmtPct(m.total_return)}</td>
          <td class="num ${tone(m.annual_return)}">${fmtPct(m.annual_return)}</td>
          <td class="num down">${fmtPct(m.max_drawdown)}</td>
          <td class="num">${m.sharpe ?? "—"}</td>
        </tr>`).join("")}
      </tbody>
    </table>
  </div>
  ${achievement?.length ? `<div class="note mt-8">近1年同类排名：${escapeHtml(achievement.join(" · "))}</div>` : ""}`;
}

function ppText(value) {
  if (value === null || value === undefined) return '<span class="dim">—</span>';
  return `<span class="delta-chip ${tone(value)}">${value > 0 ? "+" : ""}${Number(value).toFixed(2)}pp</span>`;
}

function holderCardHtml(data) {
  const h = data.holder_analysis;
  if (!h) {
    return `<div class="card span-12">
      <div class="card-head"><div><h3 class="card-title">持有人结构与自购信号</h3><p class="card-sub">半年披露 · 机构 / 个人 / 内部持有</p></div></div>
      <div class="card-body"><div class="empty">该基金暂无持有人结构数据。</div></div>
    </div>`;
  }
  const latest = h.latest || {};
  const changes = h.changes || {};
  const market = h.market || {};
  const gap = market.gap;
  const gapText = gap === null || gap === undefined
    ? "—"
    : `${gap >= 0 ? "高于" : "低于"}全市场 ${Math.abs(gap).toFixed(2)}pp`;
  return `<div class="card span-12" id="fund-holders">
    <div class="card-head">
      <div>
        <h3 class="card-title">持有人结构与自购信号</h3>
        <p class="card-sub">${h.latest_date} · 半年披露 · 上期 ${h.prev_date || "—"} · 内部持有为自购代理指标</p>
      </div>
      <div class="card-actions">
        <span class="badge badge-teal">机构 ${latest.institution ?? "—"}%</span>
        <span class="badge badge-gold">内部 ${latest.internal ?? "—"}%</span>
      </div>
    </div>
    <div class="card-body">
      <div class="holder-layout">
        <div class="holder-side">
          <div class="holder-metric">
            <span class="holder-metric-label">机构持有比例</span>
            <div class="holder-metric-row"><strong>${latest.institution ?? "—"}%</strong>${ppText(changes.institution)}</div>
            <div class="holder-metric-bar"><i style="width:${Math.min(100, latest.institution || 0)}%"></i></div>
          </div>
          <div class="holder-metric">
            <span class="holder-metric-label">个人持有比例</span>
            <div class="holder-metric-row"><strong>${latest.individual ?? "—"}%</strong>${ppText(changes.individual)}</div>
            <div class="holder-metric-bar individual"><i style="width:${Math.min(100, latest.individual || 0)}%"></i></div>
          </div>
          <div class="holder-metric">
            <span class="holder-metric-label">内部持有比例</span>
            <div class="holder-metric-row"><strong class="gold-text">${latest.internal ?? "—"}%</strong>${ppText(changes.internal)}</div>
            <div class="holder-metric-bar internal"><i style="width:${Math.min(100, (latest.internal || 0) * 8)}%"></i></div>
          </div>
          <div class="holder-market-note">
            全市场机构占比 <b>${market.institution ?? "—"}%</b><br/>
            本基金${gapText}
          </div>
        </div>
        <div>
          <div class="tiny dim holder-chart-label">机构持有比例趋势</div>
          <div id="holderStructChart" class="chart" style="height:232px"></div>
        </div>
        <div>
          <div class="tiny dim holder-chart-label">内部持有（自购代理）</div>
          <div id="holderInternalChart" class="chart" style="height:232px"></div>
        </div>
      </div>
      ${data.flows?.length ? `<div class="mt-16">
        <div class="flex-between"><div class="tiny dim holder-chart-label">份额申赎</div><span class="tiny dim">最近 8 个季度 · 亿份</span></div>
        <div id="holderFlowChart" class="chart" style="height:190px"></div>
      </div>` : ""}
      <div class="insights mt-16">${(h.signals || []).map((item) => `
        <div class="insight ${item.level}">
          <span class="insight-dot"></span>
          <div><div class="insight-title">${escapeHtml(item.title)}</div><div class="insight-text">${escapeHtml(item.text)}</div></div>
        </div>`).join("")}</div>
      <div class="card-note">${escapeHtml(h.caveat || "")} 个人持有比例 = 100% - 机构 - 内部；份额申赎为报告期汇总，持有人比例为半年披露，二者时间口径可能不完全一致。</div>
    </div>
  </div>`;
}

function tenureLength(months) {
  const value = Number(months) || 0;
  if (value < 12) return `${Math.round(value)}个月`;
  const years = Math.floor(value / 12);
  const rest = Math.round(value - years * 12);
  return rest ? `${years}年${rest}个月` : `${years}年`;
}

function managerTenuresHtml(tenures) {
  if (!tenures?.length) return "";
  return `<div class="tenure-table">
    <div class="tenure-thead"><span>经理 / 任期</span><span class="num">收益 / 年化</span><span class="num">超额</span></div>
    ${tenures.slice(0, 4).map((item) => `<div class="tenure-row">
      <div class="tenure-main"><strong>${escapeHtml(item.manager)}${item.current ? ' <span class="badge badge-teal">现任</span>' : ""}</strong><span>${item.start.slice(2)}–${item.end ? item.end.slice(2) : "至今"} · ${tenureLength(item.months)}</span></div>
      <div class="tenure-nums"><strong class="${tone(item.return)}">${fmtPct(item.return)}</strong><span class="${tone(item.annualized)}">年化 ${item.annualized === null ? "—" : fmtPct(item.annualized)}</span></div>
      <div class="tenure-excess"><strong class="${tone(item.excess)}">${item.excess === null ? "—" : `${item.excess > 0 ? "+" : ""}${Number(item.excess).toFixed(2)}pp`}</strong><span>${item.benchmark_return === null ? "基准未覆盖" : `沪深300 ${fmtPct(item.benchmark_return)}`}</span></div>
    </div>`).join("")}
    <div class="note">超额 = 任期基金收益 - 同期沪深300；年化为几何年化，按任职起始日切分。胜率仅统计基准数据可覆盖的任期。</div>
  </div>`;
}

function relatedFundsHtml(funds) {
  if (!funds?.length) return "";
  return `<div class="related-list">
    <div class="related-title">同经理在管产品</div>
    ${funds.map((fund) => `<a class="related-row" href="#/fund/${fund.code}">
      <span class="grow">${escapeHtml(fund.name)}</span>
      <span class="mono ${tone(fund.r1y)}">${fmtPct(fund.r1y)}</span>
    </a>`).join("")}
    <div class="note mt-8">按近一年收益排序，仅展示同公司、同经理的产品。</div>
  </div>`;
}

function reportParagraphs(text) {
  return String(text || "")
    .split(/\n+/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => `<p>${escapeHtml(line)}</p>`)
    .join("");
}

async function loadFundReport(code, data, reportType = "latest") {
  const body = $("#fundReportBody");
  if (!body) return;
  const request = ++reportRequest;
  $("#fundReportKind").textContent = reportType === "annual" ? "年报加载中" : "加载中";
  body.innerHTML = '<div class="skeleton" style="height:120px"></div>';
  try {
    const cacheKey = `${code}:${reportType}`;
    const report = reportCache.get(cacheKey) || await api.fundReport(code, reportType);
    reportCache.set(cacheKey, report);
    if (!body.isConnected || request !== reportRequest) return;
    if (!report.available) {
      $("#fundReportKind").textContent = "暂无原文";
      body.innerHTML = `<div class="empty">暂未获取到${reportType === "annual" ? "最新年报" : "最新定期报告"}正文，可能是新基金或公告尚未发布。</div>`;
      return;
    }
    $("#fundReportKind").textContent = `${report.kind} · ${report.date}`;
    const blocks = [
      ["投资策略与运作分析", report.strategy],
      ["业绩表现", report.performance],
      ["后市展望", report.outlook],
    ].filter(([, text]) => text);
    const holder = data.holder_analysis?.latest || {};
    body.innerHTML = `
      <div class="report-layout">
        <div class="report-text">
          <div class="flex-between mb-0" style="margin-bottom:10px">
            <div class="note">${escapeHtml(report.title || "")}</div>
            <a class="btn btn-sm" href="${safeUrl(report.source)}" target="_blank" rel="noreferrer">查看公告原文</a>
          </div>
          ${blocks.map(([title, text]) => `<details class="report-block" open><summary>${escapeHtml(title)}</summary><div class="report-body">${reportParagraphs(text)}</div></details>`).join("")}
          <div class="note">以上为定期报告原文摘录，不代表本看板观点。</div>
        </div>
        <div class="report-side">
          <div class="stat"><div class="stat-label">报告类型</div><div class="stat-value">${escapeHtml(report.kind || "—")} · ${escapeHtml(report.date || "—")}</div></div>
          <div class="stat"><div class="stat-label">前十大占净值</div><div class="stat-value">${data.holdings.latest?.top10_weight ?? "—"}%</div></div>
          <div class="stat"><div class="stat-label">规模环比</div><div class="stat-value ${tone(data.scale.mom)}">${fmtPct(data.scale.mom)}</div></div>
          <div class="stat"><div class="stat-label">机构 / 内部</div><div class="stat-value">${holder.institution ?? "—"}% / ${holder.internal ?? "—"}%</div></div>
          <div class="note">季报正文由基金管理人撰写；数据侧写来自本看板的持仓、规模与持有人计算。</div>
        </div>
      </div>`;
  } catch (error) {
    if (!body.isConnected || request !== reportRequest) return;
    $("#fundReportKind").textContent = "加载失败";
    body.innerHTML = `<div class="error-box">${escapeHtml(error.message)}</div>`;
  }
}

function drawHolderCharts(data) {
  const h = data.holder_analysis;
  if (!h) return;
  const labels = (h.dates || []).map((d) => d.slice(2, 7));
  lineChart($("#holderStructChart"), {
    dates: labels,
    series: [{ name: "机构持有", data: h.institution || [], color: C.accent }],
    yFormatter: (v) => `${v}%`,
    legend: false,
    area: true,
  });
  lineChart($("#holderInternalChart"), {
    dates: labels,
    series: [{ name: "内部持有", data: h.internal || [], color: C.gold }],
    yFormatter: (v) => `${v}%`,
    legend: false,
  });
  if (data.flows?.length && $("#holderFlowChart")) {
    const flows = [...data.flows].slice(0, 8).reverse();
    const flowLabels = flows.map((f) => f.date.slice(2, 7));
    makeChart($("#holderFlowChart"), {
      animationDuration: 500,
      color: [C.accent, C.up, C.gold],
      grid: { left: 10, right: 18, top: 34, bottom: 10, containLabel: true },
      legend: { top: 0, left: 0, icon: "roundRect", itemWidth: 8, itemHeight: 8, textStyle: { color: C.muted, fontSize: 11 } },
      tooltip: {
        ...tooltipStyle,
        trigger: "axis",
        axisPointer: { type: "shadow" },
        formatter: (params) => {
          const item = flows[params[0].dataIndex];
          return `<div style="color:${C.muted};font-size:11px;margin-bottom:3px">${item.date}</div>
            申购 <b>${item.subscription ?? "—"}</b> 亿份<br/>
            赎回 <b>${item.redemption ?? "—"}</b> 亿份<br/>
            净申赎 <b style="color:${(item.net || 0) >= 0 ? C.up : C.down}">${item.net ?? "—"}</b> 亿份`;
        },
      },
      xAxis: axisX({ data: flowLabels }),
      yAxis: axisY({ axisLabel: { color: C.dim, fontSize: 11, formatter: "{value}" } }),
      series: [
        { name: "申购", type: "bar", data: flows.map((f) => f.subscription), barMaxWidth: 13, itemStyle: { color: C.accent, borderRadius: [3, 3, 0, 0] } },
        { name: "赎回", type: "bar", data: flows.map((f) => f.redemption), barMaxWidth: 13, itemStyle: { color: C.up, borderRadius: [3, 3, 0, 0] } },
        { name: "净申赎", type: "line", data: flows.map((f) => f.net), smooth: true, showSymbol: true, symbolSize: 4, lineStyle: { color: C.gold, width: 1.6 }, itemStyle: { color: C.gold } },
      ],
    });
  }
}

function headerHtml(data) {
  const meta = data.meta;
  const rating = meta.rating_max ? stars(meta.rating_max) : "";
  const tags = [
    meta.type ? `<span class="badge badge-dim">${escapeHtml(meta.type)}</span>` : "",
    meta.category && meta.category !== meta.type ? `<span class="badge badge-dim">${escapeHtml(meta.category)}</span>` : "",
    rating ? `<span class="badge badge-gold">${rating}</span>` : "",
    meta.five_star ? `<span class="badge badge-gold">${meta.five_star} 家五星评级</span>` : "",
    meta.rating_ms ? `<span class="badge badge-teal">晨星 ${meta.rating_ms}★</span>` : "",
    meta.fee !== null && meta.fee !== undefined ? `<span class="badge badge-dim">申购费 ${Number(meta.fee).toFixed(2)}%</span>` : "",
    data.holder_analysis?.latest?.internal >= 1 ? `<span class="badge badge-gold">内部持有 ${Number(data.holder_analysis.latest.internal).toFixed(2)}%</span>` : "",
  ].join("");
  return `
    <div class="fund-head">
      <div>
        <div class="fund-id">
          <div class="fund-avatar">${escapeHtml((meta.name || "").slice(0, 1))}</div>
          <div>
            <h1 class="fund-title">${escapeHtml(meta.name)}</h1>
            <div class="fund-tags">${tags}</div>
            <div class="fund-meta">${escapeHtml(meta.code)} · ${escapeHtml(meta.company || "—")} · 基金经理 ${escapeHtml(meta.manager || "—")}${meta.established ? ` · 成立于 ${fmtDate(meta.established)}` : ""}</div>
          </div>
        </div>
      </div>
      <div class="fund-actions">
        <button class="btn btn-primary" id="addPfBtn">${'<svg class="icon"><use href="#i-plus"/></svg>'}加入组合</button>
        <a class="btn" href="#/portfolio">组合工坊</a>
        <button class="btn" id="copyBtn">复制链接</button>
      </div>
    </div>`;
}

function insightsHtml(insights) {
  if (!insights?.length) return '<div class="empty">暂无诊断结论</div>';
  return `<div class="insights">${insights.map((item) => `
    <div class="insight ${item.level}">
      <span class="insight-dot"></span>
      <div><div class="insight-title">${escapeHtml(item.title)}</div><div class="insight-text">${escapeHtml(item.text)}</div></div>
    </div>`).join("")}</div>`;
}

export async function render(el, params) {
  const pathMatch = location.hash.replace(/^#/, "").split("?")[0].match(/^\/fund\/([^/]+)\/?$/);
  const code = String(pathMatch?.[1] || params.code || "").slice(0, 12);
  if (!/^\d{6}$/.test(code)) {
    document.title = "基金代码无效 · FundScope";
    el.innerHTML = `<div class="card"><div class="card-body"><div class="error-box">基金代码应为 6 位数字，请从基金档案或搜索结果进入。</div><a class="btn btn-sm mt-12" href="#/funds">返回基金档案</a></div></div>`;
    return;
  }
  el.innerHTML = pageLoading();
  let data;
  try {
    data = await api.fund(code);
  } catch (error) {
    if (el.isConnected) el.innerHTML = `<div class="card"><div class="card-body"><div class="error-box">${escapeHtml(error.message)}</div></div></div>`;
    return;
  }
  if (!el.isConnected) return;
  addRecent({ code: data.meta.code, name: data.meta.name, type: data.meta.type });
  document.title = `${data.meta.name} · FundScope`;
  const meta = data.meta;
  const m1 = data.metrics["1y"];
  const latestStocks = data.holdings.latest?.stocks || [];
  const industryMap = new Map((data.holdings.industry || []).map((item, index) => [item.name, palette[index % palette.length]]));
  const achievements = [];
  const rank1y = (data.achievement || []).find((row) => String(row.period).includes("近1年") || String(row.period).includes("近一年"));
  const rank3y = (data.achievement || []).find((row) => String(row.period).includes("近3年") || String(row.period).includes("近三年"));
  if (rank1y?.rank_text) achievements.push(`近1年 ${rank1y.rank_text}`);
  if (rank3y?.rank_text) achievements.push(`近3年 ${rank3y.rank_text}`);
  const tenures = data.manager_tenures || [];
  const currentTenure = tenures.find((item) => item.current);
  const scoredTenures = tenures.filter((item) => item.excess !== null && item.excess !== undefined);
  const tenureHitRate = scoredTenures.length
    ? Math.round((scoredTenures.filter((item) => item.excess > 0).length / scoredTenures.length) * 100)
    : null;
  const bestTenure = scoredTenures.length
    ? scoredTenures.reduce((best, item) => (item.excess > best.excess ? item : best))
    : null;

  el.innerHTML = `
    ${headerHtml(data)}
    ${data.data_note ? `<div class="callout teal" style="margin-bottom:16px">${escapeHtml(data.data_note)}</div>` : ""}
    <div class="kpi-grid">
      <div class="kpi-card">
        <div class="kpi-label">最新净值 <span class="badge badge-dim">${fmtDate(meta.nav_date)}</span></div>
        <div class="kpi-value">${meta.nav !== null && meta.nav !== undefined ? Number(meta.nav).toFixed(4) : "—"}</div>
        <div class="kpi-sub"><span class="${tone(meta.day_pct)}">${fmtPct(meta.day_pct)}</span><span>累计净值走势已剔除分红</span></div>
      </div>
      <div class="kpi-card">
        <div class="kpi-label">近1年收益</div>
        <div class="kpi-value ${tone(data.periods["1y"])}">${fmtPct(data.periods["1y"])}</div>
        <div class="kpi-sub">近3年年化 ${fmtPct(data.metrics["3y"].annual_return)} · 今年以来 ${fmtPct(data.periods.ytd)}</div>
      </div>
      <div class="kpi-card">
        <div class="kpi-label">近1年最大回撤</div>
        <div class="kpi-value down">${fmtPct(m1.max_drawdown)}</div>
        <div class="kpi-sub">夏普 ${m1.sharpe ?? "—"} · 年化波动 ${fmtPct(m1.volatility, 1, false)}</div>
      </div>
      <div class="kpi-card gold">
        <div class="kpi-label">最新规模 <span class="badge badge-dim">${fmtDate(meta.scale_date)}</span></div>
        <div class="kpi-value">${meta.scale !== null && meta.scale !== undefined ? fmtYi(meta.scale) : "—"}</div>
        <div class="kpi-sub">规模环比 ${data.scale.mom === null || data.scale.mom === undefined ? "—" : fmtPct(data.scale.mom)} · 前十大占净值 ${data.holdings.latest?.top10_weight ?? "—"}%</div>
      </div>
    </div>

    <div class="fund-section-nav" id="fundSectionNav">
      <button class="active" data-target="fund-overview">概览</button>
      <button data-target="fund-report">经理观点</button>
      <button data-target="fund-holdings">持仓</button>
      <button data-target="fund-holders">持有人</button>
      <button data-target="fund-profile">规模资产</button>
    </div>

    <div class="grid fund-grid">
      <div class="card span-8" id="fund-overview">
        <div class="card-head">
          <div>
            <h3 class="card-title">收益与回撤</h3>
            <p class="card-sub">区间累计收益率 · 起点 0% · 基准沪深300 · 下方为回撤区间</p>
          </div>
          <div class="range-tabs" id="rangeTabs">
            <button class="range-tab" data-range="1y">近1年</button>
            <button class="range-tab active" data-range="3y">近3年</button>
            <button class="range-tab" data-range="5y">近5年</button>
            <button class="range-tab" data-range="all">成立以来</button>
          </div>
        </div>
        <div class="card-body">
          <div id="navChart" class="chart" style="height:560px"></div>
          <div id="managerMarkerLegend" class="manager-marker-legend"></div>
          <div class="card-note">区间起点收益率为 0%；回撤轴按区间实际最大回撤自适应。虚线为基金经理变更（上任 / 现任）。夏普比率按 1.5% 无风险利率、日频收益计算。</div>
        </div>
      </div>

      <div class="card span-4">
        <div class="card-head"><div><h3 class="card-title">诊断要点</h3><p class="card-sub">基于持仓、规模、风险与同类排名</p></div></div>
        <div class="card-body">${insightsHtml(data.insights)}</div>
      </div>

      <div class="span-4 fund-side">
        <div class="card fund-metrics">
          <div class="card-head"><div><h3 class="card-title">区间表现</h3><p class="card-sub">净值口径，未扣除申赎费用</p></div></div>
          <div class="card-body">${metricsTable(data.metrics, achievements)}</div>
        </div>
        <div class="card">
          <div class="card-head"><div><h3 class="card-title">年度收益</h3><p class="card-sub">按自然年首尾净值，最近 6 年</p></div></div>
          <div class="card-body"><div id="annualReturnChart" class="chart" style="height:140px"></div><div class="card-note">当年成立的首个自然年不计入；红涨绿跌为国内市场惯例。</div></div>
        </div>
      </div>

      <div class="card span-8" id="fund-manager">
        <div class="card-head">
          <div><h3 class="card-title">基金经理</h3><p class="card-sub">${escapeHtml(data.managers.map((m) => m.name).join(" / ") || "—")} · 历任 ${tenures.length || "—"} 位</p></div>
          <div class="card-actions"><a class="btn btn-sm" href="#/managers?name=${encodeURIComponent(data.managers[0]?.name || "")}">经理档案</a></div>
        </div>
        <div class="card-body">
          <div class="manager-overview">
            <div class="manager-people">
              ${data.managers.length ? data.managers.map((manager) => `
                <div class="manager-card">
                  <div class="avatar">${escapeHtml((manager.name || "").slice(0, 1))}</div>
                  <div class="grow"><div class="manager-name">${escapeHtml(manager.name)} ${manager.star ? `<span class="stars">${"★".repeat(Math.min(5, Number(manager.star)))}</span>` : ""}</div>
                  <div class="manager-meta">从业 ${escapeHtml(manager.work_time || "—")} · 在管 ${escapeHtml(manager.fund_size || "—")}</div></div>
                </div>`).join("") : '<div class="empty">暂无经理信息</div>'}
            </div>
            <div class="manager-facts">
              <div class="manager-fact"><span>现任任期</span><strong>${currentTenure ? tenureLength(currentTenure.months) : "—"}</strong></div>
              <div class="manager-fact"><span>任期超额胜率</span><strong>${tenureHitRate === null ? "—" : `${tenureHitRate}%`}</strong></div>
              <div class="manager-fact"><span>最佳任期超额</span><strong class="${tone(bestTenure?.excess)}">${bestTenure ? `${bestTenure.excess > 0 ? "+" : ""}${Number(bestTenure.excess).toFixed(1)}pp` : "—"}</strong></div>
            </div>
          </div>
          <div class="manager-split">
            <div class="manager-side">
              <div class="related-title">投研能力画像</div>
              <div id="managerRadar" class="chart" style="height:210px"></div>
              ${data.radar ? `<div class="note">${escapeHtml(data.radar.categories.join(" · "))}，综合 ${data.radar.avg || "—"}</div>` : ""}
              ${relatedFundsHtml(data.related_funds)}
            </div>
            <div class="manager-side">${managerTenuresHtml(tenures)}</div>
          </div>
        </div>
      </div>

      <div class="card span-12" id="fund-report">
        <div class="card-head">
          <div><h3 class="card-title">基金经理观点</h3><p class="card-sub">最新定期报告原文 · 季报 / 年报</p></div>
          <div class="card-actions">
            <div class="segmented report-switch" id="fundReportTabs">
              <button class="seg-btn active" data-report="latest">最新季报</button>
              <button class="seg-btn" data-report="annual">最新年报</button>
            </div>
            <span class="badge badge-dim" id="fundReportKind">加载中</span>
            <a class="btn btn-sm" href="#/managers?name=${encodeURIComponent(data.managers[0]?.name || meta.manager || "")}">经理档案</a>
          </div>
        </div>
        <div class="card-body" id="fundReportBody"><div class="skeleton" style="height:120px"></div></div>
      </div>

      <div class="card span-12" id="fund-holdings">
        <div class="card-head">
          <div>
            <h3 class="card-title">前十大重仓 <span class="badge badge-teal">${data.holdings.latest?.quarter || "—"}</span></h3>
            <p class="card-sub">报告期 ${fmtDate(data.holdings.latest?.date)} · 前十大合计占净值 ${data.holdings.latest?.top10_weight ?? "—"}% · 较上期留存度 ${data.holdings.change.retention ?? "—"}%</p>
          </div>
          <div class="card-actions"><span class="inline-note">行业为申万二级</span></div>
        </div>
        <div class="card-body">
          <div class="holdings-layout">
            <div>
              ${holdingsTable(data)}
              <div class="two-col mt-16">
                <div>
                  <div class="tiny dim" style="letter-spacing:.1em;margin-bottom:6px">市值风格（前十大）</div>
                  <div class="legend-list">
                    ${(data.holdings.cap || []).map((item) => `<div class="legend-row"><span class="legend-name">${escapeHtml(item.name)}</span><span class="legend-val">${item.share.toFixed(1)}%</span></div>`).join("") || '<div class="dim small">暂无数据</div>'}
                  </div>
                </div>
                <div>
                  <div class="tiny dim" style="letter-spacing:.1em;margin-bottom:6px">换仓摘要</div>
                  <div class="legend-list">
                    <div class="legend-row"><span class="legend-name">新进 / 清仓</span><span class="legend-val">${data.holdings.change.new_count} / ${data.holdings.change.exit_count}</span></div>
                    <div class="legend-row"><span class="legend-name">重仓股留存度</span><span class="legend-val">${data.holdings.change.retention ?? "—"}%</span></div>
                    <div class="legend-row"><span class="legend-name">留存权重占比</span><span class="legend-val">${data.holdings.change.retained_weight_share ?? "—"}%</span></div>
                  </div>
                </div>
              </div>
            </div>
            <div>
              <div id="holdingsTreemap" class="treemap"></div>
              <div class="note">面积代表占净值比例，颜色代表行业。仅覆盖前十大重仓股，不代表全部持仓。</div>
            </div>
          </div>
        </div>
      </div>

      <div class="card span-7">
        <div class="card-head"><div><h3 class="card-title">重仓股行业分布</h3><p class="card-sub">前十大重仓按申万二级行业聚合 · 与上期对比</p></div></div>
        <div class="card-body">
          <div id="holdingIndustryChart" class="chart" style="height:280px"></div>
          <div class="legend-list mt-8">
            ${(data.holdings.industry || []).slice(0, 8).map((item, index) => `<div class="legend-row">
              <span class="legend-dot" style="background:${palette[index % palette.length]}"></span>
              <span class="legend-name">${escapeHtml(item.name)}</span>
              <span class="legend-val">${item.share.toFixed(1)}%</span>
              <span class="legend-delta ${item.delta > 0 ? "up" : item.delta < 0 ? "down" : "dim"}">${item.delta === null ? "" : `${item.delta > 0 ? "+" : ""}${item.delta.toFixed(1)}pp`}</span>
            </div>`).join("") || '<div class="dim small">暂无数据</div>'}
          </div>
        </div>
      </div>

      <div class="card span-5">
        <div class="card-head"><div><h3 class="card-title">报告期行业配置</h3><p class="card-sub">证监会行业分类 · 覆盖全部股票持仓</p></div></div>
        <div class="card-body">
          <div id="officialChart" class="chart" style="height:390px"></div>
          <div class="note">仅展示权重最高的 8 个行业。季度报告只披露行业汇总，因此该图比“重仓股行业分布”覆盖更全，但分类更粗。</div>
        </div>
      </div>

      <div class="card span-6" id="fund-profile">
        <div class="card-head"><div><h3 class="card-title">规模变动</h3><p class="card-sub">最近 8 个报告期 · 亿元</p></div></div>
        <div class="card-body"><div id="scaleChart" class="chart" style="height:230px"></div></div>
      </div>
      <div class="card span-6">
        <div class="card-head"><div><h3 class="card-title">资产配置</h3><p class="card-sub">${fmtDate(data.asset.latest_date)} · 股票 / 债券 / 现金</p></div></div>
        <div class="card-body"><div id="assetChart" class="chart" style="height:230px"></div></div>
      </div>

      ${holderCardHtml(data)}

      <div class="card span-12">
        <div class="card-head">
          <div><h3 class="card-title">持仓变动</h3><p class="card-sub">${data.holdings.previous?.quarter || "上期"} → ${data.holdings.latest?.quarter || "本期"} · 前十大重仓对比</p></div>
          <span class="badge badge-gold">新进 ${data.holdings.change.new_count} · 清仓 ${data.holdings.change.exit_count}</span>
        </div>
        <div class="card-body">${changeTable(data.holdings.change)}</div>
      </div>
    </div>

    <div class="note mt-16">
      ${meta.benchmark ? `业绩比较基准：${escapeHtml(meta.benchmark)} · ` : ""}${meta.custodian ? `托管行：${escapeHtml(meta.custodian)} · ` : ""}数据更新于 ${data.updated_at} · 来源：天天基金 / 雪球基金 / 东方财富
    </div>
  `;

  const rangeKey = `fundscope.range.${code}`;
  let range = sessionStorage.getItem(rangeKey) || "3y";
  const drawRange = () => {
    drawNavChart($("#navChart"), data.nav, range, data.manager_history);
  };
  $$("#rangeTabs [data-range]").forEach((btn) => {
    btn.classList.toggle("active", btn.dataset.range === range);
    btn.addEventListener("click", () => {
      range = btn.dataset.range;
      sessionStorage.setItem(rangeKey, range);
      $$("#rangeTabs [data-range]").forEach((b) => b.classList.toggle("active", b === btn));
      drawRange();
    });
  });
  drawRange();

  if (latestStocks.length) {
    treemapChart($("#holdingsTreemap"), {
      data: latestStocks.map((stock) => ({ name: stock.name, value: stock.weight, code: stock.code, color: industryMap.get(stock.industry) || C.dim })),
      onClick: (stockCode) => { location.hash = `#/stocks?code=${stockCode}&quarter=${data.holdings.latest.quarter}`; },
    });
    const industryColors = new Map((data.holdings.industry || []).map((item, index) => [item.name, palette[index % palette.length]]));
    const displayIndustries = [...data.holdings.industry].reverse();
    makeChart($("#holdingIndustryChart"), {
      animationDuration: 500,
      grid: { left: 8, right: 50, top: 8, bottom: 8, containLabel: true },
      tooltip: { ...tooltipStyle, trigger: "axis", axisPointer: { type: "shadow" } },
      xAxis: axisY({ axisLabel: { color: C.dim, fontSize: 11, formatter: "{value}%" } }),
      yAxis: axisX({ data: displayIndustries.map((x) => x.name), axisLabel: { color: C.muted, fontSize: 11 } }),
      series: [{
        type: "bar",
        data: displayIndustries.map((x) => ({
          value: x.share,
          itemStyle: { color: industryColors.get(x.name) || C.accent, borderRadius: 4, opacity: 0.85 },
        })),
        barMaxWidth: 10,
        label: { show: true, position: "right", color: C.muted, fontSize: 11, formatter: ({ value }) => `${value}%` },
      }],
    });
  } else {
    $("#holdingsTreemap").innerHTML = '<div class="chart-empty">暂无股票持仓</div>';
    $("#holdingIndustryChart").innerHTML = '<div class="chart-empty">暂无股票持仓行业数据</div>';
  }

  const officialItems = (data.official_industry.latest?.items || [])
    .filter((x) => (x.weight || 0) > 0.05)
    .slice(0, 8);
  if (officialItems.length) {
    const officialColors = new Map(officialItems.map((item, index) => [item.name, palette[index % palette.length]]));
    const displayOfficial = [...officialItems].reverse();
    makeChart($("#officialChart"), {
      animationDuration: 500,
      grid: { left: 8, right: 46, top: 8, bottom: 8, containLabel: true },
      tooltip: {
        ...tooltipStyle,
        trigger: "axis",
        axisPointer: { type: "shadow" },
        formatter: (params) => {
          const item = displayOfficial[params[0].dataIndex];
          return `<b>${escapeHtml(item.name)}</b><br/>占净值 <b>${item.weight}%</b>`;
        },
      },
      xAxis: axisY({ axisLabel: { color: C.dim, fontSize: 11, formatter: "{value}%" } }),
      yAxis: axisX({ data: displayOfficial.map((x) => x.name), axisLabel: { color: C.muted, fontSize: 11 } }),
      series: [{
        type: "bar",
        data: displayOfficial.map((x) => ({
          value: x.weight,
          itemStyle: { color: officialColors.get(x.name) || C.accent, borderRadius: 4, opacity: 0.85 },
        })),
        barMaxWidth: 12,
        label: { show: true, position: "right", color: C.muted, fontSize: 11, formatter: ({ value }) => `${value}%` },
      }],
    });
  } else {
    $("#officialChart").innerHTML = '<div class="chart-empty">暂无报告期行业配置</div>';
  }

  drawAnnualReturns($("#annualReturnChart"), data.nav);

  const scaleDates = (data.scale.dates || []).slice(-8);
  const scaleValues = (data.scale.values || []).slice(-8);
  makeChart($("#scaleChart"), {
    animationDuration: 500,
    grid: { left: 8, right: 12, top: 20, bottom: 8, containLabel: true },
    tooltip: { ...tooltipStyle, trigger: "axis", formatter: (params) => `${params[0].axisValue}<br/>净资产 <b>${params[0].value} 亿元</b>` },
    xAxis: axisX({ data: scaleDates.map((d) => d.slice(2, 7)), axisLabel: { color: C.dim, fontSize: 11, interval: 0, rotate: 30 } }),
    yAxis: axisY({ axisLabel: { color: C.dim, fontSize: 11, formatter: "{value}亿" } }),
    series: [{
      type: "bar",
      data: scaleValues,
      barMaxWidth: 18,
      itemStyle: { color: grad(C.gold, "rgba(227,180,103,.08)"), borderRadius: [3, 3, 0, 0] },
    }],
  });

  const assetSeries = (data.asset.series || []).filter((item) => ["股票占净比", "债券占净比", "现金占净比"].includes(item.name));
  if (assetSeries.length && data.asset.dates.length) {
    stackedBarChart($("#assetChart"), {
      dates: data.asset.dates.slice(-4).map((d) => d.slice(2, 7)),
      series: assetSeries.map((item) => ({ name: String(item.name).replace("占净比", ""), data: item.data.slice(-4) })),
      yFormatter: "{value}%",
    });
  } else {
    $("#assetChart").innerHTML = '<div class="chart-empty">暂无资产配置数据</div>';
  }

  drawHolderCharts(data);
  loadFundReport(code, data, "latest");
  $$("#fundReportTabs [data-report]").forEach((btn) => {
    btn.addEventListener("click", () => {
      $$("#fundReportTabs [data-report]").forEach((b) => b.classList.toggle("active", b === btn));
      loadFundReport(code, data, btn.dataset.report);
    });
  });

  $$("#fundSectionNav [data-target]").forEach((btn) => {
    btn.addEventListener("click", () => {
      const target = document.getElementById(btn.dataset.target);
      if (!target) return;
      $$("#fundSectionNav [data-target]").forEach((b) => b.classList.toggle("active", b === btn));
      const top = target.getBoundingClientRect().top + window.scrollY - 82;
      window.scrollTo({ top, behavior: "smooth" });
    });
  });

  const manager = data.managers[0];
  if (manager?.power?.categories?.length) {
    radarChart($("#managerRadar"), {
      categories: manager.power.categories,
      values: manager.power.data.map((x) => Number(x) || 0),
      avg: manager.power.avg,
      name: manager.name,
    });
  } else {
    $("#managerRadar").style.display = "none";
  }

  $$(".holdings-layout tr[data-stock], .data-table tr[data-stock]").forEach((row) => {
    row.addEventListener("click", () => {
      location.hash = `#/stocks?code=${row.dataset.stock}&quarter=${data.holdings.latest?.quarter || ""}`;
    });
  });

  $("#addPfBtn").addEventListener("click", () => {
    const result = addToPortfolio({ code: meta.code, name: meta.name });
    toast(result.added ? "已加入组合工坊" : "该基金已在组合中", "success");
  });
  $("#copyBtn").addEventListener("click", async () => {
    try {
      await navigator.clipboard.writeText(location.href);
      toast("链接已复制", "success");
    } catch (error) {
      toast("复制失败，请手动复制地址栏链接", "error");
    }
  });
}
