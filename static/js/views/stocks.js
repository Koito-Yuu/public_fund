import { api } from "../api.js";
import { C, axisX, axisY, disposeCharts, gaugeChart, lineChart, makeChart, palette, tooltipStyle } from "../charts.js";
import { $, $$, debounce, escapeHtml, fmtInt, fmtPct, fmtYi, pageLoading, toast, tone } from "../utils.js";

function stockChange(pct, delta = null, unit = "", digits = 1, isNew = false) {
  const parts = [];
  if (delta !== null && delta !== undefined) {
    const absolute = Number(delta).toLocaleString("en-US", {
      minimumFractionDigits: digits,
      maximumFractionDigits: digits,
    });
    parts.push(`${delta > 0 ? "+" : ""}${absolute}${unit}`);
  }
  if (pct !== null && pct !== undefined) {
    parts.push(`${pct > 0 ? "+" : ""}${Number(pct).toFixed(1)}%`);
  }
  if (!parts.length) return isNew ? "<i>新进</i>" : "—";
  return `<i>${isNew ? "新进" : "环比"}</i>${parts.join(" · ")}`;
}

function shortQuarter(label) {
  const text = String(label || "");
  const match = text.match(/(\d{4})年([一二三四])季度/);
  if (match) {
    const map = { 一: 1, 二: 2, 三: 3, 四: 4 };
    return `${match[1].slice(2)}Q${map[match[2]]}`;
  }
  return text;
}

function listHtml(rows, selected) {
  if (!rows.length) return '<div class="empty">没有符合条件的重仓股</div>';
  return rows.map((row, index) => `
    <div class="stock-row ${row.code === selected ? "active" : ""}" data-code="${row.code}">
      <div class="stock-rank">${index + 1}</div>
      <div class="stock-main">
        <div class="stock-name"><span class="stock-name-text">${escapeHtml(row.name)}</span> <span class="stock-code">${row.code}</span></div>
        <div class="stock-sub">${escapeHtml(row.industry_l2 || row.industry || "—")}</div>
      </div>
      <div class="stock-nums">
        <div class="stock-metric" title="前十大重仓基金数及环比变化">
          <div class="stock-metric-top"><span class="stock-metric-label">基金数</span><b>${fmtInt(row.fund_count)}<small>只</small></b></div>
          <span class="stock-change ${tone(row.fund_count_qoq)}">${stockChange(row.fund_count_qoq, row.fund_count_delta, "只", 0, row.fund_count_new)}</span>
        </div>
        <div class="stock-metric" title="前十大重仓持仓市值及环比变化">
          <div class="stock-metric-top"><span class="stock-metric-label">市值</span><b>${fmtYi(row.value)}</b></div>
          <span class="stock-change ${tone(row.value_qoq)}">${stockChange(row.value_qoq, row.value_delta, "亿", 1, row.value_new)}</span>
        </div>
      </div>
    </div>`).join("");
}

function stockInsightsHtml(insights) {
  return `<div class="insights mt-16">${(insights || []).map((item) => `<div class="insight ${item.level}">
    <span class="insight-dot"></span>
    <div><div class="insight-title">${escapeHtml(item.title)}</div><div class="insight-text">${escapeHtml(item.text)}</div></div>
  </div>`).join("")}</div>`;
}

function rankLabel(rank, pct) {
  if (!rank) return "—";
  return `<span>#${rank}</span><span class="tiny dim">Top ${Number(pct || 0).toFixed(2)}%</span>`;
}

function priceRiskHtml(data) {
  const risk = data.price_risk;
  if (!risk || !risk.dates?.length) return "";
  const metrics = risk.metrics || {};
  const stats = risk.risk || {};
  return `<div class="card span-12" id="stockPriceRiskCard">
    <div class="card-head"><div><h3 class="card-title">个股价格与风险</h3><p class="card-sub">近 1 年 · 前复权收盘价 · 与公募持仓口径独立</p></div><span class="badge badge-dim">${risk.start || ""} 至 ${risk.end || ""}</span></div>
    <div class="card-body">
      <div class="stock-price-layout">
        <div id="stockPriceChart" class="chart" style="height:230px"></div>
        <div class="stock-price-stats">
          <div class="stat"><div class="stat-label">近1年收益</div><div class="stat-value ${tone(metrics.total_return)}">${fmtPct(metrics.total_return)}</div></div>
          <div class="stat"><div class="stat-label">年化波动</div><div class="stat-value">${fmtPct(metrics.volatility, 2, false)}</div></div>
          <div class="stat"><div class="stat-label">最大回撤</div><div class="stat-value down">${fmtPct(metrics.max_drawdown)}</div></div>
          <div class="stat"><div class="stat-label">夏普比率</div><div class="stat-value">${metrics.sharpe ?? "—"}</div></div>
          <div class="stat"><div class="stat-label">年化超额</div><div class="stat-value ${tone(stats.excess_annual)}">${fmtPct(stats.excess_annual)}</div></div>
          <div class="stat"><div class="stat-label">β / α</div><div class="stat-value">${stats.beta ?? "—"} / ${stats.alpha === null || stats.alpha === undefined ? "—" : fmtPct(stats.alpha)}</div></div>
        </div>
      </div>
      <div class="note">价格风险用于观察个股自身波动与相对沪深300的表现；公募持仓变化可能存在披露滞后，二者应分开解读。</div>
    </div>
  </div>`;
}

function drawStockPriceRisk(data) {
  const risk = data.price_risk;
  const el = $("#stockPriceChart");
  if (!risk || !el || !risk.dates?.length) return;
  const series = [{ name: "个股", data: risk.stock, color: C.accent }];
  if (risk.benchmark?.some((value) => value !== null && value !== undefined)) {
    series.push({ name: risk.benchmark_name || "沪深300", data: risk.benchmark, color: C.gold, width: 1.2, dashed: true });
  }
  lineChart(el, {
    dates: risk.dates,
    series,
    yFormatter: (value) => `${value}%`,
    legend: true,
  });
}

function detailHtml(data) {
  const latest = data.latest;
  const quote = data.quote || {};
  const history = data.history || [];
  const industryL1 = data.industry || "—";
  const industryL2 = data.industry_l2 || industryL1;
  const scope = "前十大";
  const fcQoq = latest?.fund_count_qoq;
  const valueQoq = latest?.value_qoq;
  const prevTitle = latest?.prev_label ? `前十大环比：较 ${latest.prev_label}` : "上一季度前十大重仓数据暂不可得";
  return `
    <div class="card">
      <div class="card-body">
        <div class="detail-hero">
          <div>
            <div class="flex wrap" style="gap:9px">
              <h2 style="margin:0;font-size:24px;letter-spacing:-.01em">${escapeHtml(data.name)}</h2>
              <span class="badge badge-teal">${escapeHtml(industryL2)}</span>
              ${industryL2 !== industryL1 ? `<span class="badge badge-dim">${escapeHtml(industryL1)}</span>` : ""}
            </div>
            <div class="fund-meta" style="margin-top:8px">${data.code} · 最新报告期 ${latest.quarter} · 前十大重仓口径 · 数据来自全市场基金季报聚合${data.fallback ? ` · 所选 ${escapeHtml(data.requested_quarter || "")} 无该股数据，展示最近可用报告期` : ""}</div>
          </div>
          <div class="right">
            <div class="quote-price ${tone(quote.pct)}">${quote.price !== null && quote.price !== undefined ? `¥${Number(quote.price).toFixed(2)}` : "—"}</div>
            <div class="quote-change ${tone(quote.pct)}">${fmtPct(quote.pct)} <span class="dim tiny">今日</span></div>
            <div class="quote-meta">
              <div>PE<strong>${quote.pe ?? "—"}</strong></div>
              <div>PB<strong>${quote.pb ?? "—"}</strong></div>
              <div>总市值<strong>${quote.mktcap ? fmtYi(quote.mktcap) : "—"}</strong></div>
              <div>流通市值<strong>${quote.float_cap ? fmtYi(quote.float_cap) : "—"}</strong></div>
            </div>
          </div>
        </div>
        <div class="stats-strip stock-stats mt-16">
          <div class="stat" title="重仓该股的前十大基金数"><div class="stat-label">前十大基金数</div><div class="stat-value">${fmtInt(latest.fund_count)}<span class="tiny dim"> 只</span></div></div>
          <div class="stat" title="前十大基金合计持仓市值"><div class="stat-label">前十大持仓市值</div><div class="stat-value">${fmtYi(latest.value)}</div></div>
          <div class="stat" title="${prevTitle}"><div class="stat-label">基金数环比</div><div class="stat-value ${tone(fcQoq)}">${fcQoq === null || fcQoq === undefined ? (latest.fund_count_new ? "新进" : "—") : fmtPct(fcQoq, 1)}</div><div class="stat-aux">${latest.fund_count_delta === null || latest.fund_count_delta === undefined ? "—" : `${latest.fund_count_delta > 0 ? "+" : ""}${Number(latest.fund_count_delta).toLocaleString("en-US", { maximumFractionDigits: 0 })} 只`}</div></div>
          <div class="stat" title="${prevTitle}"><div class="stat-label">市值环比</div><div class="stat-value ${tone(valueQoq)}">${valueQoq === null || valueQoq === undefined ? (latest.value_new ? "新进" : "—") : fmtPct(valueQoq, 1)}</div><div class="stat-aux">${latest.value_delta === null || latest.value_delta === undefined ? "—" : `${latest.value_delta > 0 ? "+" : ""}${Number(latest.value_delta).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })} 亿`}</div></div>
          <div class="stat" title="前十大持仓市值 / 当前流通市值"><div class="stat-label">前十大/流通</div><div class="stat-value">${latest.crowding === null || latest.crowding === undefined ? "—" : `${Number(latest.crowding).toFixed(2)}%`}</div></div>
          <div class="stat" title="占全市场基金前十大重仓总市值"><div class="stat-label">前十大市值占比</div><div class="stat-value">${latest.market_share === null || latest.market_share === undefined ? "—" : `${Number(latest.market_share).toFixed(2)}%`}</div></div>
          <div class="stat" title="全市场前十大重仓股中按持有基金数排名"><div class="stat-label">基金数排名</div><div class="stat-value rank-value">${rankLabel(latest.rank_count, latest.rank_count_pct)}</div></div>
          <div class="stat" title="全市场前十大重仓股中按持仓市值排名"><div class="stat-label">市值排名</div><div class="stat-value rank-value">${rankLabel(latest.rank_value, latest.rank_value_pct)}</div></div>
        </div>
      </div>
    </div>

    <div class="grid stock-detail-grid mt-16">
      <div class="card span-8">
        <div class="card-head">
          <div><h3 class="card-title">公募持仓轨迹</h3><p class="card-sub">最近 ${history.length} 个报告期 · 前十大基金数（左轴）与持仓市值（右轴）</p></div>
          <span class="badge badge-teal">${scope}</span>
        </div>
        <div class="card-body">
          <div id="stockHistoryChart" class="chart" style="height:300px"></div>
          <div class="note">所有报告期均按基金前十大重仓口径；Q2 / Q4 由基金中报 / 年报持仓还原前十大，与 Q1 / Q3 可直接比较。仅展示已构建数据的报告期，缺失季度不参与环比。</div>
        </div>
      </div>
      <div class="card span-4">
        <div class="card-head"><div><h3 class="card-title">持仓拥挤度</h3><p class="card-sub">前十大持仓市值 / 当前流通市值</p></div></div>
        <div class="card-body">
          <div id="crowdGauge" class="chart" style="height:185px"></div>
          <div class="note">按当前流通市值估算；历史报告期的流通股本可能变化，该比例用于观察量级与趋势，不作精确估值。</div>
          <div class="chart mt-8" id="ratioTrend" style="height:110px"></div>
        </div>
      </div>
      <div class="card span-7">
        <div class="card-head"><div><h3 class="card-title">报告期明细</h3><p class="card-sub">前十大重仓聚合 · 环比上一季度</p></div></div>
        <div class="card-body">
          <div class="data-table-wrap"><table class="data-table">
            <thead><tr><th>报告期</th><th class="num">前十大基金数</th><th class="num">基金数环比</th><th class="num">前十大市值</th><th class="num">市值环比</th><th class="num">前十大/流通</th></tr></thead>
            <tbody>${[...history].reverse().map((row) => `<tr>
              <td title="${escapeHtml(row.label)}">${shortQuarter(row.label)}</td>
              <td class="num">${fmtInt(row.fund_count)}</td>
              <td class="num ${tone(row.fund_count_qoq)}">${row.fund_count_qoq === null || row.fund_count_qoq === undefined ? (row.fund_count_new ? "新进" : "—") : fmtPct(row.fund_count_qoq, 1)}</td>
              <td class="num">${fmtYi(row.value)}</td>
              <td class="num ${tone(row.value_qoq)}">${row.value_qoq === null || row.value_qoq === undefined ? (row.value_new ? "新进" : "—") : fmtPct(row.value_qoq, 1)}</td>
              <td class="num">${row.crowding === null || row.crowding === undefined ? "—" : `${Number(row.crowding).toFixed(2)}%`}</td>
            </tr>`).join("")}</tbody>
          </table></div>
          <div class="note mt-8">所有报告期均按基金前十大重仓口径；Q2 / Q4 由基金中报 / 年报持仓还原前十大。</div>
        </div>
      </div>
      <div class="card span-5">
        <div class="card-head"><div><h3 class="card-title">同行业重仓股</h3><p class="card-sub">${escapeHtml(data.industry || "—")} · 按前十大基金数</p></div></div>
        <div class="card-body">
          ${data.peers?.length ? `<div class="legend-list">${data.peers.map((peer) => `<div class="legend-row clickable" data-peer="${peer.code}">
            <span class="legend-name">${escapeHtml(peer.name)} <span class="dim tiny">${peer.code}</span></span>
            <span class="legend-val">${fmtInt(peer.fund_count)} 只 <span class="stock-change ${tone(peer.fund_count_qoq)}">${stockChange(peer.fund_count_qoq)}</span></span>
            <span class="legend-delta dim">${fmtYi(peer.value)}</span>
          </div>`).join("")}</div>` : '<div class="empty">暂无同行业数据</div>'}
          ${stockInsightsHtml((data.insights || []).slice(0, 4))}
        </div>
      </div>
      ${priceRiskHtml(data)}
    </div>`;
}


export async function render(el, params, state) {
  const meta = state.meta || (await api.meta());
  if (!el.isConnected) return;
  state.meta = meta;
  const available = meta.quarters.filter((q) => q.top10_available);
  let quarter = params.quarter || meta.latest_quarter;
  if (available.length && !available.some((q) => q.quarter === quarter)) {
    quarter = available[0].quarter;
  }
  let rows = [];
  let selected = params.code || "";
  let keyword = "";
  let industry = "";
  let sort = "fund_count";
  let order = "desc";
  let detailCache = new Map();
  let requestId = 0;
  let listRequest = 0;

  el.innerHTML = `
    <div class="page-head">
      <div>
        <div class="eyebrow">Stock Lens</div>
        <h1 class="page-title">重仓股透视</h1>
        <p class="page-sub">从个股视角反查公募持仓：多少基金把它买进前十大、持仓市值多大、占流通盘多少，以及共识正在扩张还是瓦解。</p>
      </div>
      <div class="head-actions">
        <select class="select" id="stockQuarter">
          ${available.map((q) => `<option value="${q.quarter}" ${q.quarter === quarter ? "selected" : ""}>${q.label}</option>`).join("")}
        </select>
      </div>
    </div>
    <div class="stocks-layout">
      <div class="card stock-list-card">
        <div class="card-head"><div><h3 class="card-title">重仓股排行</h3><p class="card-sub" id="stockListSub">加载中…</p></div><span class="badge badge-dim" id="stockScopeBadge">—</span></div>
        <div class="card-body">
          <div class="input-group"><svg class="icon"><use href="#i-search"/></svg><input class="input" id="stockSearch" placeholder="搜索股票代码或名称"></div>
          <div class="stock-tools mt-8">
            <label class="stock-tools-field">
              <svg class="icon"><use href="#i-filter"/></svg>
              <select class="select" id="stockIndustry" aria-label="筛选行业"><option value="">全部行业</option></select>
            </label>
            <label class="stock-tools-field stock-sort-field">
              <svg class="icon"><use href="#i-sort"/></svg>
              <select class="select" id="stockSort" aria-label="排序字段" title="全市场前十大重仓股按所选指标排序，展示前 300 只；变化项为前十大重仓环比">
                <option value="fund_count_delta">基金数环比</option>
                <option value="value_delta">市值环比</option>
                <option value="fund_count">前十大基金数</option>
                <option value="value">前十大市值</option>
              </select>
            </label>
            <button class="stock-order-btn" id="stockOrderBtn" title="降序">降序</button>
          </div>
          <div class="stock-basis-note" id="stockChangeBasis"></div>
          <div class="stock-list mt-8" id="stockList"><div class="skeleton" style="height:300px"></div></div>
        </div>
      </div>
      <div id="stockDetail">${pageLoading()}</div>
    </div>
  `;

  const listEl = $("#stockList");
  const detailEl = $("#stockDetail");

  const loadList = async () => {
    const currentList = ++listRequest;
    listEl.innerHTML = '<div class="skeleton" style="height:300px"></div>';
    try {
      const data = await api.stocks({ quarter, limit: 300, q: keyword, industry, sort, order });
      if (currentList !== listRequest || !el.isConnected) return;
      rows = data.rows;
      const scopeBadge = $("#stockScopeBadge");
      scopeBadge.textContent = "前十大";
      scopeBadge.className = "badge badge-teal";
      $("#stockListSub").textContent = `${data.as_of} · ${data.total.toLocaleString("en-US")} 只 · 展示前 ${data.rows.length} 只`;
      $("#stockChangeBasis").textContent = data.prev_label
        ? `前十大重仓环比：较 ${data.prev_label}`
        : "前十大重仓口径 · 上一季度数据暂不可得";
      const select = $("#stockIndustry");
      select.innerHTML = '<option value="">全部行业</option>' + data.industries
        .map((item) => `<option value="${escapeHtml(item.name)}">${escapeHtml(item.name)}（${item.count}）</option>`)
        .join("");
      if (industry && !data.industries.some((item) => item.name === industry)) {
        industry = "";
        select.value = "";
        await loadList();
        return;
      }
      select.value = industry;
      const selectedInRows = rows.some((row) => row.code === selected);
      if (!selected || !selectedInRows) {
        selected = rows[0]?.code || "";
      }
      renderList();
      if (selected) loadDetail(selected);
      else detailEl.innerHTML = '<div class="card"><div class="card-body"><div class="empty">没有符合当前筛选条件的重仓股</div></div></div>';
    } catch (error) {
      if (currentList !== listRequest || !el.isConnected) return;
      listEl.innerHTML = `<div class="error-box">${escapeHtml(error.message)}</div>`;
      if (!selected) detailEl.innerHTML = `<div class="card"><div class="card-body"><div class="error-box">${escapeHtml(error.message)}</div></div></div>`;
    }
  };

  const filteredRows = () => {
    let list = rows.filter((row) => {
      if (industry && row.industry !== industry) return false;
      if (keyword && !`${row.name}${row.code}`.toLowerCase().includes(keyword.toLowerCase())) return false;
      return true;
    });
    const metric = {
      value: "value",
      fund_count_delta: "fund_count_delta",
      value_delta: "value_delta",
      fund_count: "fund_count",
    }[sort] || "fund_count";
    list = [...list].sort((a, b) => {
      const av = a[metric];
      const bv = b[metric];
      if (av === null || av === undefined) return 1;
      if (bv === null || bv === undefined) return -1;
      return order === "asc" ? Number(av) - Number(bv) : Number(bv) - Number(av);
    });
    return list;
  };

  const selectRow = (code) => {
    if (!code || code === selected) return;
    selected = code;
    renderList();
    loadDetail(code);
    history.replaceState(null, "", `#/stocks?code=${code}&quarter=${quarter}`);
  };

  const renderList = () => {
    const list = filteredRows();
    listEl.innerHTML = listHtml(list, selected);
  };

  listEl.addEventListener("click", (event) => {
    const row = event.target.closest(".stock-row");
    if (row) selectRow(row.dataset.code);
  });

  const loadDetail = async (code) => {
    const current = ++requestId;
    disposeCharts(detailEl);
    detailEl.innerHTML = pageLoading();
    try {
      const cacheKey = `${code}:${quarter}`;
      let data = detailCache.get(cacheKey);
      if (!data) {
        data = await api.stock(code, quarter);
        detailCache.set(cacheKey, data);
      }
      if (current !== requestId || !detailEl.isConnected) return;
      detailEl.innerHTML = detailHtml(data);
      drawDetail(data);
    } catch (error) {
      if (current !== requestId || !detailEl.isConnected) return;
      detailEl.innerHTML = `<div class="card"><div class="card-body"><div class="error-box">${escapeHtml(error.message)}</div></div></div>`;
    }
  };

  const drawDetail = (data) => {
    const history = data.history || [];
    const labels = history.map((row) => shortQuarter(row.label));
    if (history.length) {
      makeChart($("#stockHistoryChart"), {
        animationDuration: 500,
        grid: { left: 12, right: 52, top: 34, bottom: 12, containLabel: true },
        legend: { top: 0, left: 0, icon: "roundRect", itemWidth: 8, itemHeight: 8, textStyle: { color: C.muted, fontSize: 11 } },
        tooltip: {
          ...tooltipStyle,
          trigger: "axis",
          formatter: (params) => {
            const index = params[0].dataIndex;
            const row = history[index];
            const change = row.fund_count_qoq === null || row.fund_count_qoq === undefined
              ? (row.fund_count_new ? "新进" : "—")
              : `环比 ${row.fund_count_qoq > 0 ? "+" : ""}${Number(row.fund_count_qoq).toFixed(1)}%`;
            const valueChange = row.value_qoq === null || row.value_qoq === undefined
              ? (row.value_new ? "新进" : "—")
              : `环比 ${row.value_qoq > 0 ? "+" : ""}${Number(row.value_qoq).toFixed(1)}%`;
            return `<b>${row.label}</b><br/>前十大基金 <b>${fmtInt(row.fund_count)}</b> 只 · <b>${change}</b><br/>前十大市值 <b>${fmtYi(row.value)}</b> · <b>${valueChange}</b><br/>前十大/流通 <b>${row.crowding === null || row.crowding === undefined ? "—" : `${Number(row.crowding).toFixed(2)}%`}</b>`;
          },
        },
        xAxis: axisX({ data: labels }),
        yAxis: [
          axisY({ axisLabel: { color: C.dim, fontSize: 11, formatter: (value) => fmtInt(value) } }),
          axisY({ axisLabel: { color: C.dim, fontSize: 11, formatter: (value) => `${value}亿` }, splitLine: { show: false } }),
        ],
        series: [
          { name: "前十大基金数", type: "line", data: history.map((row) => row.fund_count), smooth: true, showSymbol: true, symbolSize: 5, lineStyle: { color: C.accent, width: 2 }, itemStyle: { color: C.accent }, areaStyle: { color: C.accentFade } },
          { name: "前十大市值", type: "bar", yAxisIndex: 1, data: history.map((row) => row.value), barMaxWidth: 18, itemStyle: { color: "rgba(227,180,103,.38)", borderRadius: [3, 3, 0, 0] } },
        ],
      });
    } else {
      $("#stockHistoryChart").innerHTML = '<div class="chart-empty">暂无历史数据</div>';
    }

    if (data.latest.crowding !== null && data.latest.crowding !== undefined) {
      gaugeChart($("#crowdGauge"), { value: Number(data.latest.crowding).toFixed(1), title: "前十大/流通" });
    } else {
      $("#crowdGauge").innerHTML = '<div class="chart-empty">暂无数据</div>';
    }

    const ratioRows = history.filter((row) => row.crowding !== null && row.crowding !== undefined);
    if (ratioRows.length > 1) {
      lineChart($("#ratioTrend"), {
        dates: ratioRows.map((row) => shortQuarter(row.label)),
        series: [{ name: "前十大/流通", data: ratioRows.map((row) => row.crowding), color: C.gold }],
        yFormatter: (v) => `${v}%`,
        legend: false,
      });
    }

    drawStockPriceRisk(data);

    $$("[data-peer]").forEach((row) => {
      row.addEventListener("click", () => {
        selected = row.dataset.peer;
        renderList();
        loadDetail(selected);
        history.replaceState(null, "", `#/stocks?code=${selected}&quarter=${quarter}`);
      });
    });
  };

  const search = debounce(() => {
    keyword = $("#stockSearch").value.trim();
    loadList();
  }, 250);
  $("#stockSearch").addEventListener("input", search);
  $("#stockIndustry").addEventListener("change", (event) => {
    industry = event.target.value;
    loadList();
  });
  const updateOrderButton = () => {
    const button = $("#stockOrderBtn");
    if (!button) return;
    const isChange = sort === "fund_count_delta" || sort === "value_delta";
    button.textContent = order === "desc" ? "降序" : "升序";
    button.title = isChange
      ? (order === "desc" ? "降序：从增加最多排到减少最多；点击切换升序" : "升序：从减少最多排到增加最多；点击切换降序")
      : (order === "desc" ? "降序：从高到低；点击切换升序" : "升序：从低到高；点击切换降序");
    button.classList.toggle("is-change", isChange);
  };
  $("#stockSort").addEventListener("change", (event) => {
    sort = event.target.value;
    order = "desc";
    updateOrderButton();
    loadList();
  });
  $("#stockOrderBtn").addEventListener("click", () => {
    order = order === "desc" ? "asc" : "desc";
    updateOrderButton();
    loadList();
  });
  $("#stockSort").value = sort;
  updateOrderButton();
  $("#stockQuarter").addEventListener("change", (event) => {
    quarter = event.target.value;
    selected = "";
    history.replaceState(null, "", `#/stocks?quarter=${quarter}`);
    loadList();
  });

  await loadList();
}
