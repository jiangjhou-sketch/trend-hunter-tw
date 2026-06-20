const state = {
  market: "listed",
  scan: null,
  selected: null,
  chartRows: [],
  chartMode: "price",
  chart: null
};

const el = (id) => document.getElementById(id);
const fmt = (n, digits = 2) => Number.isFinite(n) ? n.toLocaleString("zh-TW", { maximumFractionDigits: digits }) : "-";
const lots = (sharesOrLots) => fmt(sharesOrLots, 0);
const priceClass = (n) => Number(n) >= 0 ? "up" : "down";

function setStatus(text) {
  el("status").textContent = text;
}

async function api(path, timeoutMs = 120000) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(path, { signal: controller.signal });
    const data = await res.json();
    if (!res.ok || data.error) throw new Error(data.error || `HTTP ${res.status}`);
    return data;
  } catch (error) {
    if (error.name === "AbortError") throw new Error("連線逾時，請稍後再重新掃描");
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

async function runScan(options = {}) {
  const refreshBtn = el("refreshBtn");
  refreshBtn.disabled = true;
  refreshBtn.textContent = "掃描中";
  const startedAt = new Date().toLocaleTimeString("zh-TW", { hour: "2-digit", minute: "2-digit", second: "2-digit" });
  setStatus(`${options.force ? "強制重新掃描" : "掃描中"}，開始 ${startedAt}`);
  el("stockList").innerHTML = `<div class="empty">正在分析漲幅排行、至少連續 2 日均量條件與技術指標...</div>`;

  try {
    const refresh = options.force ? "&refresh=1" : "";
    const data = await api(`/api/scan?market=${state.market}${refresh}&_=${Date.now()}`, 180000);
    state.scan = data;
    state.selected = data.candidates[0] || null;
    renderScan(data);
    if (state.selected) await loadDetail(state.selected);
    else clearDetail();
    setStatus(`掃描完成 ${new Date().toLocaleTimeString("zh-TW", { hour: "2-digit", minute: "2-digit", second: "2-digit" })}`);
  } catch (error) {
    setStatus(`發生錯誤：${error.message}`);
    el("stockList").innerHTML = `<div class="empty">無法完成掃描：${error.message}</div>`;
  } finally {
    refreshBtn.disabled = false;
    refreshBtn.textContent = "重新掃描";
  }
}

function renderScan(data) {
  el("totalCount").textContent = data.total;
  el("candidateCount").textContent = data.candidates.length;
  el("recommendCount").textContent = data.recommendations.length;
  el("scanTime").textContent = new Date(data.scannedAt).toLocaleTimeString("zh-TW", { hour: "2-digit", minute: "2-digit" });
  el("sourceLabel").textContent = state.market === "listed" ? "上市" : state.market === "otc" ? "上櫃" : "上市 + 上櫃";

  if (!data.candidates.length) {
    el("stockList").innerHTML = `<div class="empty">目前沒有股票符合至少連續 2 日的量能條件。</div>`;
    return;
  }

  el("stockList").innerHTML = data.candidates.map((item) => `
    <button class="stock-item ${state.selected?.symbol === item.symbol ? "active" : ""}" data-symbol="${item.symbol}">
      <div>
        <div class="stock-name">
          <span>${item.name}</span>
          <span class="stock-symbol">${item.symbol}</span>
        </div>
        <div class="list-price-row">
          <strong class="list-price">${fmt(item.price)}</strong>
          <span class="${priceClass(item.change)}">+${fmt(item.change)} / +${fmt(item.changePercent)}%</span>
        </div>
        <div class="stock-meta">排行 ${item.rank}｜成交 ${lots(item.volume)} 張｜連續 ${item.summary.streak} 日</div>
        <div class="stock-reason">${item.ai.reasons[0] || "符合量能條件"}</div>
      </div>
      <div class="score-badge" title="AI推薦分數，滿分100">
        <span>AI分數</span>
        <strong>${item.ai.score}</strong>
      </div>
    </button>
  `).join("");

  document.querySelectorAll(".stock-item").forEach((btn) => {
    btn.addEventListener("click", async () => {
      const item = state.scan.candidates.find((row) => row.symbol === btn.dataset.symbol);
      state.selected = item;
      renderScan(state.scan);
      await loadDetail(item);
    });
  });
}

async function loadDetail(item) {
  el("detailTitle").textContent = `${item.name} ${item.symbol}`;
  el("detailSub").textContent = `AI分數 ${item.ai.score}｜成交 ${lots(item.volume)} 張｜5日均量 / 20日均量 ${fmt(item.summary.volumeMomentum)} 倍`;
  el("yahooLink").href = `https://tw.stock.yahoo.com/quote/${item.symbol}`;
  renderPriceStrip(item);
  renderReasons(item);
  setStatus(`載入 ${item.name} 技術圖表...`);
  const data = await api(`/api/chart?symbol=${encodeURIComponent(item.symbol)}`, 30000);
  state.chartRows = data.rows;
  drawChart();
  await loadInstitutional(item);
  await loadBrokerBranches(item);
  setStatus("圖表完成");
}

function renderPriceStrip(item) {
  const changeText = `${item.change >= 0 ? "+" : ""}${fmt(item.change)} / ${item.changePercent >= 0 ? "+" : ""}${fmt(item.changePercent)}%`;
  const metrics = [
    ["現價", fmt(item.price), "price-main"],
    ["漲跌 / 漲幅", changeText, priceClass(item.change)],
    ["最高", fmt(item.high), ""],
    ["最低", fmt(item.low), ""],
    ["成交量", `${lots(item.volume)} 張`, ""],
    ["資料日期", item.dataDate || "-", ""]
  ];
  el("priceStrip").innerHTML = metrics.map(([label, value, cls]) => `
    <div class="price-card">
      <span>${label}</span>
      <strong class="${cls}">${value}</strong>
    </div>
  `).join("");
}

function renderReasons(item) {
  const latest = item.summary.latest;
  const metrics = [
    ["AI推薦理由", item.ai.reasons.join("、") || "符合量能篩選"],
    ["成交量", `最新 ${lots(latest.volumeLots)} 張，5日均量 ${lots(latest.volMa5Lots)} 張`],
    ["MACD / KD", `${item.summary.macdBull ? "MACD多方" : "MACD未轉強"}，${item.summary.kdBull ? "KD多方" : "KD保守"}`],
    ["大戶推估", `400張 ${fmt(latest.large400Change, 0)} 張，1000張 ${fmt(latest.large1000Change, 0)} 張`]
  ];
  el("recommendBox").innerHTML = metrics.map(([label, value]) => `
    <div class="reason-pill"><span>${label}</span><strong>${value}</strong></div>
  `).join("");
}

function clearDetail() {
  el("detailTitle").textContent = "沒有符合條件的股票";
  el("detailSub").textContent = "請稍後重新掃描，或切換市場。";
  el("priceStrip").innerHTML = "";
  el("institutionSummary").innerHTML = "";
  el("institutionTable").innerHTML = "";
  el("recommendBox").innerHTML = "";
  el("brokerStatus").textContent = "選取股票後查詢分點資料。";
  el("brokerBuy").innerHTML = "";
  el("brokerSell").innerHTML = "";
  if (state.chart) state.chart.clear();
}

async function loadInstitutional(item) {
  const days = el("institutionDays").value || "5";
  el("institutionSummary").innerHTML = `<div class="broker-empty">法人資料讀取中...</div>`;
  el("institutionTable").innerHTML = "";
  try {
    const data = await api(`/api/institution?symbol=${encodeURIComponent(item.symbol)}&days=${days}`, 45000);
    renderInstitutional(data);
  } catch (error) {
    el("institutionSummary").innerHTML = `<div class="broker-empty">法人資料讀取失敗：${error.message}</div>`;
  }
}

function renderInstitutional(data) {
  const streakText = data.buyStreak > 0 ? `連買 ${data.buyStreak} 日` : data.sellStreak > 0 ? `連賣 ${data.sellStreak} 日` : "多空未連續";
  const forceClass = priceClass(data.totalLots);
  el("institutionSummary").innerHTML = `
    <div class="price-card">
      <span>籌碼集中度</span>
      <strong class="price-main">${data.concentrationScore}</strong>
    </div>
    <div class="price-card">
      <span>法人天數</span>
      <strong>${streakText}</strong>
    </div>
    <div class="price-card">
      <span>${data.days}日合計</span>
      <strong class="${forceClass}">${fmt(data.totalLots, 0)} 張</strong>
    </div>
    <div class="price-card">
      <span>法人力度</span>
      <strong class="${forceClass}">${fmt(data.strength, 1)}%</strong>
    </div>
  `;

  if (!data.rows?.length) {
    el("institutionTable").innerHTML = `<div class="broker-empty">查無法人買賣資料。</div>`;
    return;
  }
  el("institutionTable").innerHTML = `
    <table>
      <thead>
        <tr>
          <th>日期</th>
          <th>外資</th>
          <th>投信</th>
          <th>自營商</th>
          <th>合計</th>
          <th>力度</th>
        </tr>
      </thead>
      <tbody>
        ${data.rows.map((row) => `
          <tr>
            <td>${row.date}</td>
            <td>${fmt(row.foreignLots, 0)}</td>
            <td>${fmt(row.investmentTrustLots, 0)}</td>
            <td>${fmt(row.dealerLots, 0)}</td>
            <td class="${priceClass(row.totalLots)}">${fmt(row.totalLots, 0)}</td>
            <td class="${priceClass(row.force)}">${fmt(row.force * 100, 1)}%</td>
          </tr>
        `).join("")}
      </tbody>
    </table>
    <div class="broker-status">資料來源：${data.source}。法人力度 = 法人買賣超張數 / 當日成交張數。</div>
  `;
}

async function loadBrokerBranches(item) {
  const days = el("brokerDays").value || "5";
  el("brokerStatus").textContent = `查詢 ${item.name} 近 ${days} 日券商分點...`;
  el("brokerBuy").innerHTML = `<div class="broker-empty">讀取中...</div>`;
  el("brokerSell").innerHTML = `<div class="broker-empty">讀取中...</div>`;
  try {
    const data = await api(`/api/brokers?symbol=${encodeURIComponent(item.symbol)}&days=${days}`, 30000);
    renderBrokerBranches(data);
  } catch (error) {
    el("brokerStatus").textContent = `分點資料讀取失敗：${error.message}`;
    el("brokerBuy").innerHTML = "";
    el("brokerSell").innerHTML = "";
  }
}

function renderBrokerTable(rows) {
  if (!rows.length) return `<div class="broker-empty">目前沒有可直接顯示的結構化分點資料。</div>`;
  return `
    <table>
      <thead>
        <tr><th>#</th><th>分點</th><th>買進</th><th>賣出</th><th>買賣超</th></tr>
      </thead>
      <tbody>
        ${rows.slice(0, 15).map((row, index) => `
          <tr>
            <td>${index + 1}</td>
            <td>${row.name}</td>
            <td>${fmt(row.buy, 0)}</td>
            <td>${fmt(row.sell, 0)}</td>
            <td class="${priceClass(row.net)}">${fmt(row.net, 0)}</td>
          </tr>
        `).join("")}
      </tbody>
    </table>
  `;
}

function renderBrokerBranches(data) {
  el("brokerBuy").innerHTML = renderBrokerTable(data.buyTop || []);
  el("brokerSell").innerHTML = renderBrokerTable(data.sellTop || []);
  el("brokerStatus").innerHTML = `
    <span>${data.message}</span>
    <a href="${data.sourceUrl}" target="_blank" rel="noreferrer">CMoney分點頁</a>
    <a href="${data.officialUrl}" target="_blank" rel="noreferrer">官方資料頁</a>
  `;
}

function drawChart() {
  if (!state.chart) state.chart = echarts.init(el("chart"));
  const rows = state.chartRows.slice(-140);
  const dates = rows.map((r) => r.date);
  const option = state.chartMode === "macd" ? macdOption(rows, dates)
    : state.chartMode === "kd" ? kdOption(rows, dates)
    : state.chartMode === "chip" ? chipOption(rows, dates)
    : priceOption(rows, dates);
  state.chart.setOption(option, true);
}

function baseOption(dates) {
  return {
    animation: false,
    color: ["#2563eb", "#0f766e", "#f59e0b", "#ef4444", "#38bdf8", "#7c3aed"],
    tooltip: { trigger: "axis", axisPointer: { type: "cross" } },
    legend: { top: 8, textStyle: { color: "#52616f" } },
    grid: [{ left: 58, right: 28, top: 48, bottom: 72 }],
    xAxis: [{ type: "category", data: dates, boundaryGap: false }],
    yAxis: [{ scale: true }],
    dataZoom: [{ type: "inside" }, { type: "slider", height: 22, bottom: 22 }]
  };
}

function priceOption(rows, dates) {
  const option = baseOption(dates);
  option.legend.data = ["K線", "MA5", "MA20", "布林上緣", "布林下緣", "成交量(張)"];
  option.grid = [
    { left: 58, right: 28, top: 48, height: 310 },
    { left: 58, right: 28, top: 390, height: 82 }
  ];
  option.xAxis = [
    { type: "category", data: dates, boundaryGap: true },
    { type: "category", data: dates, gridIndex: 1, boundaryGap: true, axisLabel: { show: false } }
  ];
  option.yAxis = [
    { scale: true },
    { gridIndex: 1, scale: true, name: "張" }
  ];
  option.series = [
    { name: "K線", type: "candlestick", data: rows.map((r) => [r.open, r.close, r.low, r.high]) },
    { name: "MA5", type: "line", data: rows.map((r) => r.ma5), smooth: true, showSymbol: false },
    { name: "MA20", type: "line", data: rows.map((r) => r.ma20), smooth: true, showSymbol: false },
    { name: "布林上緣", type: "line", data: rows.map((r) => r.bbUpper), showSymbol: false, lineStyle: { type: "dashed" } },
    { name: "布林下緣", type: "line", data: rows.map((r) => r.bbLower), showSymbol: false, lineStyle: { type: "dashed" } },
    { name: "成交量(張)", type: "bar", xAxisIndex: 1, yAxisIndex: 1, data: rows.map((r) => r.volumeLots) }
  ];
  return option;
}

function macdOption(rows, dates) {
  const option = baseOption(dates);
  option.legend.data = ["DIF", "Signal", "Histogram"];
  option.series = [
    { name: "DIF", type: "line", data: rows.map((r) => r.macd), showSymbol: false },
    { name: "Signal", type: "line", data: rows.map((r) => r.macdSignal), showSymbol: false },
    { name: "Histogram", type: "bar", data: rows.map((r) => r.macdHist) }
  ];
  return option;
}

function kdOption(rows, dates) {
  const option = baseOption(dates);
  option.legend.data = ["K", "D", "80", "20"];
  option.yAxis = [{ min: 0, max: 100 }];
  option.series = [
    { name: "K", type: "line", data: rows.map((r) => r.k), showSymbol: false },
    { name: "D", type: "line", data: rows.map((r) => r.d), showSymbol: false },
    { name: "80", type: "line", data: rows.map(() => 80), showSymbol: false, lineStyle: { type: "dashed" } },
    { name: "20", type: "line", data: rows.map(() => 20), showSymbol: false, lineStyle: { type: "dashed" } }
  ];
  return option;
}

function chipOption(rows, dates) {
  const option = baseOption(dates);
  option.legend.data = ["400張大戶推估增減", "1000張大戶推估增減", "5日量比"];
  option.yAxis = [
    { scale: true, name: "張" },
    { scale: true, name: "倍" }
  ];
  option.series = [
    { name: "400張大戶推估增減", type: "bar", data: rows.map((r) => r.large400Change) },
    { name: "1000張大戶推估增減", type: "bar", data: rows.map((r) => r.large1000Change) },
    { name: "5日量比", type: "line", yAxisIndex: 1, data: rows.map((r) => r.volSurge), showSymbol: false }
  ];
  return option;
}

document.querySelectorAll(".segmented button").forEach((btn) => {
  btn.addEventListener("click", () => {
    document.querySelectorAll(".segmented button").forEach((b) => b.classList.remove("active"));
    btn.classList.add("active");
    state.market = btn.dataset.market;
    runScan();
  });
});

document.querySelectorAll(".chart-tabs button").forEach((btn) => {
  btn.addEventListener("click", () => {
    document.querySelectorAll(".chart-tabs button").forEach((b) => b.classList.remove("active"));
    btn.classList.add("active");
    state.chartMode = btn.dataset.chart;
    drawChart();
  });
});

el("refreshBtn").addEventListener("click", () => runScan({ force: true }));
el("brokerDays").addEventListener("change", () => {
  if (state.selected) loadBrokerBranches(state.selected);
});
el("institutionDays").addEventListener("change", () => {
  if (state.selected) loadInstitutional(state.selected);
});
window.addEventListener("resize", () => state.chart?.resize());
runScan();
