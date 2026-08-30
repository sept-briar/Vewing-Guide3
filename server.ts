import express from "express";
import path from "path";
import { createServer as createViteServer } from "vite";

const app = express();
const PORT = 3000;

app.use(express.json());

const DEFAULT_CONGESTION_URL =
  "https://docs.google.com/spreadsheets/d/154F3vcdcOSyMc55VbY9qPCey4JtL7mW1pCOWBrDVuZc/edit?gid=0#gid=0";
const DEFAULT_ANNOUNCEMENT_URL =
  "https://docs.google.com/spreadsheets/d/1Ajv5ErGHjhIz740IaB-IqhywYkV66dREwOdk7G3EiEg/edit?gid=0#gid=0";

// In-memory caches to guarantee fast response & protect against Google rate limits/slow responses
let congestionCache: {
  timestamp: number;
  url: string;
  data: Record<string, any>;
} | null = null;

let announcementCache: {
  timestamp: number;
  url: string;
  data: any[];
} | null = null;

// Convert Google Sheet edit/pub URLs to CSV export URLs
function getGoogleSpreadsheetCsvUrl(targetUrl: string): string {
  let fetchUrl = targetUrl.trim();
  if (!fetchUrl.includes("docs.google.com/spreadsheets")) {
    return fetchUrl;
  }
  if (fetchUrl.includes("/pub") && !fetchUrl.includes("output=csv")) {
    return fetchUrl + (fetchUrl.includes("?") ? "&" : "?") + "output=csv";
  }
  const match = fetchUrl.match(/\/d\/([a-zA-Z0-9-_]+)/);
  if (match && match[1] !== "e") {
    const gidMatch = fetchUrl.match(/[#&?]gid=([0-9]+)/);
    const gid = gidMatch ? gidMatch[1] : "0";
    return `https://docs.google.com/spreadsheets/d/${match[1]}/export?format=csv&gid=${gid}`;
  }
  return fetchUrl;
}

// Robust RFC-4180 compliant CSV parser to handle quotes, commas, and MULTILINE cells
function parseFullCSV(text: string): string[][] {
  if (!text || typeof text !== 'string') return [];
  const rows: string[][] = [];
  let currentRow: string[] = [];
  let currentField = '';
  let inQuotes = false;

  for (let i = 0; i < text.length; i++) {
    const char = text[i];
    const nextChar = text[i + 1];

    if (inQuotes) {
      if (char === '"' && nextChar === '"') {
        currentField += '"';
        i++; // Skip the second quote
      } else if (char === '"') {
        inQuotes = false;
      } else {
        currentField += char;
      }
    } else {
      if (char === '"') {
        inQuotes = true;
      } else if (char === ',') {
        currentRow.push(currentField.trim());
        currentField = '';
      } else if (char === '\r') {
        if (nextChar === '\n') {
          i++; // Skip \n
        }
        currentRow.push(currentField.trim());
        rows.push(currentRow);
        currentRow = [];
        currentField = '';
      } else if (char === '\n') {
        currentRow.push(currentField.trim());
        rows.push(currentRow);
        currentRow = [];
        currentField = '';
      } else {
        currentField += char;
      }
    }
  }

  // Push last field and row if any remaining
  if (currentField.length > 0 || currentRow.length > 0) {
    currentRow.push(currentField.trim());
    rows.push(currentRow);
  }

  return rows;
}

// Simple CSV line parser to handle quotes and commas inside cells
function parseCSVLine(text: string): string[] {
  const result: string[] = [];
  let current = "";
  let inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const char = text[i];
    if (char === '"' && text[i + 1] === '"') {
      current += '"';
      i++;
    } else if (char === '"') {
      inQuotes = !inQuotes;
    } else if (char === "," && !inQuotes) {
      result.push(current.trim());
      current = "";
    } else {
      current += char;
    }
  }
  result.push(current.trim());
  return result;
}

function checkIsPinned(val: any): boolean {
  if (val === true || val === 1) return true;
  if (!val) return false;
  const str = String(val).trim().toLowerCase();
  return (
    str === 'true' ||
    str === '1' ||
    str === 'yes' ||
    str === 'y' ||
    str === 'on' ||
    str === 't' ||
    str.includes('ピン') ||
    str.includes('固定') ||
    str.includes('重要') ||
    str.includes('○') ||
    str.includes('〇') ||
    str.includes('●') ||
    str.includes('✓') ||
    str.includes('✔') ||
    str.includes('有') ||
    str.includes('はい')
  );
}

// Fetch with retry and timeout (12s per try, max 2 tries)
async function fetchWithRetry(url: string, options: RequestInit, retries = 2, backoff = 800, timeout = 12000): Promise<Response> {
  for (let i = 0; i < retries; i++) {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), timeout);
    try {
      const response = await fetch(url, { ...options, signal: controller.signal });
      clearTimeout(timeoutId);
      if (response.ok) return response;
      if (response.status >= 500 && i < retries - 1) {
        throw new Error(`Status ${response.status}`);
      }
      return response;
    } catch (e) {
      clearTimeout(timeoutId);
      if (i === retries - 1) throw e;
      await new Promise(resolve => setTimeout(resolve, backoff * (i + 1)));
    }
  }
  throw new Error("Max retries reached");
}

// Parse Spreadsheet CSV to extract class congestion data
async function fetchAndParseGas(targetUrl: string) {
  const fetchUrl = getGoogleSpreadsheetCsvUrl(targetUrl);

  const res = await fetchWithRetry(fetchUrl, {
    redirect: "follow",
    headers: {
      "User-Agent":
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
    },
  });

  if (!res.ok) {
    throw new Error(`Data request failed with status: ${res.status}`);
  }

  const raw = await res.text();
  const rows = parseFullCSV(raw);

  const results: Record<
    string,
    {
      classCode: string;
      statusText: string;
      waitTimeMinutes: number;
      detailText: string;
      level: "smooth" | "moderate" | "crowded" | "ticket" | "closed";
      rawWait: string;
    }
  > = {};

  for (let i = 1; i < rows.length; i++) {
    const parts = rows[i];
    if (!parts || parts.length === 0) continue;

    const rawClassCode = parts[0]?.trim() || "";

    // Normalize class code: e.g. "1A", "1-A", "1年A組", "1a" -> "1A"
    const cleaned = rawClassCode.replace(/[\s\-_]/g, "").toUpperCase();
    const classMatch = cleaned.match(/^([0-9])(?:年)?([A-Z])(?:組)?$/);
    if (!classMatch) continue;
    const classCode = `${classMatch[1]}${classMatch[2]}`;

    const statusText = parts[1]?.trim() || "";
    const waitRaw = parts[2]?.trim() || "0";
    const detailText = parts[3]?.trim() || "";

    const waitNumMatch = waitRaw.match(/(\d+)/);
    const waitMinutes = waitNumMatch ? parseInt(waitNumMatch[1], 10) : 0;

    let level: "smooth" | "moderate" | "crowded" | "ticket" | "closed" = "smooth";
    if (statusText.includes("大混") || statusText.includes("混んでいる") || statusText.includes("混雑") || waitMinutes >= 35) {
      level = "crowded";
    } else if (statusText.includes("普通") || statusText.includes("やや") || waitMinutes >= 15) {
      level = "moderate";
    } else if (statusText.includes("券") || statusText.includes("整理券")) {
      level = "ticket";
    } else if (
      statusText.includes("休") ||
      statusText.includes("終了") ||
      statusText.includes("閉") ||
      statusText.includes("準備")
    ) {
      level = "closed";
    } else if (statusText.includes("空") || statusText.includes("スムーズ") || statusText.includes("なし") || waitMinutes <= 5) {
      level = "smooth";
    }

    results[classCode] = {
      classCode,
      statusText,
      waitTimeMinutes: waitMinutes,
      detailText,
      level,
      rawWait: waitRaw,
    };
  }

  return results;
}

// Parse Spreadsheet CSV or GAS Web App JSON to extract announcement data
async function fetchAndParseAnnouncements(targetUrl: string) {
  const fetchUrl = getGoogleSpreadsheetCsvUrl(targetUrl);

  const res = await fetchWithRetry(fetchUrl, {
    redirect: "follow",
    headers: {
      "User-Agent":
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
    },
  });

  if (!res.ok) {
    throw new Error(`Data request failed with status: ${res.status}`);
  }

  const raw = await res.text();
  const trimmed = raw.trim();

  // Try parsing JSON if GAS Web App returns JSON
  if (trimmed.startsWith("[") || (trimmed.startsWith("{") && !trimmed.startsWith("<!DOCTYPE"))) {
    try {
      const parsed = JSON.parse(trimmed);
      const items = Array.isArray(parsed) ? parsed : (parsed.announcements || parsed.data || []);
      if (Array.isArray(items)) {
        const list = items.map((item: any, i: number) => {
          let cat: "重要" | "混雑情報" | "プログラム変更" | "一般案内" = "一般案内";
          const catStr = (item.category || item.type || "").toString();
          if (catStr.includes("重要")) cat = "重要";
          else if (catStr.includes("混雑")) cat = "混雑情報";
          else if (catStr.includes("プログラム")) cat = "プログラム変更";

          return {
            id: item.id || `ann-${i + 1}`,
            timestamp: item.timestamp || item.date || item.time || new Date().toLocaleString("ja-JP"),
            category: cat,
            title: (item.title || item.name || "").trim(),
            content: (item.content || item.detail || item.body || "").trim(),
            isPinned: checkIsPinned(item.isPinned ?? item.pinned ?? item.pin ?? item.fixed),
          };
        }).filter((a: any) => a.title);

        return list.sort((a: any, b: any) => {
          if (a.isPinned && !b.isPinned) return -1;
          if (!a.isPinned && b.isPinned) return 1;
          return 0;
        });
      }
    } catch {
      // Not JSON, continue to CSV parsing
    }
  }

  const rows = parseFullCSV(raw);
  if (rows.length === 0) return [];

  // Inspect Header Row (Row 0) to detect column indices if available
  let dateCol = 0;
  let categoryCol = 1;
  let titleCol = 2;
  let contentCol = 3;
  let pinCol = 4;
  let startRow = 1;

  if (rows.length > 0) {
    const headerRow = rows[0].map(h => (h || "").toLowerCase().replace(/\s+/g, ""));
    let foundHeaders = false;

    headerRow.forEach((h, idx) => {
      if (h.includes("日時") || h.includes("日付") || h.includes("時間") || h.includes("date") || h.includes("time") || h.includes("timestamp")) {
        dateCol = idx;
        foundHeaders = true;
      } else if (h.includes("カテゴリ") || h.includes("種別") || h.includes("区分") || h.includes("category") || h.includes("type")) {
        categoryCol = idx;
        foundHeaders = true;
      } else if (h.includes("タイトル") || h.includes("件名") || h.includes("題名") || h.includes("title")) {
        titleCol = idx;
        foundHeaders = true;
      } else if (h.includes("本文") || h.includes("内容") || h.includes("詳細") || h.includes("content") || h.includes("body") || h.includes("detail")) {
        contentCol = idx;
        foundHeaders = true;
      } else if (h.includes("ピン") || h.includes("固定") || h.includes("重要") || h.includes("pin") || h.includes("pinned") || h.includes("top")) {
        pinCol = idx;
        foundHeaders = true;
      }
    });

    if (!foundHeaders && rows[0].length >= 3 && !rows[0][0].includes("日時") && !rows[0][2].includes("タイトル")) {
      startRow = 0;
    }
  }

  const announcements = [];
  for (let i = startRow; i < rows.length; i++) {
    const row = rows[i];
    if (!row || row.length === 0) continue;

    const dateRaw = row[dateCol]?.trim();
    const categoryRaw = row[categoryCol]?.trim();
    const titleRaw = row[titleCol]?.trim();
    const contentRaw = row[contentCol]?.trim();
    const isPinnedRaw = row[pinCol];

    if (!titleRaw) continue;

    let category: "重要" | "混雑情報" | "プログラム変更" | "一般案内" = "一般案内";
    if (categoryRaw && categoryRaw.includes("重要")) category = "重要";
    else if (categoryRaw && categoryRaw.includes("混雑")) category = "混雑情報";
    else if (categoryRaw && categoryRaw.includes("プログラム")) category = "プログラム変更";

    const isPinned = checkIsPinned(isPinnedRaw);

    announcements.push({
      id: `ann-${i}`,
      timestamp: dateRaw || new Date().toLocaleString("ja-JP"),
      category,
      title: titleRaw,
      content: contentRaw || "",
      isPinned,
    });
  }

  // Sort pinned announcements to top
  announcements.sort((a, b) => {
    if (a.isPinned && !b.isPinned) return -1;
    if (!a.isPinned && b.isPinned) return 1;
    return 0;
  });

  return announcements;
}

// API Routes
app.get("/api/health", (req, res) => {
  res.json({ status: "ok", timestamp: new Date().toISOString() });
});

// Live Congestion Endpoint with 5s cache
app.get("/api/congestion-live", async (req, res) => {
  const targetUrl =
    typeof req.query.url === "string" && req.query.url.startsWith("http")
      ? req.query.url
      : DEFAULT_CONGESTION_URL;

  const now = Date.now();
  if (congestionCache && congestionCache.url === targetUrl && now - congestionCache.timestamp < 5000) {
    return res.json({
      success: true,
      timestamp: new Date(congestionCache.timestamp).toISOString(),
      count: Object.keys(congestionCache.data).length,
      data: congestionCache.data,
      cached: true,
    });
  }

  try {
    const data = await fetchAndParseGas(targetUrl);
    const count = Object.keys(data).length;

    congestionCache = {
      timestamp: now,
      url: targetUrl,
      data,
    };

    res.json({
      success: true,
      timestamp: new Date().toISOString(),
      count,
      data,
    });
  } catch (error: any) {
    console.error("Error fetching GAS congestion data:", error);
    if (congestionCache && congestionCache.url === targetUrl) {
      return res.json({
        success: true,
        timestamp: new Date(congestionCache.timestamp).toISOString(),
        count: Object.keys(congestionCache.data).length,
        data: congestionCache.data,
        cachedFallback: true,
      });
    }
    res.status(500).json({
      success: false,
      error: error.message || "Failed to fetch and parse GAS live data",
    });
  }
});

// Live Announcements Endpoint with 5s cache
app.get("/api/announcements-live", async (req, res) => {
  const targetUrl =
    typeof req.query.url === "string" && req.query.url.startsWith("http")
      ? req.query.url
      : DEFAULT_ANNOUNCEMENT_URL;

  const now = Date.now();
  if (announcementCache && announcementCache.url === targetUrl && now - announcementCache.timestamp < 5000) {
    return res.json({
      success: true,
      timestamp: new Date(announcementCache.timestamp).toISOString(),
      data: announcementCache.data,
      cached: true,
    });
  }

  try {
    const data = await fetchAndParseAnnouncements(targetUrl);
    announcementCache = {
      timestamp: now,
      url: targetUrl,
      data,
    };

    res.json({
      success: true,
      timestamp: new Date().toISOString(),
      data,
    });
  } catch (error: any) {
    console.error("Error fetching announcements data:", error);
    res.status(500).json({
      success: false,
      error: error.message || "Failed to fetch announcements live data",
      data: [],
    });
  }
});

// Server-side App Data Store for online synchronization across users
let serverAppDataStore: any = null;

app.get("/api/app-data", (req, res) => {
  res.json({
    success: true,
    data: serverAppDataStore,
  });
});

app.post("/api/app-data", (req, res) => {
  try {
    const newData = req.body;
    if (newData && typeof newData === 'object') {
      serverAppDataStore = newData;
      res.json({ success: true, message: "App data updated successfully on server" });
    } else {
      res.status(400).json({ success: false, error: "Invalid data format" });
    }
  } catch (err: any) {
    res.status(500).json({ success: false, error: err.message || "Failed to save app data" });
  }
});

async function startServer() {
  // Vite middleware for development
  if (process.env.NODE_ENV !== "production") {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: "spa",
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.join(process.cwd(), "dist");
    app.use(express.static(distPath));
    app.get("*", (req, res) => {
      res.sendFile(path.join(distPath, "index.html"));
    });
  }

  app.listen(PORT, "0.0.0.0", () => {
    console.log(`Server running on http://localhost:${PORT}`);
  });
}

startServer();
