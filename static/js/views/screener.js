import { api } from "../api.js";
import { addToPortfolio } from "../store.js";
import {
  $, $$, debounce, escapeHtml, fmtPct, fmtYi, openModal, stars, toast, tone,
} from "../utils.js";

const CATEGORIES = [
  ["", "全部"],
  ["股票型", "股票型"],
  ["混合型", "混合型"],
  ["指数型", "指数型"],
  ["债券型", "债券型"],
  ["QDII", "QDII"],
  ["FOF", "FOF"],
  ["货币型", "货币型"],
];

const SESSION_KEY = "fundscope.screener.v2";
const ADV_KEYS = [
  "r1y_min", "r3y_min", "ytd_min", "scale_min", "scale_max",
  "established_years_min", "inst_min", "inst_max", "internal_min",
  "manager_years_min", "manager_aum_min", "company",
];

const DEFAULTS = {
  q: "", category: "", type: "", rating: "", fee_max: "",
  r1y_min: "", r3y_min: "", ytd_min: "", inst_min: "", inst_max: "",
  internal_min: "", scale_min: "", scale_max: "", manager_years_min: "",
  manager_aum_min: "", established_years_min: "", company: "",
  four: false, holder_only: false, advanced: false,
  sort: "r1y", order: "desc", page: 1,
};

const PRESETS = {
  four: { four: true, label: "4433" },
  highInst: { inst_min: "30", holder_only: true, label: "高机构" },
  internal: { internal_min: "1", holder_only: true, label: "内部自购" },
  large: { scale_min: "50", label: "大规模" },
  lowFee: { fee_max: "0.15", label: "低费率" },
  veteran: { manager_years_min: "8", label: "老将" },
};

function loadState() {
  try {
    return { ...DEFAULTS, ...JSON.parse(sessionStorage.getItem(SESSION_KEY) || "{}") };
  } catch (error) {
    return { ...DEFAULTS };
  }
}

function saveState(state) {
  try {
    sessionStorage.setItem(SESSION_KEY, JSON.stringify(state));
  } catch (error) {
    /* ignore */
  }
}

function feeLabel(value) {
  return value === null || value === undefined ? '<span class="dim">—</span>' : `${Number(value).toFixed(2)}%`;
}

function rankCell(index, page, pageSize) {
  return `<span class="dim mono">${(page - 1) * pageSize + index + 1}</span>`;
}

function holderCell(value, digits = 1, gold = false) {
  if (value === null || value === undefined) return '<span class="dim" title="尚未建立该基金的持有人快照">—</span>';
  return `<span class="${gold ? "gold-text" : ""}">${Number(value).toFixed(digits)}%</span>`;
}

function rowHtml(row, index, state, pageSize) {
  const badges = [
    row.four ? '<span class="badge badge-gold">4433</span>' : "",
    (row.institution ?? -1) >= 50 ? '<span class="badge badge-teal">高机构</span>' : "",
    (row.internal ?? -1) >= 1 ? '<span class="badge badge-gold">内部自购</span>' : "",
  ].join("");
  const holder = row.holder_covered
    ? `<div class="holder-stack"><span>机构 <b>${row.institution !== null && row.institution !== undefined ? `${Number(row.institution).toFixed(1)}%` : "—"}</b></span><span class="gold-text">内部 ${row.internal !== null && row.internal !== undefined ? `${Number(row.internal).toFixed(2)}%` : "—"}</span></div>`
    : '<span class="dim holder-missing" title="尚未建立该基金的持有人快照">—</span>';
  const manager = `<div class="manager-stack"><strong>${row.manager_years ? `${Number(row.manager_years).toFixed(1)}年` : "—"}</strong><span>${row.manager_aum ? `在管 ${fmtYi(row.manager_aum)}` : "—"}</span></div>`;
  return `
    <tr class="clickable" data-code="${row.code}" data-index="${index}">
      <td>${rankCell(index, state.page, pageSize)}</td>
      <td>
        <div class="name-cell">
          <strong>${escapeHtml(row.name)} ${badges}</strong>
          <span>${row.code} · ${escapeHtml(row.manager || "—")}</span>
        </div>
      </td>
      <td data-label="类型"><span class="badge badge-dim">${escapeHtml(row.type || "—")}</span></td>
      <td class="num ${tone(row.r1y)}" data-label="近1年">${fmtPct(row.r1y)}</td>
      <td class="num ${tone(row.r3y)}" data-label="近3年">${fmtPct(row.r3y)}</td>
      <td class="num" data-label="规模">${row.scale ? fmtYi(row.scale) : '<span class="dim" title="规模数据仅覆盖开放式基金">—</span>'}</td>
      <td data-label="持有人" title="${row.holder_date ? `持有人数据：${row.holder_date}` : "未覆盖持有人快照"}">${holder}</td>
      <td data-label="经理" title="${escapeHtml((row.managers || []).join(" / "))}">${manager}</td>
      <td data-label="评级">${stars(row.rating_max)}</td>
      <td class="num" data-label="费率">${feeLabel(row.fee)}</td>
      <td class="row-action"><button class="btn btn-sm" data-add="${row.code}" title="加入组合工坊"><svg class="icon"><use href="#i-plus"/></svg></button></td>
    </tr>`;
}

function advancedCount(state) {
  return ADV_KEYS.filter((key) => state[key] !== "" && state[key] !== undefined && state[key] !== null).length;
}

export async function render(el, params) {
  const state = loadState();
  if (params.q) state.q = params.q;
  el.innerHTML = `
    <div class="page-head">
      <div>
        <div class="eyebrow">Fund Screener</div>
        <h1 class="page-title">基金筛选</h1>
        <p class="page-sub">收益之外，把规模、机构占比、内部持有、经理年限与费率一起纳入筛选。持有人与规模数据为本地快照，未覆盖的基金会在对应筛选中自动排除。</p>
      </div>
      <div class="head-actions">
        <button class="btn" id="ruleBtn"><svg class="icon"><use href="#i-info"/></svg>4433 是什么</button>
      </div>
    </div>

    <div class="card screener-filter-card">
      <div class="card-head">
        <div>
          <h3 class="card-title">筛选条件</h3>
          <p class="card-sub">收益、规模、持有人与经理维度组合筛选；本地快照未覆盖的基金不会进入对应条件。</p>
        </div>
        <div class="card-actions">
          <span class="badge badge-dim" id="filterCoverage">—</span>
          <button class="btn" id="advancedBtn"><svg class="icon"><use href="#i-filter"/></svg>高级筛选 <span class="badge badge-teal" id="advCount" style="display:none">0</span></button>
          <button class="btn" id="resetBtn">重置</button>
        </div>
      </div>
      <div class="card-body">
        <div class="screener-toolbar">
          <div class="field screener-search">
            <label>关键词</label>
            <div class="input-group"><svg class="icon"><use href="#i-search"/></svg><input class="input" id="fKeyword" placeholder="基金名称 / 代码 / 经理 / 公司"></div>
          </div>
          <div class="field">
            <label>细分类型</label>
            <select class="select" id="fType"><option value="">全部类型</option></select>
          </div>
          <div class="field">
            <label>评级</label>
            <select class="select" id="fRating">
              <option value="">全部评级</option>
              <option value="5">5 星</option>
              <option value="4">4 星及以上</option>
              <option value="3">3 星及以上</option>
            </select>
          </div>
          <div class="field">
            <label>申购费率</label>
            <select class="select" id="fFee">
              <option value="">不限</option>
              <option value="0.15">≤ 0.15%</option>
              <option value="0.5">≤ 0.50%</option>
              <option value="1">≤ 1.00%</option>
              <option value="1.5">≤ 1.50%</option>
            </select>
          </div>
          <label class="check" id="fourCheck"><input type="checkbox" id="fFour"> 仅看 4433</label>
        </div>

        <div class="filter-quick-row">
          <div class="chip-row" id="categoryChips">
            ${CATEGORIES.map(([value, label]) => `<button class="chip" data-category="${value}">${label}</button>`).join("")}
          </div>
          <div class="preset-row">
            <span class="tiny dim">快速条件</span>
            ${Object.entries(PRESETS).map(([key, preset]) => `<button class="chip" data-preset="${key}">${preset.label}</button>`).join("")}
          </div>
        </div>

        <div class="advanced-filters" id="advancedFilters">
          <div class="filter-group">
            <div class="filter-group-title">收益与规模</div>
            <div class="filter-grid">
              <div class="field"><label>近1年 ≥</label><input class="input" id="fR1y" type="number" step="1" placeholder="%"></div>
              <div class="field"><label>近3年 ≥</label><input class="input" id="fR3y" type="number" step="1" placeholder="%"></div>
              <div class="field"><label>今年来 ≥</label><input class="input" id="fYtd" type="number" step="1" placeholder="%"></div>
              <div class="field"><label>规模 ≥（亿）</label><input class="input" id="fScaleMin" type="number" step="1" placeholder="亿"></div>
              <div class="field"><label>规模 ≤（亿）</label><input class="input" id="fScaleMax" type="number" step="1" placeholder="亿"></div>
              <div class="field"><label>成立年限 ≥</label><input class="input" id="fEstYears" type="number" step="1" placeholder="年"></div>
            </div>
          </div>
          <div class="filter-group">
            <div class="filter-group-title">持有人结构</div>
            <div class="filter-grid">
              <div class="field"><label>机构占比 ≥</label><input class="input" id="fInstMin" type="number" step="1" placeholder="%"></div>
              <div class="field"><label>机构占比 ≤</label><input class="input" id="fInstMax" type="number" step="1" placeholder="%"></div>
              <div class="field"><label>内部持有 ≥</label><input class="input" id="fInternalMin" type="number" step="0.1" placeholder="%"></div>
            </div>
            <label class="check mt-8" id="holderOnlyCheck"><input type="checkbox" id="fHolderOnly"> 仅看已有持有人快照的基金</label>
            <div class="filter-group-note" id="coverageHint">持有人结构为按规模优先建立的本地快照；未覆盖基金不会进入机构/内部筛选。</div>
          </div>
          <div class="filter-group">
            <div class="filter-group-title">经理与公司</div>
            <div class="filter-grid">
              <div class="field"><label>经理年限 ≥</label><input class="input" id="fMgrYears" type="number" step="1" placeholder="年"></div>
              <div class="field"><label>经理在管 ≥（亿）</label><input class="input" id="fMgrAum" type="number" step="1" placeholder="亿"></div>
              <div class="field"><label>基金公司</label><input class="input" id="fCompany" placeholder="如：易方达"></div>
            </div>
          </div>
        </div>
      </div>
    </div>

    <div class="card mt-16 screener-results-card">
      <div class="card-head">
        <div>
          <h3 class="card-title">筛选结果 <span class="badge badge-teal" id="resultCount">—</span></h3>
          <p class="card-sub" id="resultSub">按近一年收益排序</p>
        </div>
        <div class="card-actions"><span class="inline-note" id="coverageNote">—</span></div>
      </div>
      <div class="card-body">
        <div class="stats-strip" id="statsStrip"></div>
        <div class="data-table-wrap mt-12">
          <table class="data-table screener-table">
            <colgroup>
              <col style="width:38px"><col style="width:272px"><col style="width:112px">
              <col style="width:82px"><col style="width:82px"><col style="width:86px">
              <col style="width:118px"><col style="width:110px"><col style="width:82px">
              <col style="width:74px"><col style="width:44px">
            </colgroup>
            <thead>
              <tr>
                <th>#</th>
                <th>基金</th>
                <th>类型</th>
                <th class="num sortable" data-sort="r1y">近1年</th>
                <th class="num sortable" data-sort="r3y">近3年</th>
                <th class="num sortable" data-sort="scale">规模</th>
                <th class="sortable" data-sort="institution">持有人</th>
                <th class="sortable" data-sort="manager_years">经理</th>
                <th class="sortable" data-sort="rating_max">评级</th>
                <th class="num sortable" data-sort="fee">费率</th>
                <th></th>
              </tr>
            </thead>
            <tbody id="screenerBody"></tbody>
          </table>
        </div>
        <div class="pagination" id="pagination"></div>
      </div>
    </div>
  `;

  const inputs = {
    q: $("#fKeyword"), type: $("#fType"), rating: $("#fRating"), fee_max: $("#fFee"),
    four: $("#fFour"), r1y_min: $("#fR1y"), r3y_min: $("#fR3y"), ytd_min: $("#fYtd"),
    scale_min: $("#fScaleMin"), scale_max: $("#fScaleMax"), established_years_min: $("#fEstYears"),
    inst_min: $("#fInstMin"), inst_max: $("#fInstMax"), internal_min: $("#fInternalMin"),
    manager_years_min: $("#fMgrYears"), manager_aum_min: $("#fMgrAum"), company: $("#fCompany"),
    holder_only: $("#fHolderOnly"),
  };

  const syncInputs = () => {
    Object.entries(inputs).forEach(([key, node]) => {
      if (!node) return;
      if (node.type === "checkbox") node.checked = Boolean(state[key]);
      else node.value = state[key] ?? "";
    });
    $("#fourCheck").classList.toggle("on", Boolean(state.four));
    $("#holderOnlyCheck").classList.toggle("on", Boolean(state.holder_only));
    $$("#categoryChips .chip").forEach((chip) => chip.classList.toggle("active", chip.dataset.category === state.category));
    $("#advancedFilters").classList.toggle("open", Boolean(state.advanced));
    $("#advancedBtn").classList.toggle("btn-primary", Boolean(state.advanced));
    const count = advancedCount(state);
    $("#advCount").style.display = count ? "inline-flex" : "none";
    $("#advCount").textContent = count;
  };

  const readInputs = () => {
    Object.entries(inputs).forEach(([key, node]) => {
      if (!node) return;
      state[key] = node.type === "checkbox" ? node.checked : node.value.trim();
    });
    saveState(state);
    syncInputs();
  };

  const updateSort = () => {
    $$("th[data-sort]").forEach((th) => {
      const ind = th.querySelector(".sort-ind");
      if (state.sort === th.dataset.sort) {
        th.innerHTML = `${th.textContent.replace(/[▲▼]\s*$/, "").trim()} <span class="sort-ind">${state.order === "desc" ? "▼" : "▲"}</span>`;
      } else if (ind) {
        ind.remove();
      }
    });
    $("#resultSub").textContent = `按${
      { r1y: "近一年收益", r3y: "近三年收益", scale: "规模", institution: "机构占比", internal: "内部持有", manager_years: "经理年限", fee: "申购费率", rating_max: "评级" }[state.sort] || state.sort
    }${state.order === "desc" ? "降序" : "升序"}`;
  };

  let requestId = 0;
  const load = async () => {
    const current = ++requestId;
    $("#screenerBody").innerHTML = `<tr><td colspan="11"><div class="skeleton" style="height:160px"></div></td></tr>`;
    try {
      const data = await api.screener({
        q: state.q, category: state.category, type: state.type, rating: state.rating,
        fee_max: state.fee_max, r1y_min: state.r1y_min, r3y_min: state.r3y_min, ytd_min: state.ytd_min,
        inst_min: state.inst_min, inst_max: state.inst_max, internal_min: state.internal_min,
        scale_min: state.scale_min, scale_max: state.scale_max,
        manager_years_min: state.manager_years_min, manager_aum_min: state.manager_aum_min,
        established_years_min: state.established_years_min, company: state.company,
        four: state.four ? "1" : "", holder_only: state.holder_only ? "1" : "",
        sort: state.sort, order: state.order, page: state.page, page_size: 25,
      });
      if (current !== requestId || !el.isConnected) return;
      const pages = Math.max(1, Math.ceil(data.total / data.page_size));
      if (state.page > pages) {
        state.page = 1;
        saveState(state);
        return load();
      }
      if ($("#fType").options.length <= 1) {
        data.facets.types.forEach((item) => {
          const opt = document.createElement("option");
          opt.value = item.name;
          opt.textContent = `${item.name}（${item.count}）`;
          $("#fType").appendChild(opt);
        });
      }
      $("#fType").value = state.type || "";
      $("#resultCount").textContent = `${data.total.toLocaleString("en-US")} 只`;
      $("#coverageNote").textContent = `持有人快照 ${data.coverage.holders.toLocaleString("en-US")} 只 · 规模覆盖 ${data.coverage.scales.toLocaleString("en-US")} 只`;
      $("#filterCoverage").textContent = `持有人覆盖 ${data.coverage.holders.toLocaleString("en-US")} 只`;
      $("#statsStrip").innerHTML = `
        <div class="stat"><div class="stat-label">匹配基金</div><div class="stat-value">${data.total.toLocaleString("en-US")}</div></div>
        <div class="stat"><div class="stat-label">近1年中位数</div><div class="stat-value ${tone(data.stats.median_r1y)}">${fmtPct(data.stats.median_r1y)}</div></div>
        <div class="stat"><div class="stat-label">规模中位数</div><div class="stat-value">${data.stats.median_scale ? fmtYi(data.stats.median_scale) : "—"}</div></div>
        <div class="stat"><div class="stat-label">持有人样本</div><div class="stat-value">${Number(data.stats.holder_filtered || 0).toLocaleString("en-US")}</div></div>
        <div class="stat"><div class="stat-label">机构占比中位数</div><div class="stat-value">${data.stats.median_institution ?? "—"}%</div></div>
        <div class="stat"><div class="stat-label">高机构（≥30%）</div><div class="stat-value">${Number(data.stats.high_institution || 0).toLocaleString("en-US")}</div></div>
        <div class="stat"><div class="stat-label">4433 入选</div><div class="stat-value" style="color:var(--gold)">${Number(data.stats.four_count || 0).toLocaleString("en-US")}</div></div>
      `;
      $("#screenerBody").innerHTML = data.rows.length
        ? data.rows.map((row, index) => rowHtml(row, index, state, data.page_size)).join("")
        : `<tr><td colspan="11"><div class="empty">没有符合条件的基金，试试放宽筛选条件</div></td></tr>`;

      const pageButtons = [];
      const start = Math.max(1, state.page - 2);
      const end = Math.min(pages, state.page + 2);
      if (start > 1) pageButtons.push(`<button class="page-btn" data-page="1">1</button>`, start > 2 ? '<span class="dim">…</span>' : "");
      for (let p = start; p <= end; p += 1) pageButtons.push(`<button class="page-btn ${p === state.page ? "active" : ""}" data-page="${p}">${p}</button>`);
      if (end < pages) pageButtons.push(end < pages - 1 ? '<span class="dim">…</span>' : "", `<button class="page-btn" data-page="${pages}">${pages}</button>`);
      $("#pagination").innerHTML = `
        <span class="page-info">共 ${data.total.toLocaleString("en-US")} 只 · 第 ${state.page} / ${pages} 页</span>
        <button class="page-btn" data-page="${state.page - 1}" ${state.page <= 1 ? "disabled" : ""}>‹</button>
        ${pageButtons.join("")}
        <button class="page-btn" data-page="${state.page + 1}" ${state.page >= pages ? "disabled" : ""}>›</button>`;

      $$("#pagination [data-page]").forEach((btn) => {
        btn.addEventListener("click", () => {
          const page = Number(btn.dataset.page);
          if (page >= 1 && page <= pages && page !== state.page) {
            state.page = page;
            saveState(state);
            load();
          }
        });
      });
      $$("#screenerBody tr[data-code]").forEach((tr) => {
        const code = tr.dataset.code;
        tr.addEventListener("click", () => { location.hash = `#/fund/${code}`; });
        tr.querySelector("[data-add]").addEventListener("click", (event) => {
          event.stopPropagation();
          const row = data.rows[Number(tr.dataset.index)];
          const result = addToPortfolio({ code: row.code, name: row.name });
          toast(result.added ? `已加入组合：${row.name}` : `${row.name} 已在组合中`, "success");
        });
      });
      updateSort();
    } catch (error) {
      if (current !== requestId || !el.isConnected) return;
      $("#screenerBody").innerHTML = `<tr><td colspan="11"><div class="error-box">${escapeHtml(error.message)}</div></td></tr>`;
    }
  };

  const reloadFirstPage = () => {
    state.page = 1;
    readInputs();
    saveState(state);
    load();
  };
  const debouncedReload = debounce(reloadFirstPage, 350);

  ["q", "r1y_min", "r3y_min", "ytd_min", "scale_min", "scale_max", "established_years_min",
    "inst_min", "inst_max", "internal_min", "manager_years_min", "manager_aum_min", "company"].forEach((key) => {
    inputs[key].addEventListener("input", debouncedReload);
  });
  ["type", "rating", "fee_max"].forEach((key) => inputs[key].addEventListener("change", reloadFirstPage));
  inputs.four.addEventListener("change", () => {
    state.four = inputs.four.checked;
    $("#fourCheck").classList.toggle("on", state.four);
    reloadFirstPage();
  });
  inputs.holder_only.addEventListener("change", () => {
    state.holder_only = inputs.holder_only.checked;
    $("#holderOnlyCheck").classList.toggle("on", state.holder_only);
    reloadFirstPage();
  });
  $$("#categoryChips .chip").forEach((chip) => {
    chip.addEventListener("click", () => {
      state.category = chip.dataset.category;
      readInputs();
      reloadFirstPage();
    });
  });
  $$("th[data-sort]").forEach((th) => {
    th.addEventListener("click", () => {
      const key = th.dataset.sort;
      if (state.sort === key) state.order = state.order === "desc" ? "asc" : "desc";
      else {
        state.sort = key;
        state.order = key === "fee" ? "asc" : "desc";
      }
      state.page = 1;
      saveState(state);
      load();
    });
  });
  $("#advancedBtn").addEventListener("click", () => {
    state.advanced = !state.advanced;
    saveState(state);
    syncInputs();
  });
  $$("[data-preset]").forEach((btn) => {
    btn.addEventListener("click", () => {
      const preset = PRESETS[btn.dataset.preset];
      Object.assign(state, { ...DEFAULTS, q: state.q, category: state.category, type: state.type, advanced: true }, preset);
      syncInputs();
      saveState(state);
      load();
    });
  });
  $("#resetBtn").addEventListener("click", () => {
    Object.assign(state, { ...DEFAULTS });
    syncInputs();
    saveState(state);
    load();
  });
  $("#ruleBtn").addEventListener("click", () => {
    openModal("4433 选基法则", `
      <div class="about-text">
        <p><strong>规则：</strong>近 1 年、近 2 年、近 3 年、今年以来的收益，均排在同类基金前 25%。</p>
        <p><strong>本看板实现：</strong>按天天基金细分类型分组计算每个区间的 75 分位数；四个区间均有业绩且全部达标，才标记为 4433。</p>
        <p><strong>新增维度：</strong>机构占比 / 内部持有来自按规模优先构建的持有人快照；规模与经理年限为补充维度。持有人快照未覆盖的基金，在对应筛选中不会出现。</p>
      </div>`);
  });

  syncInputs();
  await load();
}
