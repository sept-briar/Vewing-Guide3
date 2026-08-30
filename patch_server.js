const fs = require('fs');
let code = fs.readFileSync('server.ts', 'utf-8');

const newEndpoint = `
// Live GAS Announcements Endpoint
app.get("/api/announcements-live", async (req, res) => {
  try {
    const targetUrl = (req.query.url as string) || "";
    if (!targetUrl) {
      return res.json({ success: false, data: [] });
    }

    let fetchUrl = targetUrl;
    if (fetchUrl.includes("docs.google.com/spreadsheets") && !fetchUrl.includes("export?format=csv")) {
      const match = fetchUrl.match(/\\/d\\/([a-zA-Z0-9-_]+)/);
      if (match) {
        const gidMatch = fetchUrl.match(/[#&]gid=([0-9]+)/);
        const gid = gidMatch ? gidMatch[1] : "0";
        fetchUrl = \`https://docs.google.com/spreadsheets/d/\${match[1]}/export?format=csv&gid=\${gid}\`;
      }
    }

    const response = await fetch(fetchUrl, {
      redirect: "follow",
      headers: { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64)" }
    });

    if (!response.ok) {
      throw new Error(\`Data request failed with status: \${response.status}\`);
    }

    const raw = await response.text();
    const lines = raw.split("\\n");

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
        } else if (char === ',' && !inQuotes) {
          result.push(current);
          current = "";
        } else {
          current += char;
        }
      }
      result.push(current);
      return result;
    }

    const announcements = [];
    for (let i = 1; i < lines.length; i++) {
      const line = lines[i].trim();
      if (!line) continue;
      
      const parts = parseCSVLine(line);
      const dateRaw = parts[0]?.trim();
      const categoryRaw = parts[1]?.trim();
      const titleRaw = parts[2]?.trim();
      const contentRaw = parts[3]?.trim();
      const isPinnedRaw = parts[4]?.trim().toLowerCase();
      
      if (!titleRaw) continue; // Skip if no title

      let category = "一般案内";
      if (categoryRaw && categoryRaw.includes("重要")) category = "重要";
      else if (categoryRaw && categoryRaw.includes("混雑")) category = "混雑情報";
      else if (categoryRaw && categoryRaw.includes("プログラム")) category = "プログラム変更";
      
      const isPinned = isPinnedRaw === 'true' || isPinnedRaw === '1' || isPinnedRaw === 'yes' || isPinnedRaw.includes('ピン');

      announcements.push({
        id: \`ann-\${i}-\${Date.now()}\`,
        timestamp: dateRaw || new Date().toLocaleString("ja-JP"),
        category,
        title: titleRaw,
        content: contentRaw || "",
        isPinned
      });
    }

    res.json({ success: true, data: announcements });
  } catch (error: any) {
    console.error("Announcements fetch error:", error);
    res.json({ success: false, error: error.message, data: [] });
  }
});
`;

code = code.replace('// Vite middleware for development', newEndpoint + '\n  // Vite middleware for development');
fs.writeFileSync('server.ts', code);
