import express from "express";
import { createServer as createViteServer } from "vite";
import axios from "axios";
import dotenv from "dotenv";
import path from "path";
import { fileURLToPath } from 'url';

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

async function startServer() {
  const app = express();
  const PORT = process.env.PORT || 3000;

  app.use(express.json());

  // --- API Routes - THESE MUST COME BEFORE STATIC FILES ---
  
  // Health check endpoint
  app.get("/api/health", (req, res) => {
    console.log("Health endpoint called");
    res.json({
      status: "ok",
      keys: {
        debank: !!process.env.DEBANK_API_KEY,
        oneinch: !!process.env.ONE_INCH_API_KEY
      }
    });
  });

  // Stats endpoint
  app.get("/api/stats", (req, res) => {
    console.log("Stats endpoint called");
    res.json({
      totalDustCleanedUsd: 1245.67,
      totalSwaps: 842,
      usersServed: 156
    });
  });

  // Scan endpoint
  app.get("/api/scan/:address", async (req, res) => {
    const { address } = req.params;
    console.log(`Scan endpoint called for address: ${address}`);
    
    // Return mock data for now
    res.json({
      tokens: [
        { symbol: 'USDC', address: '0x833589fCD6eDb6E08f4C7C32D4f71bdA02913', decimals: 6, source: 'mock' },
        { symbol: 'AERO', address: '0x940181a94A35A4569E4529A3CDfB74e38FD91310', decimals: 18, source: 'mock' }
      ]
    });
  });

  // Swap quote endpoint
  app.get("/api/swap/quote", async (req, res) => {
    console.log("Swap quote endpoint called");
    res.json({
      fromToken: { symbol: 'USDC', address: '0x...', decimals: 6 },
      toToken: { symbol: 'ETH', address: '0x...', decimals: 18 },
      fromAmount: '1000000',
      toAmount: '500000000000000000',
      estimatedGas: '150000'
    });
  });

  // Report swap endpoint
  app.post("/api/report-swap", (req, res) => {
    console.log("Report swap endpoint called");
    res.json({ success: true });
  });

  // --- Static files - THESE COME AFTER API ROUTES ---
  
  // Serve static files from dist in production
  const distPath = path.join(process.cwd(), 'dist');
  console.log(`Serving static files from: ${distPath}`);
  
  app.use(express.static(distPath));

  // For any other route, serve index.html (for client-side routing)
  app.get('*', (req, res) => {
    // Skip API routes
    if (req.path.startsWith('/api/')) {
      return res.status(404).json({ error: 'API endpoint not found' });
    }
    res.sendFile(path.join(distPath, 'index.html'));
  });

  app.listen(PORT, "0.0.0.0", () => {
    console.log(`Server running on port ${PORT}`);
    console.log(`Health endpoint: http://0.0.0.0:${PORT}/api/health`);
    console.log(`Stats endpoint: http://0.0.0.0:${PORT}/api/stats`);
  });
}

startServer().catch(console.error);
