import http from "node:http";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const publicDir = path.join(__dirname, "public");
const nodeProcess = globalThis.process;
const port = Number(nodeProcess?.env?.PORT || 4173);

const cache = new Map();
const CACHE_MS = {
  rank: 3 * 60 * 1000,
  chart: 30 * 60 * 1000,
  scan: 5 * 60 * 1000,
  institution: 12 * 60 * 60 * 1000
};

const rankUrls = {
  all: "https://tw.stock.yahoo.com/rank/change-up",
  listed: "https://tw.stock.yahoo.com/rank/change-up?exchange=TAI",
  otc: "https://tw.stock.yahoo.com/rank/change-up?exchange=TWO"
};

function clearCache(prefix) {
  for (const key of cache.keys()) {
    if (key.startsWith(prefix)) cache.delete(key);
  }
}

function cached(key, ttl, factory) {
  const item = cache.get(key);
  if (item && Date.now() - item.time < ttl) return item.value;
  const value = Promise.resolve(factory()).then((data) => {
    cache.set(key, { time: Date.now(), value: Promise.resolve(data) });
    return data;
  });
  cache.set(key, { time: Date.now(), value });
  return value;
}

async function fetchText(url) {
  const res = await fetch(url, {
    signal: AbortSignal.timeout(15000),
    headers: {
      "user-agent": "Mozilla/5.0 stock screener research tool",
      accept: "text/html,application/xhtml+xml,application/json"
    }
  });
  if (!res.ok) throw new Error(`Fetch failed ${res.status}: ${url}`);
  return res.text();
}

function htmlToLines(html) {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<style[\s\S]*?<\/style>/gi, "")
    .replace(/<[^>]+>/g, "\n")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&#x2F;/g, "/")
    .split(/\n+/)
    .map((line) => line.trim())
    .filter(Boolean);
}

function toNumber(value) {
  if (value == null) return null;
  const n = Number(String(value).replace(/[,%]/g, ""));
  return Number.isFinite(n) ? n : null;
}

function toInt(value) {
  const n = Number(String(value ?? "").replace(/[,]/g, ""));
  return Number.isFinite(n) ? n : 0;
}

function parseRank(html, market) {
  const lines = htmlToLines(html);
  const dataDate = (lines.find((line) => line.startsWith("資料時間：")) || "").replace("資料時間：", "");
  const rows = [];
  for (let i = 0; i < lines.length; i += 1) {
    if (!/^\d{4,6}\.(TW|TWO)$/.test(lines[i])) continue;
    const symbol = lines[i];
    const name = lines[i - 1] || symbol;
    const values = lines.slice(i + 1, i + 9);
    if (values.length < 8) continue;
    rows.push({
      rank: rows.length + 1,
      name,
      symbol,
      market: symbol.endsWith(".TW") ? "listed" : "otc",
      price: toNumber(values[0]),
      change: toNumber(values[1]),
      changePercent: toNumber(values[2]),
      high: toNumber(values[3]),
      low: toNumber(values[4]),
      spread: toNumber(values[5]),
      volume: toNumber(values[6]),
      amount: toNumber(values[7]),
      dataDate
    });
  }
  return market === "all" ? rows.slice(0, 100) : rows.filter((row) => row.market === market).slice(0, 100);
}

export async function getRank(market = "all") {
  const normalized = rankUrls[market] ? market : "all";
  return cached(`rank:${normalized}`, CACHE_MS.rank, async () => {
    const html = await fetchText(rankUrls[normalized]);
    return parseRank(html, normalized);
  });
}

export async function getChart(symbol) {
  if (!/^\d{4,6}\.(TW|TWO)$/.test(symbol)) throw new Error("Invalid Taiwan stock symbol");
  return cached(`chart:${symbol}`, CACHE_MS.chart, async () => {
    const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?range=1y&interval=1d&events=history`;
    const res = await fetch(url, {
      signal: AbortSignal.timeout(15000),
      headers: { "user-agent": "Mozilla/5.0" }
    });
    if (!res.ok) throw new Error(`Chart fetch failed ${res.status}`);
    const json = await res.json();
    const result = json.chart?.result?.[0];
    if (!result) throw new Error(json.chart?.error?.description || "No chart data");
    const q = result.indicators?.quote?.[0] || {};
    const timestamps = result.timestamp || [];
    const rows = timestamps.map((time, index) => ({
      date: new Date(time * 1000).toISOString().slice(0, 10),
      open: q.open?.[index] ?? null,
      high: q.high?.[index] ?? null,
      low: q.low?.[index] ?? null,
      close: q.close?.[index] ?? null,
      volume: q.volume?.[index] ?? null
    })).filter((row) => [row.open, row.high, row.low, row.close, row.volume].every((v) => Number.isFinite(v)));
    return withIndicators(rows);
  });
}

function average(values) {
  const valid = values.filter((v) => Number.isFinite(v));
  return valid.length ? valid.reduce((a, b) => a + b, 0) / valid.length : null;
}

function std(values) {
  const mean = average(values);
  if (!Number.isFinite(mean)) return null;
  const valid = values.filter((v) => Number.isFinite(v));
  return Math.sqrt(valid.reduce((sum, v) => sum + (v - mean) ** 2, 0) / valid.length);
}

function ema(values, period) {
  const out = [];
  const k = 2 / (period + 1);
  let prev = null;
  values.forEach((value, index) => {
    if (!Number.isFinite(value)) {
      out[index] = null;
      return;
    }
    prev = prev == null ? value : value * k + prev * (1 - k);
    out[index] = prev;
  });
  return out;
}

function withIndicators(rows) {
  const closes = rows.map((r) => r.close);
  const volumes = rows.map((r) => r.volume);
  const ema12 = ema(closes, 12);
  const ema26 = ema(closes, 26);
  const dif = closes.map((_, i) => (ema12[i] != null && ema26[i] != null ? ema12[i] - ema26[i] : null));
  const macdSignal = ema(dif, 9);
  let k = 50;
  let d = 50;
  return rows.map((row, i) => {
    const close20 = closes.slice(Math.max(0, i - 19), i + 1);
    const vol5 = average(volumes.slice(Math.max(0, i - 4), i + 1));
    const vol20 = average(volumes.slice(Math.max(0, i - 19), i + 1));
    const ma20 = average(close20);
    const sd20 = std(close20);
    const recent9 = rows.slice(Math.max(0, i - 8), i + 1);
    const high9 = Math.max(...recent9.map((r) => r.high));
    const low9 = Math.min(...recent9.map((r) => r.low));
    const rsv = high9 === low9 ? 50 : ((row.close - low9) / (high9 - low9)) * 100;
    k = (2 / 3) * k + (1 / 3) * rsv;
    d = (2 / 3) * d + (1 / 3) * k;
    const hist = dif[i] != null && macdSignal[i] != null ? dif[i] - macdSignal[i] : null;
    const volumeLots = row.volume / 1000;
    const range = row.high - row.low;
    const pricePressure = range > 0 ? (row.close - row.open) / range : Math.sign(row.close - row.open);
    const volumePressure = vol20 ? Math.min(row.volume / vol20, 3) : 1;
    const estimatedLargeLots = volumeLots * pricePressure * volumePressure;
    return {
      ...row,
      volumeLots,
      ma5: average(closes.slice(Math.max(0, i - 4), i + 1)),
      ma20,
      volMa5: vol5,
      volMa20: vol20,
      volMa5Lots: vol5 != null ? vol5 / 1000 : null,
      volMa20Lots: vol20 != null ? vol20 / 1000 : null,
      volSurge: vol5 != null && vol20 ? vol5 / vol20 : null,
      macd: dif[i],
      macdSignal: macdSignal[i],
      macdHist: hist,
      k,
      d,
      bbUpper: ma20 != null && sd20 != null ? ma20 + sd20 * 2 : null,
      bbLower: ma20 != null && sd20 != null ? ma20 - sd20 * 2 : null,
      large400Change: estimatedLargeLots * 0.45,
      large1000Change: estimatedLargeLots * 0.2,
      bigMoneyProxy: vol20 ? ((row.close - row.open) / row.open) * (row.volume / vol20) : null
    };
  });
}

function summarizeChart(rows) {
  const latest = rows.at(-1);
  let streak = 0;
  for (let i = rows.length - 1; i >= 0; i -= 1) {
    if (rows[i].volMa5 > rows[i].volMa20) streak += 1;
    else break;
  }
  const prev = rows.at(-2);
  return {
    latest,
    streak,
    pass: streak >= 2,
    macdBull: latest?.macd > latest?.macdSignal,
    kdBull: latest?.k > latest?.d,
    priceAboveMa20: latest?.close > latest?.ma20,
    bollingerPosition: latest?.bbUpper && latest?.bbLower
      ? (latest.close - latest.bbLower) / (latest.bbUpper - latest.bbLower)
      : null,
    bigMoneyTrend: average(rows.slice(-5).map((r) => r.bigMoneyProxy)),
    volumeMomentum: latest?.volSurge ?? null,
    change1d: prev ? ((latest.close - prev.close) / prev.close) * 100 : null
  };
}

function scoreCandidate(item) {
  const s = item.summary;
  let score = 0;
  const reasons = [];
  if (s.streak >= 2) {
    score += 32;
    reasons.push(`5日均量連續 ${s.streak} 日大於20日均量`);
  }
  if (s.macdBull) {
    score += 18;
    reasons.push("MACD維持多方排列");
  }
  if (s.kdBull && s.latest.k < 85) {
    score += 14;
    reasons.push("KD向上且尚未極端過熱");
  }
  if (s.priceAboveMa20) {
    score += 12;
    reasons.push("收盤價站上20日均線");
  }
  if (s.bollingerPosition != null && s.bollingerPosition > 0.55 && s.bollingerPosition < 0.95) {
    score += 10;
    reasons.push("價格位於布林中上緣但未明顯貼頂");
  }
  if (s.bigMoneyTrend > 0) {
    score += 8;
    reasons.push("近5日量價推估偏向買盤主導");
  }
  if (item.volume > 1000) {
    score += 6;
    reasons.push("成交量具備基本流動性");
  }
  return { score: Math.round(score), reasons: reasons.slice(0, 5) };
}

async function mapLimit(items, limit, mapper) {
  const results = [];
  let index = 0;
  async function worker() {
    while (index < items.length) {
      const current = index;
      index += 1;
      try {
        results[current] = await mapper(items[current], current);
      } catch (error) {
        results[current] = { ...items[current], error: error.message };
      }
    }
  }
  await Promise.all(Array.from({ length: limit }, worker));
  return results;
}

export async function scan(market = "listed", force = false) {
  const key = `scan:${market}`;
  if (force) {
    clearCache("rank:");
    cache.delete(key);
  }
  return cached(key, CACHE_MS.scan, async () => {
    const markets = market === "allMarkets" ? ["listed", "otc"] : [market];
    const ranks = (await Promise.all(markets.map(getRank))).flat();
    const scanned = await mapLimit(ranks.slice(0, 100 * markets.length), 8, async (row) => {
      const chart = await getChart(row.symbol);
      const summary = summarizeChart(chart);
      const ai = scoreCandidate({ ...row, summary });
      return { ...row, summary, ai };
    });
    const candidates = scanned
      .filter((row) => row.summary?.pass)
      .sort((a, b) => b.ai.score - a.ai.score || b.changePercent - a.changePercent);
    return {
      market,
      scannedAt: new Date().toISOString(),
      source: markets,
      total: scanned.length,
      candidates,
      recommendations: candidates.slice(0, 5)
    };
  });
}

export async function getBrokerBranches(symbol, days = 5) {
  if (!/^\d{4,6}\.(TW|TWO)$/.test(symbol)) throw new Error("Invalid Taiwan stock symbol");
  const stockNo = symbol.split(".")[0];
  const normalizedDays = Math.max(1, Math.min(30, Number(days) || 5));
  const cmoneyUrl = `https://www.cmoney.tw/forum/stock/${stockNo}?s=broker`;
  const officialUrl = symbol.endsWith(".TWO")
    ? "https://www.tpex.org.tw/zh-tw/mainboard/trading/info/brokerBS.html"
    : "https://bsr.twse.com.tw/bshtm/bsWelcome.aspx";

  try {
    const html = await fetchText(cmoneyUrl);
    const available = html.includes("券商分點") || html.includes("買賣超");
    return {
      symbol,
      stockNo,
      days: normalizedDays,
      source: "CMoney / 官方分點資料",
      sourceUrl: cmoneyUrl,
      officialUrl,
      buyTop: [],
      sellTop: [],
      available,
      message: available
        ? "公開頁面可開啟，但未提供穩定的結構化分點 API；請使用來源連結查看真實券商分點，或接入授權 API 後可直接顯示前15大。"
        : "目前無法取得分點公開頁面。"
    };
  } catch (error) {
    return {
      symbol,
      stockNo,
      days: normalizedDays,
      source: "官方分點資料",
      sourceUrl: cmoneyUrl,
      officialUrl,
      buyTop: [],
      sellTop: [],
      available: false,
      message: `目前無法取得分點資料：${error.message}`
    };
  }
}

async function fetchInstitutionDay(symbol, date) {
  const stockNo = symbol.split(".")[0];
  const isOtc = symbol.endsWith(".TWO");
  const ymd = date.replaceAll("-", "");
  const key = `institution:${symbol}:${date}`;
  return cached(key, CACHE_MS.institution, async () => {
    if (isOtc) {
      const slashDate = date.replaceAll("-", "/");
      const url = `https://www.tpex.org.tw/www/zh-tw/insti/dailyTrade?date=${slashDate}&type=Daily&response=json`;
      const res = await fetch(url, { signal: AbortSignal.timeout(15000), headers: { "user-agent": "Mozilla/5.0" } });
      if (!res.ok) throw new Error(`TPEX institution fetch failed ${res.status}`);
      const json = await res.json();
      const row = json.tables?.[0]?.data?.find((item) => String(item[0]).trim() === stockNo);
      if (!row) return null;
      return {
        date,
        foreignLots: toInt(row[4]) / 1000,
        investmentTrustLots: toInt(row[13]) / 1000,
        dealerLots: toInt(row[22]) / 1000,
        totalLots: toInt(row[23]) / 1000
      };
    }

    const url = `https://www.twse.com.tw/rwd/zh/fund/T86?date=${ymd}&selectType=ALLBUT0999&response=json`;
    const res = await fetch(url, { signal: AbortSignal.timeout(15000), headers: { "user-agent": "Mozilla/5.0" } });
    if (!res.ok) throw new Error(`TWSE institution fetch failed ${res.status}`);
    const json = await res.json();
    const row = json.data?.find((item) => String(item[0]).trim() === stockNo);
    if (!row) return null;
    return {
      date,
      foreignLots: (toInt(row[4]) + toInt(row[7])) / 1000,
      investmentTrustLots: toInt(row[10]) / 1000,
      dealerLots: (toInt(row[11]) + toInt(row[14]) + toInt(row[17])) / 1000,
      totalLots: toInt(row[18]) / 1000
    };
  });
}

export async function getInstitutional(symbol, days = 5) {
  if (!/^\d{4,6}\.(TW|TWO)$/.test(symbol)) throw new Error("Invalid Taiwan stock symbol");
  const normalizedDays = Math.max(1, Math.min(20, Number(days) || 5));
  const chart = await getChart(symbol);
  const recent = chart.slice(-Math.max(normalizedDays * 3, 15)).reverse();
  const rows = [];
  for (const item of recent) {
    if (rows.length >= normalizedDays) break;
    const row = await fetchInstitutionDay(symbol, item.date);
    if (row) {
      rows.push({
        ...row,
        volumeLots: item.volumeLots,
        force: item.volumeLots ? row.totalLots / item.volumeLots : 0
      });
    }
  }

  const totalLots = rows.reduce((sum, row) => sum + row.totalLots, 0);
  const avgVolumeLots = average(rows.map((row) => row.volumeLots)) || 0;
  const strength = avgVolumeLots ? (totalLots / avgVolumeLots) * 100 : 0;
  let buyStreak = 0;
  let sellStreak = 0;
  for (const row of rows) {
    if (row.totalLots > 0 && sellStreak === 0) buyStreak += 1;
    else if (row.totalLots < 0 && buyStreak === 0) sellStreak += 1;
    else break;
  }
  const latest = chart.at(-1);
  const concentrationScore = Math.max(0, Math.min(100,
    45
    + Math.min(25, Math.max(-25, strength / 4))
    + Math.min(15, Math.max(-15, (latest?.volSurge || 1) * 8 - 8))
    + Math.min(15, Math.max(-15, (latest?.large400Change || 0) / 500))
  ));

  return {
    symbol,
    days: normalizedDays,
    rows,
    totalLots,
    avgVolumeLots,
    strength,
    buyStreak,
    sellStreak,
    concentrationScore: Math.round(concentrationScore),
    source: symbol.endsWith(".TWO") ? "TPEx 三大法人買賣明細資訊" : "TWSE 三大法人買賣超日報"
  };
}

function json(res, code, data) {
  const body = JSON.stringify(data);
  res.writeHead(code, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store"
  });
  res.end(body);
}

async function serveStatic(res, pathname) {
  const safePath = pathname === "/" ? "/index.html" : pathname;
  const filePath = path.normalize(path.join(publicDir, safePath));
  if (!filePath.startsWith(publicDir)) {
    res.writeHead(403);
    res.end("Forbidden");
    return;
  }
  const ext = path.extname(filePath);
  const type = {
    ".html": "text/html; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".js": "application/javascript; charset=utf-8"
  }[ext] || "application/octet-stream";
  try {
    const file = await readFile(filePath);
    res.writeHead(200, { "content-type": type });
    res.end(file);
  } catch {
    res.writeHead(404);
    res.end("Not found");
  }
}

export const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://${req.headers.host}`);
    if (url.pathname === "/api/rank") {
      json(res, 200, { rows: await getRank(url.searchParams.get("market") || "all") });
      return;
    }
    if (url.pathname === "/api/chart") {
      json(res, 200, { rows: await getChart(url.searchParams.get("symbol") || "") });
      return;
    }
    if (url.pathname === "/api/scan") {
      json(res, 200, await scan(url.searchParams.get("market") || "listed", url.searchParams.get("refresh") === "1"));
      return;
    }
    if (url.pathname === "/api/brokers") {
      json(res, 200, await getBrokerBranches(url.searchParams.get("symbol") || "", url.searchParams.get("days") || "5"));
      return;
    }
    if (url.pathname === "/api/institution") {
      json(res, 200, await getInstitutional(url.searchParams.get("symbol") || "", url.searchParams.get("days") || "5"));
      return;
    }
    await serveStatic(res, url.pathname);
  } catch (error) {
    json(res, 500, { error: error.message });
  }
});

if (nodeProcess?.argv?.[1] && path.resolve(nodeProcess.argv[1]) === fileURLToPath(import.meta.url)) {
  server.listen(port, () => {
    console.log(`Yahoo Taiwan stock screener running at http://localhost:${port}`);
  });
}
