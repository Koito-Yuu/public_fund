import { escapeHtml } from "./utils.js";

const UI_FONT = '"Inter", -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Microsoft YaHei UI", "Microsoft YaHei", sans-serif';
const NUM_FONT = UI_FONT;

const THEMES = {
  dark: {
    colors: {
      accent: "#4bd6c4",
      gold: "#e3b467",
      blue: "#6392f2",
      violet: "#a98bf5",
      up: "#f2556a",
      down: "#22c08b",
      text: "#e9eef8",
      muted: "#8d99ad",
      dim: "#5c687c",
      line: "#1e2836",
      grid: "#19222f",
      panel: "#10151f",
      chartBg: "#0b1018",
      chartBorder: "#10151f",
      treemapLabel: "#071014",
      scatterBorder: "rgba(255,255,255,.18)",
      markLine: "rgba(255,255,255,.14)",
      crosshair: "#33445c",
      radarFill: ["rgba(255,255,255,.012)", "rgba(255,255,255,.03)"],
      radarLine: "rgba(255,255,255,.06)",
      gaugeTrack: "rgba(255,255,255,.06)",
      accentFade: "rgba(75,214,196,.08)",
      accentArea: "rgba(75,214,196,.26)",
      accentFade0: "rgba(75,214,196,0)",
      goldFade: "rgba(227,180,103,.05)",
      heatColors: ["#22c08b", "#0f2a2a", "#10151f", "#2c2438", "#f2556a"],
      heatBorder: "#0b1018",
      heatLabel: "#dfe7f4",
      zoomBg: "rgba(255,255,255,.03)",
      zoomFiller: "rgba(75,214,196,.12)",
    },
    palette: ["#4bd6c4", "#6392f2", "#e3b467", "#a98bf5", "#f2556a", "#22c08b", "#f08a5d", "#7cc4f5", "#c0e56b", "#e08ec9"],
    tooltip: {
      backgroundColor: "rgba(12, 17, 25, 0.97)",
      borderColor: "#263448",
      borderWidth: 1,
      padding: [9, 12],
      textStyle: { color: "#e9eef8", fontSize: 12, fontFamily: UI_FONT },
      extraCssText: "box-shadow:0 14px 34px rgba(0,0,0,.45);border-radius:8px;",
    },
  },
  light: {
    colors: {
      accent: "#0f9d8f",
      gold: "#a8741d",
      blue: "#3f6fd1",
      violet: "#7a5bd6",
      up: "#d92d4a",
      down: "#0f9d6b",
      text: "#152033",
      muted: "#5f6b80",
      dim: "#8792a5",
      line: "#dfe6ef",
      grid: "#e9eef5",
      panel: "#ffffff",
      chartBg: "#ffffff",
      chartBorder: "#ffffff",
      treemapLabel: "#ffffff",
      scatterBorder: "rgba(15,32,55,.14)",
      markLine: "rgba(15,32,55,.18)",
      crosshair: "#b9c5d6",
      radarFill: ["rgba(15,32,55,.015)", "rgba(15,32,55,.04)"],
      radarLine: "rgba(15,32,55,.08)",
      gaugeTrack: "rgba(15,32,55,.08)",
      accentFade: "rgba(15,157,143,.10)",
      accentArea: "rgba(15,157,143,.18)",
      accentFade0: "rgba(15,157,143,0)",
      goldFade: "rgba(168,116,29,.07)",
      heatColors: ["#0f9d6b", "#dff3ec", "#ffffff", "#fbe4e8", "#d92d4a"],
      heatBorder: "#ffffff",
      heatLabel: "#3a4658",
      zoomBg: "rgba(15,32,55,.04)",
      zoomFiller: "rgba(15,157,143,.12)",
    },
    palette: ["#0f9d8f", "#3f6fd1", "#a8741d", "#7a5bd6", "#d92d4a", "#0f9d6b", "#d9773f", "#4f9fd8", "#7a9e2f", "#c25b9b"],
    tooltip: {
      backgroundColor: "rgba(255, 255, 255, 0.98)",
      borderColor: "#d6dfeb",
      borderWidth: 1,
      padding: [9, 12],
      textStyle: { color: "#152033", fontSize: 12, fontFamily: UI_FONT },
      extraCssText: "box-shadow:0 14px 34px rgba(27,52,86,.16);border-radius:8px;",
    },
  },
};

const themeNow = () => (document.documentElement.dataset.theme === "light" ? THEMES.light : THEMES.dark);

export const C = new Proxy({}, {
  get(_target, prop) {
    return themeNow().colors[prop];
  },
});

export const palette = new Proxy([], {
  get(_target, prop) {
    const list = themeNow().palette;
    if (prop === "length") return list.length;
    const value = list[prop];
    return typeof value === "function" ? value.bind(list) : value;
  },
});

export const tooltipStyle = new Proxy({}, {
  get(_target, prop) {
    return themeNow().tooltip[prop];
  },
  ownKeys() {
    return Reflect.ownKeys(themeNow().tooltip);
  },
  getOwnPropertyDescriptor(_target, prop) {
    return { enumerable: true, configurable: true, value: themeNow().tooltip[prop] };
  },
});

const instances = new Map();
const deferred = new WeakMap();
const deferredTargets = new Set();
let viewportObserver = null;

function createChart(el, option, onClick) {
  const chart = echarts.init(el, null, { renderer: "canvas" });
  chart.setOption({ ...option, textStyle: { fontFamily: UI_FONT, ...(option.textStyle || {}) } }, true);
  if (onClick) chart.on("click", onClick);
  const observer = new ResizeObserver(() => chart.resize());
  observer.observe(el);
  instances.set(el, { chart, observer });
  return chart;
}

function observeViewport() {
  if (viewportObserver) return viewportObserver;
  viewportObserver = new IntersectionObserver(
    (entries) => {
      for (const entry of entries) {
        if (!entry.isIntersecting) continue;
        const el = entry.target;
        viewportObserver.unobserve(el);
        const job = deferred.get(el);
        deferred.delete(el);
        deferredTargets.delete(el);
        if (job && el.isConnected) createChart(el, job.option, job.onClick);
      }
    },
    { rootMargin: "480px 0px" }
  );
  return viewportObserver;
}

export function makeChart(el, option, onClick) {
  if (!el || !el.isConnected) return null;
  if (instances.has(el)) {
    const old = instances.get(el);
    old.chart.dispose();
    old.observer.disconnect();
    instances.delete(el);
  }
  // 首屏外的卡片推迟到接近视口再初始化，避免基金页一次性创建十余个实例
  if (el.getBoundingClientRect().top > window.innerHeight + 480) {
    deferred.set(el, { option, onClick });
    deferredTargets.add(el);
    observeViewport().observe(el);
    return null;
  }
  return createChart(el, option, onClick);
}

export function disposeCharts(root = null) {
  for (const [el, { chart, observer }] of [...instances]) {
    if (root && !root.contains(el)) continue;
    observer.disconnect();
    chart.dispose();
    instances.delete(el);
  }
  for (const el of [...deferredTargets]) {
    if (root && !root.contains(el)) continue;
    viewportObserver?.unobserve(el);
    deferred.delete(el);
    deferredTargets.delete(el);
  }
  if (!root && viewportObserver) {
    viewportObserver.disconnect();
    viewportObserver = null;
  }
}

export function resizeCharts() {
  for (const { chart } of instances.values()) {
    if (chart.getDom()?.isConnected) chart.resize();
  }
}

export function axisX(extra = {}) {
  return {
    type: "category",
    axisLine: { lineStyle: { color: C.grid } },
    axisTick: { show: false },
    axisLabel: { color: C.dim, fontSize: 11 },
    splitLine: { show: false },
    ...extra,
  };
}

export function axisY(extra = {}) {
  return {
    type: "value",
    axisLine: { show: false },
    axisTick: { show: false },
    axisLabel: { color: C.dim, fontSize: 11 },
    splitLine: { lineStyle: { color: C.grid, type: "dashed" } },
    ...extra,
  };
}

export function grad(from, to, vertical = true) {
  return new echarts.graphic.LinearGradient(0, 0, vertical ? 0 : 1, vertical ? 1 : 0, [
    { offset: 0, color: from },
    { offset: 1, color: to },
  ]);
}

export function barChart(el, { labels, values, color = C.accent, horizontal = true, formatter }) {
  if (!el) return null;
  const option = {
    animationDuration: 550,
    grid: horizontal
      ? { left: 8, right: 44, top: 8, bottom: 8, containLabel: true }
      : { left: 8, right: 12, top: 16, bottom: 8, containLabel: true },
    tooltip: { ...tooltipStyle, trigger: "axis", axisPointer: { type: "shadow" } },
    xAxis: horizontal ? axisY({ axisLabel: { color: C.dim, fontSize: 11, formatter } }) : axisX({ data: labels }),
    yAxis: horizontal ? axisX({ data: labels, inverse: true }) : axisY({ axisLabel: { color: C.dim, fontSize: 11, formatter } }),
    series: [
      {
        type: "bar",
        data: values,
        barMaxWidth: horizontal ? 11 : 20,
        itemStyle: { color: grad(color, C.accentFade, !horizontal), borderRadius: 4 },
        label: {
          show: true,
          position: horizontal ? "right" : "top",
          color: C.muted,
          fontSize: 11,
          fontFamily: NUM_FONT,
          formatter: ({ value }) => (formatter ? formatter(value) : value),
        },
      },
    ],
  };
  return makeChart(el, option);
}

export function lineChart(el, { dates, series, yFormatter, legend = true, area = false, stack = false, zoom = false }) {
  if (!el) return null;
  const option = {
    animationDuration: 600,
    color: palette,
    grid: { left: 10, right: 18, top: legend ? 38 : 16, bottom: zoom ? 44 : 14, containLabel: true },
    legend: legend
      ? {
          top: 0,
          left: 0,
          itemWidth: 8,
          itemHeight: 8,
          icon: "roundRect",
          textStyle: { color: C.muted, fontSize: 11 },
        }
      : undefined,
    tooltip: {
      ...tooltipStyle,
      trigger: "axis",
      axisPointer: { type: "line", lineStyle: { color: C.crosshair, type: "dashed" } },
      valueFormatter: yFormatter,
    },
    xAxis: axisX({ data: dates, boundaryGap: false, axisLabel: { color: C.dim, fontSize: 11, hideOverlap: true } }),
    yAxis: axisY({ scale: true, axisLabel: { color: C.dim, fontSize: 11, formatter: yFormatter } }),
    dataZoom: zoom
      ? [
          { type: "inside", start: 0, end: 100 },
          { type: "slider", height: 16, bottom: 4, borderColor: "transparent", backgroundColor: C.zoomBg, fillerColor: C.zoomFiller, handleStyle: { color: C.accent } },
        ]
      : undefined,
    series: series.map((item, index) => ({
      name: item.name,
      type: "line",
      data: item.data,
      smooth: item.smooth ?? true,
      showSymbol: false,
      symbol: "circle",
      lineStyle: { width: item.width ?? 1.8, type: item.dashed ? "dashed" : "solid" },
      itemStyle: { color: item.color || palette[index % palette.length] },
      areaStyle: area
        ? {
            opacity: 1,
            color: grad(item.color || palette[index % palette.length], C.accentFade0, true),
          }
        : undefined,
      stack: stack ? "total" : undefined,
      emphasis: { focus: "series" },
    })),
  };
  return makeChart(el, option);
}

export function donutChart(el, { items, centerLabel, centerValue, colors = palette }) {
  if (!el) return null;
  const option = {
    animationDuration: 650,
    color: colors,
    tooltip: {
      ...tooltipStyle,
      trigger: "item",
      formatter: (params) => `${escapeHtml(params.name)}<br/>占比 <b>${params.value}%</b>`,
    },
    series: [
      {
        type: "pie",
        radius: ["58%", "82%"],
        center: ["50%", "50%"],
        avoidLabelOverlap: true,
        padAngle: 2,
        itemStyle: { borderRadius: 4, borderColor: C.chartBorder, borderWidth: 2 },
        label: { show: false },
        emphasis: { scale: true, scaleSize: 4 },
        data: items.map((item) => ({ name: item.name, value: item.share })),
      },
    ],
    graphic: centerLabel
      ? [
          {
            type: "text",
            left: "center",
            top: "44%",
            style: { text: centerLabel, fill: C.dim, fontSize: 11, fontFamily: UI_FONT, textAlign: "center" },
          },
          {
            type: "text",
            left: "center",
            top: "52%",
            style: { text: centerValue, fill: C.text, fontSize: 16, fontFamily: NUM_FONT, textAlign: "center" },
          },
        ]
      : undefined,
  };
  return makeChart(el, option);
}

export function scatterChart(el, { data, xName, yName, onClick }) {
  if (!el) return null;
  const option = {
    animationDuration: 700,
    grid: { left: 20, right: 26, top: 30, bottom: 34, containLabel: true },
    tooltip: {
      ...tooltipStyle,
      formatter: (params) => {
        const d = params.data;
        const delta = d.delta === null || d.delta === undefined ? "—" : `${d.delta > 0 ? "+" : ""}${d.delta} 只`;
        const yoy = d.yoy === null || d.yoy === undefined ? "—" : `${d.yoy > 0 ? "+" : ""}${d.yoy}%`;
        return `<b>${escapeHtml(d.name)}</b> <span style="color:${C.muted}">${escapeHtml(d.code)}</span><br/>
          持有基金 <b>${d.value[0]}</b> 只<br/>
          同比增减 <b style="color:${d.delta >= 0 ? C.up : C.down}">${delta}</b>（${yoy}）<br/>
          持仓市值 <b>${d.value[2]}</b> 亿<br/>
          占流通股 <b>${d.value[3] ?? "—"}%</b>`;
      },
    },
    xAxis: axisY({ name: xName, nameLocation: "middle", nameGap: 30, nameTextStyle: { color: C.dim, fontSize: 11 } }),
    yAxis: axisY({ name: yName, nameLocation: "middle", nameGap: 48, nameTextStyle: { color: C.dim, fontSize: 11 } }),
    series: [
      {
        type: "scatter",
        data,
        symbolSize: (value) => Math.max(7, Math.min(52, Math.sqrt(value[2] || 1) * 1.5)),
        itemStyle: {
          color: (params) => params.data.color,
          opacity: 0.72,
          borderColor: C.scatterBorder,
          borderWidth: 0.6,
        },
        emphasis: { itemStyle: { opacity: 1, borderColor: "#fff", borderWidth: 1.2 } },
        label: { show: false },
        markLine: {
          silent: true,
          symbol: "none",
          label: { show: false },
          lineStyle: { color: C.markLine, type: "dashed", width: 1 },
          data: [{ yAxis: 0 }],
        },
      },
    ],
  };
  return makeChart(el, option, onClick);
}

export function stackedBarChart(el, { dates, series, yFormatter }) {
  if (!el) return null;
  const option = {
    animationDuration: 600,
    color: palette,
    grid: { left: 10, right: 16, top: 36, bottom: 10, containLabel: true },
    legend: { top: 0, left: 0, icon: "roundRect", itemWidth: 8, itemHeight: 8, textStyle: { color: C.muted, fontSize: 11 } },
    tooltip: { ...tooltipStyle, trigger: "axis", axisPointer: { type: "shadow" } },
    xAxis: axisX({ data: dates, axisLabel: { color: C.dim, fontSize: 11, hideOverlap: true } }),
    yAxis: axisY({ max: 100, axisLabel: { color: C.dim, fontSize: 11, formatter: yFormatter || "{value}%" } }),
    series: series.map((item, index) => ({
      name: item.name,
      type: "bar",
      stack: "total",
      data: item.data,
      barMaxWidth: 22,
      itemStyle: { color: item.color || palette[index % palette.length], borderRadius: index === 0 ? [3, 3, 0, 0] : 0 },
    })),
  };
  return makeChart(el, option);
}

export function radarChart(el, { categories, values, avg, name = "能力" }) {
  if (!el) return null;
  const option = {
    animationDuration: 600,
    color: [C.accent, C.gold],
    radar: {
      indicator: categories.map((item) => ({ name: item, max: 100 })),
      radius: "64%",
      splitNumber: 4,
      axisName: { color: C.muted, fontSize: 11 },
      splitArea: { areaStyle: { color: C.radarFill } },
      splitLine: { lineStyle: { color: C.radarLine } },
      axisLine: { lineStyle: { color: C.radarLine } },
    },
    tooltip: { ...tooltipStyle },
    series: [
      {
        type: "radar",
        data: [
          { value: values, name, areaStyle: { color: C.accentFade }, lineStyle: { color: C.accent, width: 1.6 }, itemStyle: { color: C.accent } },
          ...(avg ? [{ value: categories.map(() => Number(avg) || 0), name: "同类平均", lineStyle: { color: C.gold, type: "dashed", width: 1 }, itemStyle: { color: C.gold } }] : []),
        ],
      },
    ],
  };
  return makeChart(el, option);
}

export function gaugeChart(el, { value, title }) {
  if (!el) return null;
  const option = {
    animationDuration: 700,
    series: [
      {
        type: "gauge",
        startAngle: 210,
        endAngle: -30,
        min: 0,
        max: 100,
        radius: "88%",
        center: ["50%", "56%"],
        progress: { show: true, width: 10, roundCap: true, itemStyle: { color: value > 40 ? C.up : value > 20 ? C.gold : C.accent } },
        axisLine: { lineStyle: { width: 10, color: [[1, C.gaugeTrack]] } },
        axisTick: { show: false },
        splitLine: { show: false },
        axisLabel: { show: false },
        pointer: { show: false },
        anchor: { show: false },
        title: { show: true, offsetCenter: [0, "30%"], color: C.dim, fontSize: 11 },
        detail: {
          valueAnimation: true,
          offsetCenter: [0, "-8%"],
          color: C.text,
          fontSize: 24,
          fontFamily: NUM_FONT,
          formatter: "{value}%",
        },
        data: [{ value: Number(value || 0), name: title }],
      },
    ],
  };
  return makeChart(el, option);
}

export function treemapChart(el, { data, onClick }) {
  if (!el) return null;
  const option = {
    animationDuration: 600,
    tooltip: {
      ...tooltipStyle,
      formatter: (params) => `<b>${escapeHtml(params.name)}</b><br/>${escapeHtml(params.data.code || "")}<br/>占净值 <b>${params.value}%</b>`,
    },
    series: [
      {
        type: "treemap",
        roam: false,
        nodeClick: false,
        breadcrumb: { show: false },
        width: "100%",
        height: "100%",
        top: 0,
        left: 0,
        right: 0,
        bottom: 0,
        label: { show: true, color: C.treemapLabel, fontSize: 11, fontWeight: 500, formatter: (params) => `${params.name}\n${params.value}%` },
        itemStyle: { borderColor: C.chartBg, borderWidth: 2, gapWidth: 2, borderRadius: 4 },
        data: data.map((item) => ({ name: item.name, value: item.value, code: item.code, itemStyle: { color: item.color } })),
      },
    ],
  };
  return makeChart(el, option, (params) => {
    if (params.data?.code && onClick) onClick(params.data.code);
  });
}

export function heatmapChart(el, { xLabels, yLabels, matrix }) {
  if (!el) return null;
  let maxAbs = 0;
  matrix.forEach((row) => row.forEach((v) => { if (v !== null) maxAbs = Math.max(maxAbs, Math.abs(v)); }));
  const data = [];
  matrix.forEach((row, y) => row.forEach((v, x) => data.push([x, y, v])));
  const option = {
    animationDuration: 500,
    grid: { left: 12, right: 12, top: 10, bottom: 12, containLabel: true },
    tooltip: {
      ...tooltipStyle,
      formatter: (params) => `${yLabels[params.value[1]]} × ${xLabels[params.value[0]]}<br/><b>${params.value[2] ?? "—"}</b>`,
    },
    xAxis: axisX({ data: xLabels, axisLabel: { color: C.muted, fontSize: 11, interval: 0 } }),
    yAxis: axisX({ data: yLabels, axisLabel: { color: C.muted, fontSize: 11, interval: 0 } }),
    visualMap: {
      show: false,
      min: -Math.max(1, maxAbs),
      max: Math.max(1, maxAbs),
      orient: "horizontal",
      left: "center",
      bottom: 0,
      itemHeight: 70,
      itemWidth: 9,
      textStyle: { color: C.dim, fontSize: 10 },
      inRange: { color: C.heatColors },
    },
    series: [
      {
        type: "heatmap",
        data,
        label: { show: true, color: C.heatLabel, fontSize: 11, fontFamily: NUM_FONT, formatter: (p) => (p.value[2] === null ? "—" : p.value[2]) },
        itemStyle: { borderColor: C.heatBorder, borderWidth: 2, borderRadius: 4 },
        emphasis: { itemStyle: { borderColor: C.accent, borderWidth: 1 } },
      },
    ],
  };
  return makeChart(el, option);
}
