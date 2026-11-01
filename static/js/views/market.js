import { api } from "../api.js";
import { C, barChart, donutChart, grad, lineChart, makeChart, palette, scatterChart, tooltipStyle, axisX, axisY } from "../charts.js";
import { addRecent, getLastQuarter, setLastQuarter } from "../store.js";
import { $, $$, debounce, deltaChip, escapeHtml, fmtInt, fmtPct, fmtYi, pageLoading, toast } from "../utils.js";

function colorMap(industries) {
  const map = new Map();
  industries.forEach((item, index) => map.set(item.name, palette[index % palette.length]));
  return map;
}

function kpiCards(data) {
  const k = data.kpis;
  return `
    <div class="kpi-grid">
      <div class="kpi-card">
        <div class="kpi-label">全市场基金 <span class="badge badge-dim">代码口径</span></div>
        <div class="kpi-value">${fmtInt(k.fund_total)}<small>只</small></div>
        <div class="kpi-sub">覆盖公募基金全部代码，含不同份额</div>
      </div>
      <div class="kpi-card">
        <div class="kpi-label">本季重仓股 ${data.partial ? '<span class="badge badge-gold">披露中</span>' : ""}</div>
        <div class="kpi-value">${fmtInt(k.stock_count)}<small>只</small></div>
        <div class="kpi-sub">基金持仓合计 ${fmtInt(k.fund_mentions)} 次 · 截至 ${data.as_of}</div>
      </div>
      <div class="kpi-card">
        <div class="kpi-label">公募重仓总市值</div>
        <div class="kpi-value">${fmtYi(k.total_value)}</div>
        <div class="kpi-sub">百亿级重仓股 ${k.big_count} 只</div>
      </div>
      <div class="kpi-card gold">
        <div class="kpi-label">千亿级重仓股</div>
        <div class="kpi-value">${fmtInt(k.hundred_count)}<small>只</small></div>
        <div class="kpi-sub">行业映射覆盖 ${k.industry_coverage ?? "—"}%</div>
      </div>
    </div>`;
}

export async function render(el, params, state) {
  el.innerHTML = pageLoading();
  const meta = state.meta || (await api.meta());
  if (!el.isConnected) return;
  state.meta = meta;
  const available = meta.quarters.filter((q) => q.available);
  const quarter = params.quarter || getLastQuarter() || meta.latest_quarter;
  let data;
  try {
    data = await api.market(quarter);
  } catch (error) {
    if (el.isConnected) el.innerHTML = `<div class="card"><div class="card-body"><div class="error-box">${escapeHtml(error.message)}</div></div></div>`;
    return;
  }
  if (!el.isConnected) return;
  setLastQuarter(data.quarter);
  state.marketQuarter = data.quarter;
  const colors = colorMap(data.industry.slice(0, 10));
  const maxFund = Math.max(...data.top_holdings.map((x) => x.fund_count || 0), 1);

  el.innerHTML = `
    <div class="page-head">
      <div>
        <div class="eyebrow">Market Pulse</div>
        <h1 class="page-title">公募持仓全景</h1>
        <p class="page-sub">从全市场季报持仓中还原公募资金的共识：谁在被抱团、哪些行业在加仓、基金经理的持仓在向哪里迁移。</p>
      </div>
      <div class="head-actions">
        <select class="select" id="quarterSelect">
          ${available.map((q) => `<option value="${q.quarter}" ${q.quarter === data.quarter ? "selected" : ""}>${q.label} · ${q.disclosure === "full" ? "全量" : "十大重仓"}</option>`).join("")}
        </select>
        <button class="btn" id="methodBtn">${'<svg class="icon"><use href="#i-info"/></svg>'}口径说明</button>
      </div>
    </div>

    <div class="callout teal" style="margin-bottom:16px">${escapeHtml(data.disclosure)}</div>

    ${kpiCards(data)}

    <div class="grid">
      <div class="card span-7">
        <div class="card-head">
          <div>
            <h3 class="card-title">公募抱团榜 <span class="badge badge-teal">Top 18</span></h3>
            <p class="card-sub">按持有该股的基金数量排序，点击任意个股进入持仓透视</p>
          </div>
          <div class="segmented" id="lbMetric">
            <button class="seg-btn active" data-metric="fund_count">持有基金数</button>
            <button class="seg-btn" data-metric="value">持仓市值</button>
          </div>
        </div>
        <div class="card-body">
          <div id="leaderChart" class="chart chart-lg"></div>
          <div class="card-note">“持有基金数”统计将该股列入前十大重仓的基金数量，全量披露报告期（Q2/Q4）会显著高于季报口径。</div>
        </div>
      </div>

      <div class="card span-5">
        <div class="card-head">
          <div>
            <h3 class="card-title">行业配置</h3>
            <p class="card-sub">按申万一级行业汇总公募重仓市值占比 · ${data.quarter_label}</p>
          </div>
        </div>
        <div class="card-body">
          <div id="industryChart" class="chart" style="height:238px"></div>
          <div class="legend-list mt-8" id="industryLegend"></div>
        </div>
      </div>

      <div class="card span-12">
        <div class="card-head">
          <div>
            <h3 class="card-title">重仓股共识图谱</h3>
            <p class="card-sub">横轴为持有基金数，纵轴为持有基金数同比增减。气泡越大，公募持仓市值越高；右上角代表“共识仍在扩张”。</p>
          </div>
          <div class="card-actions">
            <input class="input" id="bubbleSearch" placeholder="搜索个股" style="width:140px">
            <select class="select" id="bubbleIndustry"><option value="">全部行业</option></select>
          </div>
        </div>
        <div class="card-body">
          <div id="bubbleChart" class="chart chart-lg"></div>
          <div class="card-note">同比口径用于规避 Q2/Q4 全量披露带来的计数跳变；气泡颜色代表申万一级行业。</div>
        </div>
      </div>

      <div class="card span-5">
        <div class="card-head">
          <div>
            <h3 class="card-title">基金公司管理规模</h3>
            <p class="card-sub">Top 12 · 全部管理规模（亿元）</p>
          </div>
        </div>
        <div class="card-body"><div id="companyChart" class="chart" style="height:330px"></div></div>
      </div>

      <div class="card span-7">
        <div class="card-head">
          <div>
            <h3 class="card-title">共识度变化榜</h3>
            <p class="card-sub">前十大口径 · 基金数环比上一季度 · 按增减数量排序</p>
          </div>
        </div>
        <div class="card-body">
          <div class="mover-panels" id="moversWrap"></div>
          <div class="card-note">环比为相邻报告期对比，Q2/Q4 已按逐基金还原为前十大口径（与重仓股透视一致）；上方抱团榜为全量披露口径，两者基金数不可直接比较。</div>
        </div>
      </div>

      <div class="card span-12">
        <div class="card-head">
          <div>
            <h3 class="card-title">行业持仓占比趋势</h3>
            <p class="card-sub">最近 6 个报告期 · 申万一级行业 · 重仓市值占比</p>
          </div>
          <span class="badge badge-dim">同比口径可比</span>
        </div>
        <div class="card-body"><div id="trendChart" class="chart chart-lg"></div></div>
      </div>

      <div class="card span-12">
        <div class="card-head">
          <div>
            <h3 class="card-title">全市场持有人结构</h3>
            <p class="card-sub">${data.holder_market?.latest?.date || "—"} · 半年披露 · 全市场公募基金合计</p>
          </div>
          <span class="badge badge-gold">内部持有 ${data.holder_market?.latest?.internal ?? "—"}%</span>
        </div>
        <div class="card-body">
          ${data.holder_market?.dates?.length ? `
          <div class="holder-market-layout">
            <div class="holder-market-kpis" id="holderMarketKpis"></div>
            <div id="marketHolderChart" class="chart" style="height:280px"></div>
          </div>
          <div id="marketHolderTrend" class="callout teal mt-12" style="display:none"></div>
          <div class="card-note">机构与个人为同一口径下的两类持有人，合计约 99%，其余为未披露/未归类份额；内部持有为单独披露的明细指标（图中使用右轴），不与机构、个人相加，也不等同于基金公司自有资金自购。</div>
          ` : '<div class="empty">暂无全市场持有人结构数据</div>'}
        </div>
      </div>
    </div>

    <div class="note mt-16">数据 ${data.fetched_at || data.updated_at} 抓取 · 来源：天天基金 / 东方财富数据中心 · 全市场聚合覆盖约 ${fmtInt(data.kpis.stock_count)} 只重仓股 · 仅展示前十大重仓口径。</div>
  `;

  const industrySelect = $("#bubbleIndustry");
  const industries = [...new Set(data.bubble.map((x) => x.industry))].sort();
  industries.forEach((name) => {
    const opt = document.createElement("option");
    opt.value = name;
    opt.textContent = name;
    industrySelect.appendChild(opt);
  });

  const drawLeaderboard = (metric) => {
    const items = [...data.top_holdings]
      .sort((a, b) => (b[metric] || 0) - (a[metric] || 0))
      .slice(0, 18);
    const labels = items.map((x) => x.name);
    const values = items.map((x) => x[metric]);
    makeChart($("#leaderChart"), {
      animationDuration: 550,
      grid: { left: 8, right: 60, top: 8, bottom: 8, containLabel: true },
      tooltip: {
        ...tooltipStyle,
        trigger: "axis",
        axisPointer: { type: "shadow" },
        formatter: (params) => {
          const item = items[params[0].dataIndex];
          return `<b>${escapeHtml(item.name)}</b> <span style="color:${C.muted}">${escapeHtml(item.code)}</span><br/>
            持有基金 <b>${item.fund_count}</b> 只 · 同比 ${item.fund_count_yoy === null ? "—" : `${item.fund_count_yoy > 0 ? "+" : ""}${item.fund_count_yoy}%`}<br/>
            持仓市值 <b>${fmtYi(item.value)}</b><br/>
            占流通股 <b>${item.free_ratio ?? "—"}%</b> · ${escapeHtml(item.industry)}`;
        },
      },
      xAxis: axisY({ axisLabel: { color: C.dim, fontSize: 11, formatter: (v) => metric === "value" ? `${v}亿` : v } }),
      yAxis: axisX({ data: labels, inverse: true, axisLabel: { color: C.muted, fontSize: 11 } }),
      series: [
        {
          type: "bar",
          data: values.map((v, i) => ({
            value: v,
            itemStyle: { color: i === 0 ? grad(C.gold, C.goldFade, false) : grad(C.accent, C.accentFade, false) },
          })),
          barMaxWidth: 11,
          itemStyle: { borderRadius: 4 },
          label: {
            show: true,
            position: "right",
            color: C.muted,
            fontSize: 11,
            formatter: ({ value }) => (metric === "value" ? `${value}亿` : `${value}`),
          },
        },
      ],
    }, (p) => {
      const item = items[p.dataIndex];
      if (item) navigateStock(item.code, data.quarter);
    });
  };

  const drawIndustry = () => {
    const items = data.industry.slice(0, 10);
    donutChart($("#industryChart"), {
      items,
      centerLabel: "前十大行业",
      centerValue: `${items.reduce((sum, x) => sum + (x.share || 0), 0).toFixed(0)}%`,
      colors: items.map((x) => colors.get(x.name) || palette[items.indexOf(x) % palette.length]),
    });
    $("#industryLegend").innerHTML = items
      .map((item) => `<div class="legend-row">
        <span class="legend-dot" style="background:${colors.get(item.name) || C.accent}"></span>
        <span class="legend-name">${escapeHtml(item.name)}</span>
        <span class="legend-val">${item.share.toFixed(1)}%</span>
        <span class="legend-delta ${item.delta > 0 ? "up" : item.delta < 0 ? "down" : "dim"}">${item.delta === null ? "" : `${item.delta > 0 ? "+" : ""}${item.delta.toFixed(1)}pp`}</span>
      </div>`)
      .join("");
  };

  let bubbleIndustry = "";
  let bubbleKeyword = "";
  const drawBubble = () => {
    const filtered = data.bubble.filter((item) => {
      if (bubbleIndustry && item.industry !== bubbleIndustry) return false;
      if (bubbleKeyword && !`${item.name}${item.code}`.toLowerCase().includes(bubbleKeyword.toLowerCase())) return false;
      return true;
    });
    const points = filtered.map((item) => ({
      name: item.name,
      code: item.code,
      value: [item.fund_count, item.fund_count_delta ?? 0, item.value, item.free_ratio ?? "—"],
      delta: item.fund_count_delta,
      yoy: item.fund_count_yoy,
      color: item.fund_count_delta === null || item.fund_count_delta === undefined
        ? C.dim
        : (colors.get(item.industry) || C.dim),
      industry: item.industry,
    }));
    scatterChart($("#bubbleChart"), {
      data: points,
      xName: "持有基金数",
      yName: "基金数同比增减（只）",
      onClick: (p) => navigateStock(p.data.code, data.quarter),
    });
  };

  const drawCompanies = () => {
    const items = data.companies.slice(0, 12).map((c) => ({
      ...c,
      short: (c.company || "").replace("基金管理有限公司", "").replace("基金管理股份有限公司", ""),
    }));
    barChart($("#companyChart"), {
      labels: items.map((x) => x.short),
      values: items.map((x) => x.aum),
      color: C.blue,
      formatter: (v) => `${Number(v).toFixed(0)}亿`,
    });
  };

  const movers = data.movers || {};
  const moversHtml = (list, side) => {
    const title = side === "up" ? "共识扩张" : "共识收缩";
    const head = `<div class="mover-panel-head">${title}${movers.prev_quarter_label ? `<span class="dim">环比 ${escapeHtml(movers.prev_quarter_label)}</span>` : ""}</div>`;
    if (!list?.length) return `<div class="mover-panel">${head}<div class="empty tiny">暂无数据</div></div>`;
    return `<div class="mover-panel">${head}
      <div class="mover-table">
        <div class="mover-tr mover-th"><span>个股</span><span>今年</span><span>去年</span><span>增减</span><span>幅度</span></div>
        ${list.map((item) => `<div class="mover-tr clickable" data-stock="${item.code}">
          <span class="mover-name">${escapeHtml(item.name)} <span class="tiny dim">${escapeHtml(item.industry)}</span></span>
          <span class="mover-num">${fmtInt(item.fund_count)}</span>
          <span class="mover-num dim">${fmtInt(item.prev_count)}</span>
          <span class="mover-num ${side === "up" ? "up" : "down"}">${item.delta > 0 ? "+" : ""}${fmtInt(item.delta)}</span>
          <span class="mover-num ${side === "up" ? "up" : "down"}">${item.change > 0 ? "+" : ""}${item.change}%</span>
        </div>`).join("")}
      </div>
    </div>`;
  };
  if (!movers.available) {
    $("#moversWrap").innerHTML = `<div class="empty">${escapeHtml(movers.prev_quarter_label || "上一报告期")} 的前十大聚合尚未构建，暂无法计算环比</div>`;
  } else {
    $("#moversWrap").innerHTML = `${moversHtml(movers.up, "up")}${moversHtml(movers.down, "down")}`;
    $$("#moversWrap [data-stock]").forEach((row) => {
      row.addEventListener("click", () => navigateStock(row.dataset.stock, data.quarter));
    });
  }

  const drawTrend = () => {
    const series = data.industry_trend.series;
    if (!series.length) {
      $("#trendChart").innerHTML = '<div class="chart-empty">暂无趋势数据</div>';
      return;
    }
    lineChart($("#trendChart"), {
      dates: data.industry_trend.quarters,
      series: series.map((item) => ({ name: item.name, data: item.values })),
      yFormatter: (v) => `${v}%`,
      legend: true,
    });
  };

  const drawHolderMarket = () => {
    const hm = data.holder_market;
    if (!hm?.dates?.length) return;
    const latest = hm.latest || {};
    const prev = hm.prev || {};
    const pp = (now, before) => {
      if (now === null || now === undefined || before === null || before === undefined) return '<span class="dim">—</span>';
      const delta = now - before;
      return `<span class="${delta > 0 ? "up" : delta < 0 ? "down" : "dim"}">${delta > 0 ? "+" : ""}${delta.toFixed(2)}pp</span>`;
    };
    $("#holderMarketKpis").innerHTML = `
      <div class="stat"><div class="stat-label">机构持有</div><div class="stat-value">${latest.institution ?? "—"}%</div><div class="tiny">${pp(latest.institution, prev.institution)}</div></div>
      <div class="stat"><div class="stat-label">个人持有</div><div class="stat-value">${latest.individual ?? "—"}%</div><div class="tiny">${pp(latest.individual, prev.individual)}</div></div>
      <div class="stat"><div class="stat-label">内部持有</div><div class="stat-value" style="color:var(--gold)">${latest.internal ?? "—"}%</div><div class="tiny">${pp(latest.internal, prev.internal)}</div></div>
      <div class="stat"><div class="stat-label">基金家数</div><div class="stat-value">${fmtInt(latest.fund_count)}</div><div class="tiny">${(latest.total_shares / 10000).toFixed(1)} 万亿份</div></div>
    `;
    const start = Math.max(0, hm.dates.length - 12);
    const dates = hm.dates.slice(start).map((d) => d.slice(2, 7));
    const internal = hm.internal.slice(start);
    const maxInternal = Math.max(...internal.filter((v) => v !== null), 1);
    const years = ((new Date(hm.dates[hm.dates.length - 1]) - new Date(hm.dates[start])) / (365.25 * 24 * 3600 * 1000)).toFixed(0);
    const instDelta = (hm.institution[hm.dates.length - 1] ?? 0) - (hm.institution[start] ?? 0);
    const internalDelta = (hm.internal[hm.dates.length - 1] ?? 0) - (hm.internal[start] ?? 0);
    const trendNode = $("#marketHolderTrend");
    if (trendNode) {
      trendNode.style.display = "block";
      trendNode.innerHTML = `近 ${years} 年：机构持有比例 ${hm.institution[start] ?? "—"}% → ${hm.institution[hm.dates.length - 1] ?? "—"}%（${instDelta >= 0 ? "+" : ""}${instDelta.toFixed(2)}pp），内部持有 ${hm.internal[start] ?? "—"}% → ${hm.internal[hm.dates.length - 1] ?? "—"}%（${internalDelta >= 0 ? "+" : ""}${internalDelta.toFixed(2)}pp）。`;
    }
    makeChart($("#marketHolderChart"), {
      animationDuration: 500,
      grid: { left: 10, right: 48, top: 34, bottom: 10, containLabel: true },
      legend: { top: 0, left: 0, icon: "roundRect", itemWidth: 8, itemHeight: 8, textStyle: { color: C.muted, fontSize: 11 } },
      tooltip: {
        ...tooltipStyle,
        trigger: "axis",
        formatter: (params) => {
          const index = params[0].dataIndex;
          const date = hm.dates[start + index];
          return `<div style="color:${C.muted};font-size:11px;margin-bottom:3px">${date}</div>
            机构 <b>${hm.institution[start + index] ?? "—"}%</b><br/>
            个人 <b>${hm.individual[start + index] ?? "—"}%</b><br/>
            内部持有 <b style="color:${C.gold}">${hm.internal[start + index] ?? "—"}%</b>`;
        },
      },
      xAxis: axisX({ data: dates }),
      yAxis: [
        axisY({ min: 0, max: 100, axisLabel: { color: C.dim, fontSize: 11, formatter: "{value}%" } }),
        axisY({ min: 0, max: Math.max(2, Math.ceil(maxInternal * 1.6 * 10) / 10), axisLabel: { color: C.dim, fontSize: 11, formatter: "{value}%" }, splitLine: { show: false } }),
      ],
      series: [
        { name: "机构", type: "line", data: hm.institution.slice(start), smooth: true, showSymbol: false, lineStyle: { color: C.accent, width: 2 }, itemStyle: { color: C.accent } },
        { name: "个人", type: "line", data: hm.individual.slice(start), smooth: true, showSymbol: false, lineStyle: { color: C.blue, width: 1.4, type: "dashed" }, itemStyle: { color: C.blue } },
        { name: "内部持有", type: "line", yAxisIndex: 1, data: internal, smooth: true, showSymbol: false, lineStyle: { color: C.gold, width: 1.8 }, itemStyle: { color: C.gold } },
      ],
    });
  };

  drawLeaderboard("fund_count");
  drawIndustry();
  drawBubble();
  drawCompanies();
  drawTrend();
  drawHolderMarket();

  $$("#lbMetric .seg-btn").forEach((btn) => {
    btn.addEventListener("click", () => {
      $$("#lbMetric .seg-btn").forEach((b) => b.classList.toggle("active", b === btn));
      drawLeaderboard(btn.dataset.metric);
    });
  });
  $("#bubbleIndustry").addEventListener("change", (event) => {
    bubbleIndustry = event.target.value;
    drawBubble();
  });
  const onBubbleSearch = debounce((value) => {
    bubbleKeyword = value.trim();
    drawBubble();
  }, 160);
  $("#bubbleSearch").addEventListener("input", (event) => onBubbleSearch(event.target.value));
  $("#quarterSelect").addEventListener("change", (event) => {
    navigate(`#/market?quarter=${event.target.value}`);
  });
  $("#methodBtn").addEventListener("click", () => showMethod(data));

  function navigate(hash) {
    location.hash = hash;
  }
  function navigateStock(code, quarter) {
    location.hash = `#/stocks?code=${code}&quarter=${quarter}`;
  }
}

function showMethod(data) {
  import("../utils.js").then(({ openModal }) => {
    openModal("数据口径说明", `
      <div class="about-text">
        <p><strong>当前报告期：</strong>${data.quarter_label}（${data.as_of}）。${data.disclosure}</p>
        <p><strong>基金档案口径：</strong>单只基金的持仓、行业配置、规模与持有人数据来自天天基金 F10 与基金定期报告，统一采用前十大重仓股口径。</p>
        <p><strong>全市场聚合：</strong>来自东方财富数据中心“基金持仓”，覆盖所有已披露季报/中报/年报的基金。Q2、Q4 为中报/年报全量持仓，股票数量和持有基金数会显著高于 Q1、Q3。</p>
        <p><strong>比较方式：</strong>因此跨期比较默认采用同比（与上年同一报告期）而非环比；单只基金的持仓变动仍使用相邻两期前十大对比。</p>
        <p><strong>两种口径：</strong>本页 Q2/Q4 使用中报/年报全量持仓，Q1/Q3 使用季报前十大；重仓股透视页则统一按前十大聚合（Q2/Q4 逐基金还原），因此两处基金数不可直接比较。</p>
        <p><strong>行业分类：</strong>申万一级行业（东方财富 F10），通过个股所属行业映射到基金持仓；部分新股/退市股可能暂未映射。</p>
        <p><strong>免责声明：</strong>季报存在披露滞后，所有数据仅用于研究，不构成投资建议。</p>
      </div>`);
  });
}
