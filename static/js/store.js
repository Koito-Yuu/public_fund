const PF_KEY = "fundscope.portfolio.v1";
const RECENT_KEY = "fundscope.recent.v1";
const QUARTER_KEY = "fundscope.quarter.v1";

function read(key, fallback) {
  try {
    const raw = localStorage.getItem(key);
    return raw ? JSON.parse(raw) : fallback;
  } catch (error) {
    return fallback;
  }
}

function write(key, value) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch (error) {
    /* storage may be unavailable */
  }
}

export function getPortfolio() {
  const items = read(PF_KEY, []);
  return Array.isArray(items) ? items : [];
}

export function setPortfolio(items) {
  write(PF_KEY, items);
  return items;
}

export function addToPortfolio(fund, weight = 20) {
  const items = getPortfolio();
  const existing = items.find((item) => item.code === fund.code);
  if (existing) {
    existing.name = fund.name || existing.name;
    setPortfolio(items);
    return { added: false, item: existing };
  }
  const item = { code: fund.code, name: fund.name, weight };
  items.push(item);
  setPortfolio(items);
  return { added: true, item };
}

export function removeFromPortfolio(code) {
  const items = getPortfolio().filter((item) => item.code !== code);
  setPortfolio(items);
  return items;
}

export function clearPortfolio() {
  setPortfolio([]);
}

export function getRecent() {
  const items = read(RECENT_KEY, []);
  return Array.isArray(items) ? items : [];
}

export function addRecent(fund) {
  if (!fund?.code) return;
  const items = getRecent().filter((item) => item.code !== fund.code);
  items.unshift({ code: fund.code, name: fund.name, type: fund.type, ts: Date.now() });
  write(RECENT_KEY, items.slice(0, 8));
}

export function getLastQuarter() {
  return localStorage.getItem(QUARTER_KEY) || "";
}

export function setLastQuarter(quarter) {
  if (quarter) localStorage.setItem(QUARTER_KEY, quarter);
}
