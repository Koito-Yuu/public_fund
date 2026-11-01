function buildQuery(params = {}) {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === null || value === "") continue;
    search.set(key, value);
  }
  const text = search.toString();
  return text ? `?${text}` : "";
}

async function request(path, options = {}) {
  let response;
  try {
    response = await fetch(path, {
      headers: { "Content-Type": "application/json" },
      ...options,
    });
  } catch (error) {
    throw new Error("网络请求失败，请确认服务仍在运行");
  }
  let payload = null;
  try {
    payload = await response.json();
  } catch (error) {
    throw new Error(`接口返回异常（HTTP ${response.status}）`);
  }
  if (!response.ok) {
    throw new Error(payload?.error || `请求失败（HTTP ${response.status}）`);
  }
  return payload;
}

export const api = {
  meta: () => request("/api/meta"),
  market: (quarter) => request(`/api/market${buildQuery({ quarter })}`),
  screener: (params) => request(`/api/screener${buildQuery(params)}`),
  fund: (code) => request(`/api/fund/${code}`),
  fundReport: (code, type = "latest") => request(`/api/fund/${code}/report${buildQuery({ type })}`),
  managers: (params) => request(`/api/managers${buildQuery(params)}`),
  manager: (name, company) => request(`/api/manager/${encodeURIComponent(name)}${buildQuery({ company })}`),
  portfolio: (items, span = "3y") =>
    request("/api/portfolio", { method: "POST", body: JSON.stringify({ items, span }) }),
  portfolios: () => request("/api/portfolios"),
  savePortfolio: (name, items) =>
    request("/api/portfolios", { method: "POST", body: JSON.stringify({ name, items }) }),
  deletePortfolio: (id) =>
    request(`/api/portfolios/${id}`, { method: "DELETE" }),
  stocks: (params) => request(`/api/stocks${buildQuery(params)}`),
  stock: (code, quarter) => request(`/api/stock/${code}${buildQuery({ quarter })}`),
  search: (query) => request(`/api/search${buildQuery({ q: query })}`),
};
