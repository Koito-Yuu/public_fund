import { api } from "../api.js";
import { C, disposeCharts, heatmapChart, makeChart, palette, tooltipStyle } from "../charts.js";
import { getPortfolio, setPortfolio } from "../store.js";
import {
  $, $$, debounce, escapeHtml, fmtPct, fmtYi, openModal, pageLoading, toast, tone,
} from "../utils.js";

let outsideClickBound = false;

const PRESETS = [
  {
    name: "宽基核心",
    items: [
      { code: "510300", name: "沪深300ETF", weight: 40 },
      { code: "510500", name: "中证500ETF", weight: 30 },
      { code: "588000", name: "科创50ETF", weight: 30 },
    ],
  },
  {
    name: "红利防御",
    items: [
      { code: "512890", name: "红利低波ETF", weight: 50 },
      { code: "510300", name: "沪深300ETF", weight: 50 },
    ],
  },
  {
    name: "均衡四基金",
    items: [
      { code: "510300", name: "沪深300ETF", weight: 30 },
      { code: "512890", name: "红利低波ETF", weight: 30 },
      { code: "110022", name: "易方达消费行业", weight: 20 },
      { code: "163406", name: "兴全合润", weight: 20 },
    ],
  },
];

const shortName = (name) => (name || "").length > 5 ? `${name.slice(0, 4)}…` : name;

const toReturnSeries = (series) => (series || []).map(([day, value]) => [day, Number((value - 100).toFixed(2))]);

function builderHtml(items, mode) {
  if (!items.length) {
    return `<div class="empty" style="padding:26px">还没有选择基金。搜索添加，或从下方载入一个示例组合。</div>`;
  }
  return items.map((item, index) => `
    <div class="pf-row" data-index="${index}">
      <div class="pf-fund"><strong>${escapeHtml(item.name || item.code)}</strong><span>${item.code}</span></div>
      ${mode === "compare"
        ? `<div class="dim mono small" style="text-align:right">等权 ${(100 / items.length).toFixed(1)}%</div>`
        : `<div class="pf-weight"><input type="number" min="0" max="100" step="1" value="${item.weight ?? 0}" data-weight="${index}"></div>`}
      <button class="icon-btn" style="width:30px;height:30px" data-remove="${index}" title="移除"><svg class="icon" style="width:15px;height:15px"><use href="#i-close"/></svg></button>
    </div>`).join("");
}

function insightsHtml(insights) {
  return `<div class="insights">${insights.map((item) => `
    <div class="insight ${item.level}">
      <span class="insight-dot"></span>
      <div><div class="insight-title">${escapeHtml(item.title)}</div><div class="insight-text">${escapeHtml(item.text)}</div></div>
    </div>`).join("")}</div>`;
}

function holdingsTable(result) {
  const stocks = result.holdings.stocks || [];
  if (!stocks.length) return '<div class="empty">所选基金暂无股票持仓，无法穿透。</div>';
  const maxWeight = Math.max(...stocks.map((s) => s.weight || 0), 0.01);
  return `<div class="data-table-wrap">
    <table class="data-table">
      <thead><tr><th>股票</th><th>行业</th><th class="num">组合权重</th><th class="num">涉及基金</th><th class="num">PE</th><th class="num">市值</th></tr></thead>
      <tbody>
        ${stocks.slice(0, 20).map((stock) => `<tr class="clickable" data-stock="${stock.code}">
          <td><div class="name-cell"><strong>${escapeHtml(stock.name)}</strong><span>${stock.code}</span></div></td>
          <td><span class="badge badge-dim">${escapeHtml(stock.industry || "—")}</span></td>
          <td class="num">
            <div style="display:flex;align-items:center;justify-content:flex-end;gap:8px">
              <span class="weight-bar" style="width:50px"><i style="width:${(stock.weight / maxWeight) * 100}%"></i></span>
              <span>${Number(stock.weight).toFixed(2)}%</span>
            </div>
          </td>
          <td class="num">${stock.fund_count}</td>
          <td class="num">${stock.pe ? Number(stock.pe).toFixed(1) : "—"}</td>
          <td class="num">${stock.mktcap ? fmtYi(stock.mktcap) : "—"}</td>
        </tr>`).join("")}
      </tbody>
    </table>
  </div>
  <div class="note mt-8">穿透权重 = 各基金权重 × 个股占净值比例；仅覆盖前十大重仓股，已披露敞口合计 ${result.holdings.total_weight ?? "—"}%。</div>`;
}

function overlapTable(result) {
  const { codes, names, matrix } = result.overlap;
  if (!codes.length || !matrix.length) return '<div class="empty">需要至少两只含股票持仓的基金才能计算重叠度。</div>';
  return `<div class="hm-wrap"><table class="hm-table">
    <thead><tr><th></th>${names.map((n) => `<th title="${escapeHtml(n)}">${escapeHtml(shortName(n))}</th>`).join("")}</tr></thead>
    <tbody>
      ${names.map((name, i) => `<tr><th title="${escapeHtml(name)}">${escapeHtml(shortName(name))}</th>
        ${matrix[i].map((value, j) => {
          if (i === j) return '<td class="corner dim">—</td>';
          const alpha = Math.min(0.5, (Number(value) || 0) / 60 * 0.5);
          return `<td style="background:rgba(227,180,103,${alpha})">${value === null ? "—" : `${Number(value).toFixed(1)}`}</td>`;
        }).join("")}
      </tr>`).join("")}
    </tbody>
  </table></div>
  <div class="matrix-note">数值为前十大重仓的权重重叠度（%），越高代表底层股票重合越多。</div>`;
}


function backtestHtml(data, key) {
  const bt = data.backtest;
  if (!bt || !bt.strategies || !Object.keys(bt.strategies).length) {
    return `<div class="card mt-16"><div class="card-body"><div class="empty">${escapeHtml(bt?.note || "没有可回测的净值序列")}</div></div></div>`;
  }
  const keys = ["none", "monthly", "quarterly", "annual"].filter((item) => bt.strategies[item]);
  const selected = keys.includes(key) ? key : keys[0];
  return `<div class="card mt-16" id="backtestCard">
    <div class="card-head">
      <div><h3 class="card-title">组合回测</h3><p class="card-sub">累计收益与回撤 · 基准沪深300 · 单边 ${bt.cost_bps}bp 调仓成本 · 与上方日度再平衡曲线口径不同</p></div>
      <div class="card-actions">
        <span class="badge badge-dim">${bt.start} 至 ${bt.end}</span>
        <select class="select" id="backtestStrategy">
          ${keys.map((item) => `<option value="${item}" ${item === selected ? "selected" : ""}>${bt.strategies[item].label}</option>`).join("")}
        </select>
      </div>
    </div>
    <div class="card-body">
      <div class="stats-strip backtest-kpis" id="backtestKpis"></div>
      <div id="backtestChart" class="chart" style="height:360px"></div>
      <div class="backtest-risk-line" id="backtestRisk"></div>
      <div class="card-note" id="backtestNote"></div>
    </div>
  </div>
  <div class="grid mt-16 backtest-compare-grid">
    <div class="card span-7">
      <div class="card-head"><div><h3 class="card-title">策略对比</h3><p class="card-sub">同一组基金与区间，仅改变再平衡频率</p></div></div>
      <div class="card-body" id="backtestCompare"></div>
    </div>
    <div class="card span-5">
      <div class="card-head"><div><h3 class="card-title">年度收益</h3><p class="card-sub">组合策略 vs 沪深300</p></div></div>
      <div class="card-body"><div id="backtestYearly" class="chart" style="height:240px"></div></div>
    </div>
  </div>`;
}

function drawBacktestYearly(data, strategy) {
  const el = $("#backtestYearly");
  if (!el) return;
  const strategyYears = strategy.yearly || [];
  const benchmarkYears = data.backtest?.benchmark?.yearly || [];
  const yearMap = new Map(strategyYears.map((item) => [item.year, item]));
  const benchMap = new Map(benchmarkYears.map((item) => [item.year, item]));
  const years = [...new Set([...strategyYears.map((item) => item.year), ...benchmarkYears.map((item) => item.year)])].sort();
  if (!years.length) {
    el.innerHTML = '<div class="chart-empty">区间不足一个完整年度</div>';
    return;
  }
  makeChart(el, {
    animationDuration: 500,
    grid: { left: 8, right: 20, top: 26, bottom: 8, containLabel: true },
    legend: { top: 0, left: 0, icon: "roundRect", itemWidth: 8, itemHeight: 8, textStyle: { color: C.muted, fontSize: 11 } },
    tooltip: {
      ...tooltipStyle,
      trigger: "axis",
      formatter: (params) => {
        const year = params[0].axisValue;
        return `<b>${year} 年</b><br/>${params.map((item) => `${item.marker} ${item.seriesName} <b>${item.value === null || item.value === undefined ? "—" : `${item.value > 0 ? "+" : ""}${Number(item.value).toFixed(2)}%`}</b>`).join("<br/>")}`;
      },
    },
    xAxis: { type: "category", data: years, axisLine: { lineStyle: { color: C.grid } }, axisTick: { show: false }, axisLabel: { color: C.dim, fontSize: 11 } },
    yAxis: { type: "value", axisLine: { show: false }, axisTick: { show: false }, axisLabel: { color: C.dim, fontSize: 11, formatter: "{value}%" }, splitLine: { lineStyle: { color: C.grid, type: "dashed" } } },
    series: [
      { name: "组合", type: "bar", barMaxWidth: 24, data: years.map((year) => yearMap.get(year)?.portfolio ?? null), itemStyle: { color: C.accent, borderRadius: [3, 3, 0, 0] } },
      { name: "沪深300", type: "bar", barMaxWidth: 24, data: years.map((year) => benchMap.get(year)?.portfolio ?? null), itemStyle: { color: C.gold, borderRadius: [3, 3, 0, 0], opacity: 0.72 } },
    ],
  });
}

function drawBacktest(data, key) {
  const bt = data.backtest;
  if (!bt || !bt.strategies || !Object.keys(bt.strategies).length) return;
  const keys = ["none", "monthly", "quarterly", "annual"].filter((item) => bt.strategies[item]);
  const selected = keys.includes(key) ? key : keys[0];
  const strategy = bt.strategies[selected];
  const metrics = strategy.metrics || {};
  const risk = strategy.risk || {};
  const select = $("#backtestStrategy");
  if (select) select.value = selected;
  const kpis = [
    ["区间收益", fmtPct(metrics.total_return), tone(metrics.total_return)],
    ["年化收益", fmtPct(metrics.annual_return), tone(metrics.annual_return)],
    ["年化波动", fmtPct(metrics.volatility, 2, false), ""],
    ["夏普比率", metrics.sharpe ?? "—", "num"],
    ["最大回撤", fmtPct(metrics.max_drawdown), "down"],
    ["卡玛比率", metrics.calmar ?? "—", "num"],
    ["年化超额", fmtPct(risk.excess_annual), tone(risk.excess_annual)],
    ["信息比率", risk.information_ratio ?? "—", "num"],
  ];
  $("#backtestKpis").innerHTML = kpis.map(([label, value, cls]) => `<div class="stat"><div class="stat-label">${label}</div><div class="stat-value ${cls}">${value}</div></div>`).join("");
  const riskLine = $("#backtestRisk");
  if (riskLine) {
    riskLine.innerHTML = [
      ["β", risk.beta ?? "—"],
      ["α（年化）", risk.alpha === null || risk.alpha === undefined ? "—" : fmtPct(risk.alpha)],
      ["跟踪误差", fmtPct(risk.tracking_error, 2, false)],
      ["下行波动", fmtPct(risk.downside_deviation, 2, false)],
      ["索提诺", risk.sortino ?? "—"],
      ["相关性", risk.correlation ?? "—"],
    ].map(([label, value]) => `<span>${label} <b>${value}</b></span>`).join("");
  }
  const rows = keys.map((item) => {
    const s = bt.strategies[item];
    const m = s.metrics || {};
    const r = s.risk || {};
    return `<tr data-bt-key="${item}" class="clickable ${item === selected ? "bt-active" : ""}">
      <td>${escapeHtml(s.label)}${item === selected ? ' <span class="badge badge-teal">当前</span>' : ""}</td>
      <td class="num ${tone(m.total_return)}">${fmtPct(m.total_return)}</td>
      <td class="num ${tone(m.annual_return)}">${fmtPct(m.annual_return)}</td>
      <td class="num">${fmtPct(m.volatility, 2, false)}</td>
      <td class="num">${m.sharpe ?? "—"}</td>
      <td class="num down">${fmtPct(m.max_drawdown)}</td>
      <td class="num ${tone(r.excess_annual)}">${fmtPct(r.excess_annual)}</td>
    </tr>`;
  }).join("");
  const names = new Map((data.funds || []).map((fund) => [fund.code, fund.name]));
  const contributions = (bt.contributions || []).map((item) => `<div class="bt-contrib-row">
    <span class="grow">${escapeHtml(names.get(item.code) || item.code)}</span>
    <span class="mono">${item.weight}%</span>
    <span class="mono ${tone(item.return)}">${fmtPct(item.return)}</span>
    <span class="mono ${tone(item.contribution)}">${fmtPct(item.contribution)}</span>
  </div>`).join("");
  $("#backtestCompare").innerHTML = `
    <div class="data-table-wrap"><table class="data-table backtest-table">
      <thead><tr><th>策略</th><th class="num">区间</th><th class="num">年化</th><th class="num">波动</th><th class="num">夏普</th><th class="num">最大回撤</th><th class="num">超额年化</th></tr></thead>
      <tbody>${rows}</tbody>
    </table></div>
    <div class="related-title mt-12">收益贡献 · 不再平衡策略</div>
    <div class="bt-contrib-head"><span class="grow">基金</span><span>权重</span><span>区间收益</span><span>贡献</span></div>
    <div class="bt-contrib">${contributions || '<div class="dim small">暂无贡献数据</div>'}</div>
    <div class="note mt-8">贡献 = 初始权重 × 区间收益，合计约等于不再平衡组合的区间收益；调仓策略会改变贡献结构。</div>`;
  const note = $("#backtestNote");
  if (note) note.textContent = `${bt.note} 回测区间 ${bt.start} 至 ${bt.end}，共 ${bt.days} 个共同交易日；${strategy.label}期间调仓 ${strategy.rebalances} 次；年度收益的首尾年份为区间内不完整年度。历史回测不代表未来。`;
  const points = (strategy.points || []).map(([day, value]) => [day, Number((value - 100).toFixed(2))]);
  const benchmark = (bt.benchmark?.points || []).map(([day, value]) => [day, Number((value - 100).toFixed(2))]);
  const drawdown = strategy.drawdown || [];
  const ddValues = drawdown.map(([, value]) => Number(value)).filter((value) => Number.isFinite(value));
  const axisMin = ddValues.length ? Math.max(-100, Math.floor(Math.min(...ddValues) * 1.2 / 5) * 5) : -10;
  const hasBenchmark = benchmark.length > 0;
  makeChart($("#backtestChart"), {
    animationDuration: 500,
    grid: [
      { left: 12, right: 54, top: 34, height: "55%", containLabel: true },
      { left: 12, right: 54, top: "72%", height: "20%", containLabel: true },
    ],
    legend: { top: 0, left: 0, icon: "roundRect", itemWidth: 8, itemHeight: 8, textStyle: { color: C.muted, fontSize: 11 }, data: ["组合", ...(hasBenchmark ? ["沪深300"] : []), "回撤"] },
    tooltip: {
      ...tooltipStyle,
      trigger: "axis",
      axisPointer: { link: [{ xAxisIndex: "all" }], lineStyle: { color: C.crosshair, type: "dashed" } },
      formatter: (params) => {
        if (!params.length) return "";
        let html = `<div style="color:${C.muted};font-size:11px;margin-bottom:4px">${params[0].axisValueLabel}</div>`;
        params.forEach((item) => {
          if (item.value === null || item.value === undefined) return;
          const value = Number(item.value[1]);
          html += item.seriesName === "回撤"
            ? `<div style="margin-top:3px">回撤 <b style="color:${C.up}">${value.toFixed(2)}%</b></div>`
            : `<div>${item.seriesName} <b style="color:${value >= 0 ? C.up : C.down}">${value >= 0 ? "+" : ""}${value.toFixed(2)}%</b></div>`;
        });
        return html;
      },
    },
    axisPointer: { link: [{ xAxisIndex: "all" }] },
    xAxis: [
      { type: "time", axisLine: { lineStyle: { color: C.grid } }, axisTick: { show: false }, axisLabel: { show: false } },
      { type: "time", gridIndex: 1, axisLine: { lineStyle: { color: C.grid } }, axisTick: { show: false }, axisLabel: { color: C.dim, fontSize: 10 } },
    ],
    yAxis: [
      { type: "value", scale: true, axisLabel: { color: C.dim, fontSize: 11, formatter: "{value}%" }, splitLine: { lineStyle: { color: C.grid, type: "dashed" } } },
      { type: "value", gridIndex: 1, max: 0, min: axisMin, splitNumber: 2, axisLabel: { color: C.dim, fontSize: 11, formatter: "{value}%" }, splitLine: { show: false } },
    ],
    series: [
      { name: "组合", type: "line", data: points, showSymbol: false, smooth: true, lineStyle: { color: C.accent, width: 2.2 }, itemStyle: { color: C.accent }, areaStyle: { color: C.accentFade }, z: 3 },
      ...(hasBenchmark ? [{ name: "沪深300", type: "line", data: benchmark, showSymbol: false, smooth: true, lineStyle: { color: C.gold, width: 1.3, type: "dashed" }, itemStyle: { color: C.gold }, z: 2 }] : []),
      { name: "回撤", type: "line", xAxisIndex: 1, yAxisIndex: 1, data: drawdown, showSymbol: false, lineStyle: { color: "rgba(242,85,106,.75)", width: 1.2 }, areaStyle: { color: "rgba(242,85,106,.16)" }, z: 1 },
    ],
  });
  drawBacktestYearly(data, strategy);
  $$("#backtestCompare [data-bt-key]").forEach((row) => {
    row.addEventListener("click", () => {
      const picker = $("#backtestStrategy");
      if (picker) {
        picker.value = row.dataset.btKey;
        picker.dispatchEvent(new Event("change"));
      }
    });
  });
}

export async function render(el, params) {
  let items = getPortfolio();
  let mode = params.mode === "compare"
    ? "compare"
    : (sessionStorage.getItem("fundscope.pfMode") || "diagnosis");
  let span = params.span || sessionStorage.getItem("fundscope.pfSpan") || "3y";
  let result = null;
  let requestId = 0;
  let savedPortfolios = [];
  let backtestKey = sessionStorage.getItem("fundscope.pfBacktest") || "quarterly";

  el.innerHTML = `
    <div class="page-head">
      <div>
        <div class="eyebrow">Portfolio Lab</div>
        <h1 class="page-title">组合工坊</h1>
        <p class="page-sub">把多只基金穿透到底层股票，判断组合是真分散还是“同一篮子股票”；支持保存组合、再平衡回测、沪深300基准与收益风险归因。</p>
      </div>
      <div class="head-actions">
        <button class="btn" id="methodBtn">${'<svg class="icon"><use href="#i-info"/></svg>'}穿透口径</button>
      </div>
    </div>

    <div class="tabs" id="modeTabs">
      <button class="tab ${mode === "diagnosis" ? "active" : ""}" data-mode="diagnosis">组合诊断</button>
      <button class="tab ${mode === "compare" ? "active" : ""}" data-mode="compare">基金对比</button>
    </div>

    <div class="card">
      <div class="card-head">
        <div><h3 class="card-title" id="builderTitle">${mode === "diagnosis" ? "组合构成" : "对比基金"}</h3>
        <p class="card-sub">${mode === "diagnosis" ? "权重不足 100% 时，后端按相对权重自动归一化" : "对比模式按等权计算组合曲线与指标"}</p></div>
        <div class="pf-total"><span>合计</span><strong id="weightTotal">—</strong></div>
      </div>
      <div class="card-body">
        <div class="builder" id="pfRows"></div>
        <div class="flex wrap mt-12" style="gap:8px">
          <div class="add-fund grow" style="max-width:360px">
            <div class="input-group"><svg class="icon"><use href="#i-search"/></svg><input class="input" id="addFundInput" placeholder="搜索基金代码或名称，添加到组合"></div>
            <div class="add-menu" id="addFundMenu" style="display:none"></div>
          </div>
          <button class="btn" id="equalBtn">等权</button>
          <button class="btn" id="normalizeBtn">归一化</button>
          <button class="btn" id="clearBtn">清空</button>
          <button class="btn btn-primary" id="runBtn">开始诊断</button>
        </div>
        <div class="chip-row mt-12">
          <span class="tiny dim" style="line-height:29px">示例组合</span>
          ${PRESETS.map((preset) => `<button class="chip" data-preset="${escapeHtml(preset.name)}">${escapeHtml(preset.name)}</button>`).join("")}
        </div>
        <div class="pf-save-row mt-12">
          <span class="tiny dim">组合库</span>
          <select class="select pf-saved-select" id="savedPortfolio"><option value="">选择已保存组合</option></select>
          <button class="btn btn-sm" id="loadSavedBtn">载入</button>
          <button class="btn btn-sm" id="savePortfolioBtn">保存当前</button>
          <button class="btn btn-sm" id="deleteSavedBtn">删除</button>
        </div>
      </div>
    </div>

    <div id="pfResults" class="mt-16"></div>
  `;

  const rowsEl = $("#pfRows");
  const resultsEl = $("#pfResults");

  const totalWeight = () => items.reduce((sum, item) => sum + Number(item.weight || 0), 0);
  const updateTotal = () => {
    const total = totalWeight();
    const node = $("#weightTotal");
    if (mode === "compare") {
      node.textContent = `等权 · ${items.length} 只`;
      node.className = "";
      return;
    }
    node.textContent = `${total.toFixed(0)}%`;
    node.className = Math.abs(total - 100) < 0.1 ? "ok" : "bad";
  };

  const renderRows = () => {
    rowsEl.innerHTML = builderHtml(items, mode);
    updateTotal();
    $$("[data-weight]", rowsEl).forEach((input) => {
      input.addEventListener("input", () => {
        const index = Number(input.dataset.weight);
        items[index].weight = Number(input.value) || 0;
        setPortfolio(items);
        updateTotal();
      });
    });
    $$("[data-remove]", rowsEl).forEach((btn) => {
      btn.addEventListener("click", () => {
        items.splice(Number(btn.dataset.remove), 1);
        setPortfolio(items);
        renderRows();
        if (items.length) runAnalysis();
        else resultsEl.innerHTML = emptyPrompt();
      });
    });
  };

  const emptyPrompt = () => `<div class="card"><div class="card-body">
    <div class="empty">组合还是空的。添加基金，或选择上方示例组合开始。</div>
  </div></div>`;

  const loadSavedPortfolios = async () => {
    const select = $("#savedPortfolio");
    if (!select) return;
    try {
      const data = await api.portfolios();
      savedPortfolios = data.items || [];
      const current = select.value;
      select.innerHTML = '<option value="">选择已保存组合</option>' + savedPortfolios.map((item) => `<option value="${item.id}">${escapeHtml(item.name)}</option>`).join("");
      if (savedPortfolios.some((item) => String(item.id) === current)) select.value = current;
    } catch (error) {
      select.innerHTML = '<option value="">组合库暂不可用</option>';
    }
  };

  const saveCurrentPortfolio = () => {
    if (!items.length) {
      toast("请先添加基金", "error");
      return;
    }
    const defaultName = savedPortfolios.find((item) => String(item.id) === $("#savedPortfolio").value)?.name || "我的组合";
    const close = openModal("保存组合", `
      <div class="field"><label>组合名称</label><input class="input" id="pfSaveName" maxlength="40" value="${escapeHtml(defaultName)}" placeholder="例如：宽基核心"></div>
      <div class="flex mt-12" style="justify-content:flex-end;gap:8px">
        <button class="btn" id="pfSaveCancel">取消</button>
        <button class="btn btn-primary" id="pfSaveConfirm">保存</button>
      </div>`);
    $("#pfSaveCancel").onclick = close;
    $("#pfSaveConfirm").onclick = async () => {
      const name = $("#pfSaveName").value.trim();
      if (!name) {
        toast("请输入组合名称", "error");
        return;
      }
      const button = $("#pfSaveConfirm");
      button.disabled = true;
      try {
        await api.savePortfolio(name, items.map((item) => ({ code: item.code, name: item.name, weight: Number(item.weight) || 0 })));
        close();
        await loadSavedPortfolios();
        const select = $("#savedPortfolio");
        const saved = savedPortfolios.find((item) => item.name === name);
        if (saved) select.value = String(saved.id);
        toast(`已保存组合：${name}`, "success");
      } catch (error) {
        toast(error.message, "error");
      } finally {
        button.disabled = false;
      }
    };
  };

  const loadSelectedPortfolio = () => {
    const id = Number($("#savedPortfolio").value);
    const saved = savedPortfolios.find((item) => item.id === id);
    if (!saved) {
      toast("请先选择一个已保存组合", "error");
      return;
    }
    items = saved.items.map((item) => ({ ...item, weight: Number(item.weight) || 0 }));
    setPortfolio(items);
    renderRows();
    runAnalysis();
    toast(`已载入：${saved.name}`, "success");
  };

  const deleteSelectedPortfolio = async () => {
    const id = Number($("#savedPortfolio").value);
    const saved = savedPortfolios.find((item) => item.id === id);
    if (!saved) {
      toast("请先选择一个已保存组合", "error");
      return;
    }
    if (!window.confirm(`确定删除组合「${saved.name}」？`)) return;
    try {
      await api.deletePortfolio(id);
      await loadSavedPortfolios();
      $("#savedPortfolio").value = "";
      toast(`已删除：${saved.name}`, "success");
    } catch (error) {
      toast(error.message, "error");
    }
  };

  const setMode = (nextMode) => {
    mode = nextMode;
    sessionStorage.setItem("fundscope.pfMode", mode);
    $$("#modeTabs .tab").forEach((tab) => tab.classList.toggle("active", tab.dataset.mode === mode));
    $("#builderTitle").textContent = mode === "diagnosis" ? "组合构成" : "对比基金";
    renderRows();
    if (items.length) runAnalysis();
  };

  const runAnalysis = async () => {
    if (!items.length) {
      disposeCharts(resultsEl);
      resultsEl.innerHTML = emptyPrompt();
      return;
    }
    const current = ++requestId;
    disposeCharts(resultsEl);
    resultsEl.innerHTML = pageLoading(false);
    const payloadItems = items.map((item) => ({
      code: item.code,
      weight: mode === "compare" ? 100 / items.length : Number(item.weight) || 0,
    })).filter((item) => item.weight > 0);
    if (!payloadItems.length) {
      resultsEl.innerHTML = emptyPrompt();
      return;
    }
    try {
      const data = await api.portfolio(payloadItems, span);
      if (current !== requestId || !resultsEl.isConnected) return;
      result = data;
      renderResult(data);
    } catch (error) {
      if (current !== requestId || !resultsEl.isConnected) return;
      resultsEl.innerHTML = `<div class="card"><div class="card-body"><div class="error-box">${escapeHtml(error.message)}</div></div></div>`;
    }
  };

  const renderResult = (data) => {
    disposeCharts(resultsEl);
    const metrics = data.combined.metrics;
    const hasCombined = data.combined.series.length > 0;
    resultsEl.innerHTML = `
      <div class="kpi-grid">
        <div class="kpi-card">
          <div class="kpi-label">组合区间收益 <span class="badge badge-dim">${data.span === "all" ? "成立以来" : `近${data.span.replace("y", "年")}`}</span></div>
          <div class="kpi-value ${tone(metrics.total_return)}">${fmtPct(metrics.total_return)}</div>
          <div class="kpi-sub">年化 ${fmtPct(metrics.annual_return)} · ${data.funds.length} 只基金</div>
        </div>
        <div class="kpi-card">
          <div class="kpi-label">年化波动</div>
          <div class="kpi-value">${fmtPct(metrics.volatility, 2, false)}</div>
          <div class="kpi-sub">夏普 ${metrics.sharpe ?? "—"} · 胜率 ${fmtPct(metrics.win_rate, 1, false)}</div>
        </div>
        <div class="kpi-card">
          <div class="kpi-label">最大回撤</div>
          <div class="kpi-value down">${fmtPct(metrics.max_drawdown)}</div>
          <div class="kpi-sub">卡玛比率 ${metrics.calmar ?? "—"}</div>
        </div>
        <div class="kpi-card gold">
          <div class="kpi-label">穿透后重仓敞口</div>
          <div class="kpi-value">${data.holdings.total_weight ?? "—"}<small>%</small></div>
          <div class="kpi-sub">加权费率 ${data.weighted_fee !== null ? `${data.weighted_fee}%` : "—"} · 最高相关 ${data.correlation.max ?? "—"}</div>
        </div>
      </div>

      <div class="card mt-16">
        <div class="card-head">
          <div><h3 class="card-title">组合收益曲线</h3><p class="card-sub">区间累计收益率 · 起点 0% · ${mode === "compare" ? "等权组合" : "按输入权重日度再平衡"}</p></div>
          <div class="segmented" id="spanTabs">
            ${["1y", "3y", "5y", "all"].map((value) => `<button class="seg-btn ${span === value ? "active" : ""}" data-span="${value}">${value === "all" ? "成立以来" : `近${value.replace("y", "年")}`}</button>`).join("")}
          </div>
        </div>
        <div class="card-body"><div id="combinedChart" class="chart" style="height:380px"></div></div>
      </div>

      ${backtestHtml(data, backtestKey)}

      <div class="grid mt-16">
        <div class="card span-6">
          <div class="card-head"><div><h3 class="card-title">相关性矩阵</h3><p class="card-sub">日收益相关系数 · ${data.correlation.days ? `共同交易日 ${data.correlation.days} 天` : (data.correlation.note || "样本不足")}</p></div></div>
          <div class="card-body">
            <div id="corrChart" class="chart" style="height:${Math.max(260, data.funds.length * 56)}px"></div>
            <div class="note">相关系数越低，组合分散效果越好；红色越高、绿色越低。</div>
          </div>
        </div>
        <div class="card span-6">
          <div class="card-head"><div><h3 class="card-title">持仓重叠度</h3><p class="card-sub">前十大重仓权重交集</p></div></div>
          <div class="card-body">
            ${overlapTable(data)}
            <div class="pair-list mt-12">
              ${(data.overlap.pairs || []).slice(0, 4).map((pair) => `<div class="pair-row">
                <span class="grow">${escapeHtml(shortName(pair.a_name))} × ${escapeHtml(shortName(pair.b_name))}</span>
                <span class="bar"><i style="width:${Math.min(100, pair.score * 2)}%"></i></span>
                <span class="mono">${pair.score}%</span>
              </div>`).join("") || '<div class="dim small">暂无重叠数据</div>'}
            </div>
          </div>
        </div>

        <div class="card span-7">
          <div class="card-head"><div><h3 class="card-title">穿透后的持仓</h3><p class="card-sub">按组合权重聚合的前十大重仓 · 最多展示 20 只</p></div></div>
          <div class="card-body">${holdingsTable(data)}</div>
        </div>
        <div class="card span-5">
          <div class="card-head"><div><h3 class="card-title">穿透行业暴露</h3><p class="card-sub">申万二级行业 · 已披露重仓敞口</p></div></div>
          <div class="card-body">
            <div class="two-col">
              <div><div id="pfIndustryChart" class="chart" style="height:230px"></div></div>
              <div class="legend-list">
                ${(data.industry || []).slice(0, 8).map((item, index) => `<div class="legend-row">
                  <span class="legend-dot" style="background:${palette[index % palette.length]}"></span>
                  <span class="legend-name">${escapeHtml(item.name)}</span>
                  <span class="legend-val">${item.share.toFixed(1)}%</span>
                </div>`).join("") || '<div class="dim small">暂无数据</div>'}
              </div>
            </div>
            <div class="card-note">市值风格：${(data.cap || []).map((item) => `${item.name} ${item.share.toFixed(0)}%`).join(" · ") || "—"}</div>
          </div>
        </div>

        <div class="card span-12">
          <div class="card-head"><div><h3 class="card-title">组合诊断</h3><p class="card-sub">基于持仓重叠、相关性、行业暴露与费率</p></div></div>
          <div class="card-body">
            ${insightsHtml(data.insights)}
            ${(data.warnings || []).length ? `<div class="callout mt-12">${data.warnings.map(escapeHtml).join("<br/>")}</div>` : ""}
          </div>
        </div>

        <div class="card span-12">
          <div class="card-head"><div><h3 class="card-title">成分基金</h3><p class="card-sub">区间收益与风险指标按各自净值独立计算</p></div></div>
          <div class="card-body">
            <div class="data-table-wrap"><table class="data-table">
              <thead><tr><th>基金</th><th>类型</th><th class="num">权重</th><th class="num">区间收益</th><th class="num">年化</th><th class="num">波动</th><th class="num">夏普</th><th class="num">最大回撤</th><th class="num">卡玛</th><th>持仓期</th></tr></thead>
              <tbody>
                ${data.funds.map((fund) => `<tr class="clickable" data-fund="${fund.code}">
                  <td><div class="name-cell"><strong>${escapeHtml(fund.name)}</strong><span>${fund.code}</span></div></td>
                  <td><span class="badge badge-dim">${escapeHtml(fund.type || "—")}</span></td>
                  <td class="num">${fund.weight}%</td>
                  <td class="num ${tone(fund.return)}">${fmtPct(fund.return)}</td>
                  <td class="num ${tone(fund.annual_return)}">${fmtPct(fund.annual_return)}</td>
                  <td class="num">${fmtPct(fund.volatility, 2, false)}</td>
                  <td class="num">${fund.sharpe ?? "—"}</td>
                  <td class="num down">${fmtPct(fund.max_drawdown)}</td>
                  <td class="num">${fund.calmar ?? "—"}</td>
                  <td><span class="badge badge-dim">${fund.holdings_quarter || "无股票持仓"}</span></td>
                </tr>`).join("")}
              </tbody>
            </table></div>
          </div>
        </div>
      </div>
    `;

    if (hasCombined) {
      const series = data.funds
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
        name: mode === "compare" ? "等权组合" : "组合",
        type: "line",
        data: toReturnSeries(data.combined.series),
        showSymbol: false,
        smooth: true,
        lineStyle: { width: 2.8, color: C.accent },
        itemStyle: { color: C.accent },
        areaStyle: { color: C.accentFade },
        z: 5,
      });
      makeChart($("#combinedChart"), {
        animationDuration: 500,
        color: palette,
        grid: { left: 12, right: 20, top: 36, bottom: 12, containLabel: true },
        legend: { top: 0, left: 0, type: "scroll", icon: "roundRect", itemWidth: 8, itemHeight: 8, textStyle: { color: C.muted, fontSize: 11 } },
        tooltip: {
          ...tooltipStyle,
          trigger: "axis",
          axisPointer: { lineStyle: { color: C.crosshair, type: "dashed" } },
          formatter: (params) => {
            const rows = params.filter((p) => p.value !== null).map((p) => `${p.marker} ${escapeHtml(p.seriesName)} <b style="color:${Number(p.value[1]) >= 0 ? C.up : C.down}">${Number(p.value[1]) >= 0 ? "+" : ""}${Number(p.value[1]).toFixed(1)}%</b>`);
            return `<div style="color:${C.muted};font-size:11px;margin-bottom:3px">${params[0].axisValueLabel}</div>${rows.join("<br/>")}`;
          },
        },
        xAxis: {
          type: "time",
          axisLine: { lineStyle: { color: C.grid } },
          axisTick: { show: false },
          axisLabel: { color: C.dim, fontSize: 10 },
          splitLine: { show: false },
        },
        yAxis: {
          type: "value",
          scale: true,
          axisLine: { show: false },
          axisTick: { show: false },
          axisLabel: { color: C.dim, fontSize: 11, formatter: "{value}%" },
          splitLine: { lineStyle: { color: C.grid, type: "dashed" } },
        },
        series,
      });
    } else {
      $("#combinedChart").innerHTML = '<div class="chart-empty">所选基金没有足够的共同交易日</div>';
    }

    drawBacktest(data, backtestKey);
    $("#backtestStrategy")?.addEventListener("change", (event) => {
      backtestKey = event.target.value;
      sessionStorage.setItem("fundscope.pfBacktest", backtestKey);
      drawBacktest(data, backtestKey);
    });

    if (data.correlation.matrix.length) {
      heatmapChart($("#corrChart"), {
        xLabels: data.correlation.names.map(shortName),
        yLabels: data.correlation.names.map(shortName),
        matrix: data.correlation.matrix,
      });
    } else {
      $("#corrChart").innerHTML = `<div class="chart-empty">${escapeHtml(data.correlation.note || "无法计算")}</div>`;
    }

    if (data.industry?.length) {
      makeChart($("#pfIndustryChart"), {
        animationDuration: 500,
        tooltip: { ...tooltipStyle, trigger: "item", formatter: (p) => `${p.name}<br/>${p.value}%` },
        series: [{
          type: "pie",
          radius: ["52%", "80%"],
          center: ["50%", "50%"],
          padAngle: 2,
          itemStyle: { borderRadius: 4, borderColor: C.chartBorder, borderWidth: 2 },
          label: { show: false },
          data: data.industry.slice(0, 8).map((item, index) => ({ name: item.name, value: item.share, itemStyle: { color: palette[index % palette.length] } })),
        }],
      });
    } else {
      $("#pfIndustryChart").innerHTML = '<div class="chart-empty">暂无</div>';
    }

    $$("#spanTabs [data-span]").forEach((btn) => {
      btn.addEventListener("click", () => {
        span = btn.dataset.span;
        sessionStorage.setItem("fundscope.pfSpan", span);
        runAnalysis();
      });
    });
    $$("tr[data-fund]").forEach((row) => {
      row.addEventListener("click", () => { location.hash = `#/fund/${row.dataset.fund}`; });
    });
    $$("tr[data-stock]").forEach((row) => {
      row.addEventListener("click", () => {
        const quarter = data.funds.find((f) => f.holdings_quarter)?.holdings_quarter || "";
        location.hash = `#/stocks?code=${row.dataset.stock}&quarter=${quarter}`;
      });
    });
  };

  $("#savePortfolioBtn").addEventListener("click", saveCurrentPortfolio);
  $("#loadSavedBtn").addEventListener("click", loadSelectedPortfolio);
  $("#deleteSavedBtn").addEventListener("click", deleteSelectedPortfolio);
  loadSavedPortfolios();

  renderRows();
  if (items.length) runAnalysis();
  else resultsEl.innerHTML = emptyPrompt();

  /* add fund search */
  const addInput = $("#addFundInput");
  const addMenu = $("#addFundMenu");
  let addSearchRequest = 0;
  const search = debounce(async () => {
    const q = addInput.value.trim();
    const current = ++addSearchRequest;
    if (!q) { addMenu.style.display = "none"; return; }
    try {
      const data = await api.search(q);
      if (current !== addSearchRequest || !addMenu.isConnected) return;
      addMenu.innerHTML = data.funds.length
        ? data.funds.map((fund) => `<div class="search-item" data-code="${fund.code}" data-name="${escapeHtml(fund.name)}">
            <div class="si-main"><div class="si-name">${escapeHtml(fund.name)}</div><div class="si-meta">${fund.code} · ${escapeHtml(fund.type || "基金")}</div></div>
            <span class="si-tag">添加</span>
          </div>`).join("")
        : '<div class="search-empty">未找到基金</div>';
      addMenu.style.display = "block";
    } catch (error) {
      if (current !== addSearchRequest || !addMenu.isConnected) return;
      addMenu.innerHTML = `<div class="search-empty">${escapeHtml(error.message)}</div>`;
      addMenu.style.display = "block";
    }
  }, 260);
  addInput.addEventListener("input", search);
  addMenu.addEventListener("mousedown", (event) => {
    const node = event.target.closest(".search-item");
    if (!node) return;
    event.preventDefault();
    const code = node.dataset.code;
    if (items.some((item) => item.code === code)) {
      toast("该基金已在组合中", "error");
      return;
    }
    const wasEmpty = items.length === 0;
    items.push({ code, name: node.dataset.name, weight: wasEmpty ? 100 : 20 });
    setPortfolio(items);
    renderRows();
    addInput.value = "";
    addMenu.style.display = "none";
    runAnalysis();
  });
  if (!outsideClickBound) {
    outsideClickBound = true;
    document.addEventListener("click", (event) => {
      if (event.target.closest(".add-fund")) return;
      const node = document.getElementById("addFundMenu");
      if (node) node.style.display = "none";
    });
  }

  $("#equalBtn").addEventListener("click", () => {
    if (!items.length) return;
    const weight = 100 / items.length;
    items.forEach((item) => { item.weight = Number(weight.toFixed(2)); });
    setPortfolio(items);
    renderRows();
    if (mode === "diagnosis") runAnalysis();
  });
  $("#normalizeBtn").addEventListener("click", () => {
    const total = totalWeight();
    if (!items.length || total <= 0) return;
    items.forEach((item) => { item.weight = Number((item.weight / total * 100).toFixed(2)); });
    setPortfolio(items);
    renderRows();
    runAnalysis();
  });
  $("#clearBtn").addEventListener("click", () => {
    items = [];
    setPortfolio(items);
    renderRows();
    resultsEl.innerHTML = emptyPrompt();
  });
  $("#runBtn").addEventListener("click", runAnalysis);
  $$("#modeTabs .tab").forEach((tab) => tab.addEventListener("click", () => setMode(tab.dataset.mode)));
  $$("[data-preset]").forEach((btn) => {
    btn.addEventListener("click", () => {
      const preset = PRESETS.find((item) => item.name === btn.dataset.preset);
      items = preset.items.map((item) => ({ ...item }));
      setPortfolio(items);
      renderRows();
      runAnalysis();
      toast(`已载入示例：${preset.name}`, "success");
    });
  });
  $("#methodBtn").addEventListener("click", () => {
    openModal("穿透口径", `
      <div class="about-text">
        <p><strong>权重：</strong>组合诊断按输入的相对权重归一化；对比模式使用等权。组合曲线按日度再平衡计算，假设权重保持不变。</p>
        <p><strong>持仓穿透：</strong>每只基金使用最新报告期的前十大重仓股，乘以该基金在组合中的权重后合并。季报只披露前十大，因此穿透敞口并不覆盖基金全部股票仓位。</p>
        <p><strong>重叠度：</strong>两只基金共同持有股票的最小权重之和，例如 A 持有某股 5%、B 持有 3%，重叠贡献为 3 个百分点。</p>
        <p><strong>相关性：</strong>使用共同交易日内的日收益率计算 Pearson 相关系数；共同交易日少于 30 天时不做计算。</p>
        <p><strong>局限：</strong>持仓滞后于最新市场，且基金经理可能已调仓；本工具用于结构检查，不构成投资建议。</p>
      </div>`);
  });
}
