const express = require("express");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const app = express();

// ========== MIDDLEWARE ==========
app.use(express.json({ limit: "5mb" })); // Support larger pastes
app.use(express.static(path.join(__dirname, "public")));

// Simple rate limiting (prevent spam)
const rateLimits = new Map();
const RATE_LIMIT_WINDOW = 60 * 1000; // 1 minute
const RATE_LIMIT_MAX = 30; // 30 requests per minute

function rateLimit(req, res, next) {
  const ip = req.ip || req.connection.remoteAddress;
  const now = Date.now();
  const record = rateLimits.get(ip) || { count: 0, resetTime: now + RATE_LIMIT_WINDOW };
  
  if (now > record.resetTime) {
    record.count = 0;
    record.resetTime = now + RATE_LIMIT_WINDOW;
  }
  
  record.count++;
  rateLimits.set(ip, record);
  
  if (record.count > RATE_LIMIT_MAX) {
    return res.status(429).json({ error: "Too many requests. Please slow down." });
  }
  next();
}

// Apply rate limiting to write operations
app.use("/paste", rateLimit);
app.use("/paste/*", rateLimit);

// ========== FILE PATHS ==========
const DATA_DIR = process.env.DATA_DIR || "/tmp";
const FILE = path.join(DATA_DIR, "pastes.json");
const BACKUP_DIR = path.join(DATA_DIR, "backups");

// Ensure backup directory exists
if (!fs.existsSync(BACKUP_DIR)) {
  try {
    fs.mkdirSync(BACKUP_DIR, { recursive: true });
  } catch (e) { /* ignore */ }
}

// ========== DATA HELPERS ==========
function readData() {
  try {
    if (!fs.existsSync(FILE)) return [];
    const data = fs.readFileSync(FILE, "utf8");
    return JSON.parse(data);
  } catch (error) {
    console.error("Error reading data:", error.message);
    return [];
  }
}

function writeData(data) {
  try {
    // Create backup before overwriting (every 10 writes)
    if (fs.existsSync(FILE)) {
      const stats = fs.statSync(FILE);
      const now = Date.now();
      if (!global._lastBackup || (now - global._lastBackup) > 60000) { // Max 1 backup per minute
        const backupName = `pastes_backup_${new Date().toISOString().replace(/[:.]/g, "-")}.json`;
        fs.copyFileSync(FILE, path.join(BACKUP_DIR, backupName));
        global._lastBackup = now;
        
        // Clean old backups (keep last 20)
        const backups = fs.readdirSync(BACKUP_DIR).filter(f => f.startsWith("pastes_backup_"));
        backups.sort().reverse();
        backups.slice(20).forEach(f => {
          fs.unlinkSync(path.join(BACKUP_DIR, f));
        });
      }
    }
    fs.writeFileSync(FILE, JSON.stringify(data, null, 2));
    return true;
  } catch (error) {
    console.error("Error writing data:", error.message);
    return false;
  }
}

function generateId() {
  return crypto.randomBytes(8).toString("hex") + "_" + Date.now().toString(36);
}

// ========== API ROUTES ==========

// Get all pastes (with optional filtering)
app.get("/mypastes", (req, res) => {
  const pastes = readData();
  const { folder, search, limit, offset } = req.query;
  
  let result = [...pastes];
  
  // Filter by folder
  if (folder) {
    result = result.filter(p => p.folder === folder);
  }
  
  // Search in title and content
  if (search) {
    const term = search.toLowerCase();
    result = result.filter(p => 
      p.title.toLowerCase().includes(term) || 
      p.content.toLowerCase().includes(term)
    );
  }
  
  // Sort by newest first (by createdAt or fallback to id)
  result.sort((a, b) => {
    const aTime = a.createdAt || 0;
    const bTime = b.createdAt || 0;
    return bTime - aTime;
  });
  
  // Pagination
  const lim = parseInt(limit) || 100;
  const off = parseInt(offset) || 0;
  const paginated = result.slice(off, off + lim);
  
  res.json({
    total: result.length,
    limit: lim,
    offset: off,
    pastes: paginated
  });
});

// Get single paste with optional raw format
app.get("/paste/:id", (req, res) => {
  const pastes = readData();
  const paste = pastes.find(p => p.id === req.params.id);
  
  if (!paste) {
    return res.status(404).send(`
      <!DOCTYPE html>
      <html>
      <head><title>Not Found</title><meta charset="UTF-8"></head>
      <body style="font-family: sans-serif; text-align: center; padding: 50px;">
        <h1>🔍 Paste Not Found</h1>
        <p>The paste you're looking for doesn't exist or has been deleted.</p>
        <a href="/">← Back to Home</a>
      </body>
      </html>
    `);
  }
  
  // Raw content mode
  if (req.query.raw === "1" || req.query.raw === "true") {
    res.setHeader("Content-Type", "text/plain; charset=utf-8");
    return res.send(paste.content);
  }
  
  // HTML view
  const html = `<!DOCTYPE html>
  <html>
  <head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>${escapeHtml(paste.title)} - Pastebin Pro</title>
    <style>
      * { margin: 0; padding: 0; box-sizing: border-box; }
      body {
        background: #0f172a;
        color: #f1f5f9;
        font-family: system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif;
        padding: 2rem 1rem;
      }
      .container { max-width: 1000px; margin: 0 auto; }
      .header {
        display: flex;
        justify-content: space-between;
        align-items: center;
        flex-wrap: wrap;
        gap: 1rem;
        margin-bottom: 2rem;
        padding-bottom: 1rem;
        border-bottom: 1px solid #334155;
      }
      h1 { font-size: 1.8rem; color: #38bdf8; }
      .meta {
        color: #94a3b8;
        font-size: 0.85rem;
        margin-bottom: 1rem;
        display: flex;
        gap: 1rem;
        flex-wrap: wrap;
      }
      .folder-badge {
        background: #1e293b;
        padding: 4px 12px;
        border-radius: 20px;
        font-size: 0.8rem;
      }
      .content {
        background: #1e293b;
        padding: 1.5rem;
        border-radius: 16px;
        overflow-x: auto;
        margin: 1rem 0;
      }
      pre {
        font-family: 'Fira Code', 'JetBrains Mono', monospace;
        font-size: 0.85rem;
        white-space: pre-wrap;
        word-wrap: break-word;
        line-height: 1.5;
      }
      .actions {
        display: flex;
        gap: 0.8rem;
        flex-wrap: wrap;
        margin-top: 1.5rem;
      }
      button, .btn {
        background: #334155;
        color: white;
        border: none;
        padding: 8px 16px;
        border-radius: 40px;
        cursor: pointer;
        font-size: 0.85rem;
        text-decoration: none;
        display: inline-block;
      }
      button:hover, .btn:hover {
        background: #38bdf8;
      }
      a { color: #38bdf8; text-decoration: none; }
      .raw-link { background: #1e293b; border: 1px solid #334155; }
    </style>
  </head>
  <body>
    <div class="container">
      <div class="header">
        <h1>📄 ${escapeHtml(paste.title)}</h1>
        <a href="/" class="btn">← Back</a>
      </div>
      <div class="meta">
        <span>📁 <span class="folder-badge">${escapeHtml(paste.folder || "General")}</span></span>
        <span>🕒 ${new Date(paste.createdAt || Date.now()).toLocaleString()}</span>
        <span>📏 ${paste.content.length} characters</span>
        ${paste.updatedAt && paste.updatedAt !== paste.createdAt ? `<span>✏️ Updated: ${new Date(paste.updatedAt).toLocaleString()}</span>` : ""}
      </div>
      <div class="content">
        <pre>${escapeHtml(paste.content)}</pre>
      </div>
      <div class="actions">
        <button onclick="copyContent()">📋 Copy Content</button>
        <button onclick="copyLink()">🔗 Copy Link</button>
        <a href="?raw=1" class="btn raw-link" download="${escapeHtml(paste.title)}.txt">⬇️ Download Raw</a>
      </div>
    </div>
    <script>
      function copyContent() {
        navigator.clipboard.writeText(${JSON.stringify(paste.content)});
        alert("Content copied!");
      }
      function copyLink() {
        navigator.clipboard.writeText(window.location.href);
        alert("Link copied!");
      }
    </script>
  </body>
  </html>`;
  
  res.send(html);
});

// Create new paste
app.post("/paste", (req, res) => {
  const pastes = readData();
  const { title, content, folder } = req.body;
  
  if (!content || typeof content !== "string" || content.trim().length === 0) {
    return res.status(400).json({ error: "Content is required" });
  }
  
  if (content.length > 500000) { // 500KB limit
    return res.status(413).json({ error: "Content too large (max 500KB)" });
  }
  
  // Optional: prevent exact duplicate content within last 24 hours (anti-spam)
  const now = Date.now();
  const recentDuplicate = pastes.find(p => 
    p.content === content && 
    p.createdAt && (now - p.createdAt) < 24 * 60 * 60 * 1000
  );
  
  if (recentDuplicate) {
    return res.json({ 
      id: recentDuplicate.id, 
      existing: true,
      message: "Duplicate paste detected, returning existing one"
    });
  }
  
  const id = generateId();
  const nowTime = Date.now();
  
  const newPaste = {
    id,
    title: (title && title.trim()) ? title.trim().substring(0, 200) : "Untitled",
    content: content,
    folder: (folder && folder.trim()) ? folder.trim().substring(0, 50) : "General",
    createdAt: nowTime,
    updatedAt: nowTime,
    viewCount: 0
  };
  
  pastes.push(newPaste);
  writeData(pastes);
  
  res.json({ 
    id, 
    existing: false,
    url: `/paste/${id}`
  });
});

// Update existing paste (PUT)
app.put("/paste/:id", (req, res) => {
  const pastes = readData();
  const index = pastes.findIndex(p => p.id === req.params.id);
  
  if (index === -1) {
    return res.status(404).json({ error: "Paste not found" });
  }
  
  const { title, content, folder } = req.body;
  const paste = pastes[index];
  
  if (content && typeof content === "string" && content.trim().length > 0) {
    paste.content = content;
  }
  if (title && title.trim()) {
    paste.title = title.trim().substring(0, 200);
  }
  if (folder !== undefined) {
    paste.folder = folder && folder.trim() ? folder.trim().substring(0, 50) : "General";
  }
  
  paste.updatedAt = Date.now();
  
  writeData(pastes);
  res.json({ 
    success: true, 
    id: paste.id,
    updated: true
  });
});

// Delete paste
app.delete("/paste/:id", (req, res) => {
  const pastes = readData();
  const index = pastes.findIndex(p => p.id === req.params.id);
  
  if (index === -1) {
    return res.status(404).json({ error: "Paste not found" });
  }
  
  const deleted = pastes.splice(index, 1)[0];
  writeData(pastes);
  
  res.json({ 
    success: true, 
    deleted: { id: deleted.id, title: deleted.title }
  });
});

// Get folder contents (enhanced HTML)
app.get("/folder/:name", (req, res) => {
  const pastes = readData();
  const folderName = decodeURIComponent(req.params.name);
  const folderPastes = pastes.filter(p => p.folder === folderName);
  
  const html = `<!DOCTYPE html>
  <html>
  <head>
    <meta charset="UTF-8">
    <title>${escapeHtml(folderName)} - Pastebin Pro</title>
    <style>
      body { background: #0f172a; color: #f1f5f9; font-family: system-ui; padding: 2rem; }
      .container { max-width: 900px; margin: 0 auto; }
      h1 { color: #38bdf8; }
      .paste-list { margin-top: 2rem; }
      .paste-item {
        background: #1e293b;
        padding: 1rem;
        margin-bottom: 0.8rem;
        border-radius: 12px;
        display: flex;
        justify-content: space-between;
        align-items: center;
        flex-wrap: wrap;
        gap: 0.5rem;
      }
      a { color: #38bdf8; text-decoration: none; }
      a:hover { text-decoration: underline; }
      .back { margin-bottom: 1rem; display: inline-block; }
      .count { color: #94a3b8; font-size: 0.9rem; }
    </style>
  </head>
  <body>
    <div class="container">
      <a href="/" class="back">← Back to Home</a>
      <h1>📁 ${escapeHtml(folderName)}</h1>
      <p class="count">📄 ${folderPastes.length} pastes in this folder</p>
      <div class="paste-list">
        ${folderPastes.map(p => `
          <div class="paste-item">
            <a href="/paste/${p.id}"><strong>${escapeHtml(p.title)}</strong></a>
            <span style="color:#94a3b8; font-size:0.75rem;">${new Date(p.createdAt || Date.now()).toLocaleDateString()}</span>
          </div>
        `).join("")}
        ${folderPastes.length === 0 ? "<p>✨ No pastes in this folder yet.</p>" : ""}
      </div>
    </div>
  </body>
  </html>`;
  
  res.send(html);
});

// Get all folders list
app.get("/folders", (req, res) => {
  const pastes = readData();
  const folders = {};
  
  pastes.forEach(p => {
    const folder = p.folder || "General";
    folders[folder] = (folders[folder] || 0) + 1;
  });
  
  res.json({ folders });
});

// Statistics endpoint
app.get("/stats", (req, res) => {
  const pastes = readData();
  const totalSize = pastes.reduce((sum, p) => sum + (p.content?.length || 0), 0);
  const foldersCount = new Set(pastes.map(p => p.folder || "General")).size;
  
  res.json({
    totalPastes: pastes.length,
    totalCharacters: totalSize,
    uniqueFolders: foldersCount,
    averageSize: pastes.length ? Math.round(totalSize / pastes.length) : 0,
    oldestPaste: pastes.length ? Math.min(...pastes.map(p => p.createdAt || Infinity)) : null,
    newestPaste: pastes.length ? Math.max(...pastes.map(p => p.createdAt || 0)) : null
  });
});

// Export all data for backup
app.get("/export", (req, res) => {
  const pastes = readData();
  const exportData = {
    exportedAt: new Date().toISOString(),
    version: "1.0",
    totalPastes: pastes.length,
    pastes: pastes
  };
  res.json(exportData);
});

// Import data (replace all)
app.post("/import", (req, res) => {
  const { pastes: importedPastes, replace } = req.body;
  
  if (!importedPastes || !Array.isArray(importedPastes)) {
    return res.status(400).json({ error: "Invalid import data. Expected { pastes: [] }" });
  }
  
  const currentPastes = readData();
  
  if (replace === true) {
    // Replace all
    const validPastes = importedPastes.filter(p => p.content).map(p => ({
      ...p,
      id: p.id || generateId(),
      updatedAt: Date.now()
    }));
    writeData(validPastes);
    res.json({ imported: validPastes.length, replaced: true });
  } else {
    // Merge (skip duplicates by content hash? just add new ones)
    const existingContents = new Set(currentPastes.map(p => p.content));
    const newPastes = importedPastes.filter(p => p.content && !existingContents.has(p.content));
    const merged = [...currentPastes, ...newPastes.map(p => ({
      ...p,
      id: generateId(),
      createdAt: Date.now(),
      updatedAt: Date.now()
    }))];
    writeData(merged);
    res.json({ imported: newPastes.length, merged: true, total: merged.length });
  }
});

// Health check
app.get("/health", (req, res) => {
  res.json({ 
    status: "ok", 
    timestamp: new Date().toISOString(),
    pasteCount: readData().length
  });
});

// ========== HELPER FUNCTIONS ==========
function escapeHtml(str) {
  if (!str) return "";
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

// ========== ERROR HANDLING ==========
app.use((err, req, res, next) => {
  console.error("Server error:", err);
  res.status(500).json({ error: "Internal server error" });
});

// ========== START SERVER ==========
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`
  🚀 Pastebin Pro Server Running
  📡 http://localhost:${PORT}
  📁 Data stored at: ${FILE}
  💾 Backups: ${BACKUP_DIR}
  `);
});

module.exports = app; // For testing
