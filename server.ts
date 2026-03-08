import express from "express";
import path from "path";
import { fileURLToPath } from 'url';
import dotenv from "dotenv";

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());

// ===== API ROUTES - MUST COME FIRST =====
app.get("/api/health", (req, res) => {
  console.log("✓ Health endpoint called");
  res.json({
    status: "ok",
    timestamp: new Date().toISOString(),
    keys: {
      debank: !!process.env.DEBANK_API_KEY,
      oneinch: !!process.env.ONE_INCH_API_KEY
    }
  });
});

app.get("/api/stats", (req, res) => {
  console.log("✓ Stats endpoint called");
  res.json({
    totalDustCleanedUsd: 1245.67,
    totalSwaps: 842,
    usersServed: 156
  });
});

// Test endpoint to verify API is working
app.get("/api/test", (req, res) => {
  res.json({ message: "API is working!" });
});

// ===== STATIC FILES =====
const distPath = path.join(process.cwd(), 'dist');
console.log("📁 Serving static files from:", distPath);

// Serve static files
app.use(express.static(distPath));

// ===== CATCH-ALL ROUTE - MUST COME LAST =====
app.get('*', (req, res) => {
  // Don't serve HTML for API routes
  if (req.path.startsWith('/api/')) {
    return res.status(404).json({ error: `API endpoint ${req.path} not found` });
  }
  // For everything else, serve the React app
  res.sendFile(path.join(distPath, 'index.html'));
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`🚀 Server running on port ${PORT}`);
  console.log(`📍 Test API: http://0.0.0.0:${PORT}/api/test`);
  console.log(`📍 Health API: http://0.0.0.0:${PORT}/api/health`);
  console.log(`📍 Stats API: http://0.0.0.0:${PORT}/api/stats`);
  console.log(`📱 Frontend: http://0.0.0.0:${PORT}`);
});
