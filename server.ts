import express from "express";
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

  // ===== API ROUTES =====
  
  // Health check
  app.get("/api/health", (req, res) => {
    res.json({
      status: "ok",
      keys: {
        debank: !!process.env.DEBANK_API_KEY,
        oneinch: !!process.env.ONE_INCH_API_KEY
      }
    });
  });

  // Stats
  let globalStats = {
    totalDustCleanedUsd: 1245.67,
    totalSwaps: 842,
    usersServed: 156
  };

  app.get("/api/stats", (req, res) => {
    res.json(globalStats);
  });

  app.post("/api/report-swap", (req, res) => {
    const { valueUsd } = req.body;
    globalStats.totalDustCleanedUsd += (valueUsd || 0);
    globalStats.totalSwaps += 1;
    globalStats.usersServed += 1;
    res.json({ success: true });
  });

  // Scan endpoint - YOUR ORIGINAL FUNCTION
  app.get("/api/scan/:address", async (req, res) => {
    const { address } = req.params;
    
    if (!address || address === "undefined" || !address.startsWith("0x") || address.length < 40) {
      return res.status(400).json({ error: "Invalid address" });
    }

    const tokens = new Map();

    try {
      // 1. Blockscout Balances
      try {
        const blockscoutRes = await axios.get(`https://base.blockscout.com/api/v2/addresses/${address}/token-balances`, { timeout: 8000 });
        const items = Array.isArray(blockscoutRes.data) ? blockscoutRes.data : (blockscoutRes.data.items || []);
        items.forEach((t: any) => {
          if (t.token?.address) {
            tokens.set(t.token.address.toLowerCase(), {
              symbol: t.token.symbol || '???',
              address: t.token.address,
              decimals: parseInt(t.token.decimals || '18'),
              source: 'indexer'
            });
          }
        });
      } catch (e: any) {
        console.warn("Blockscout balances failed:", e.message);
      }
      
      // 2. Blockscout Transfers
      try {
        const historyRes = await axios.get(`https://base.blockscout.com/api/v2/addresses/${address}/token-transfers`, {
          params: { limit: 50 },
          timeout: 8000
        });
        const historyItems = Array.isArray(historyRes.data) ? historyRes.data : (historyRes.data.items || []);
        historyItems.forEach((t: any) => {
          if (t.token?.address && t.token?.type === 'ERC-20') {
            const addr = t.token.address.toLowerCase();
            if (!tokens.has(addr)) {
              tokens.set(addr, {
                symbol: t.token.symbol || '???',
                address: t.token.address,
                decimals: parseInt(t.token.decimals || '18'),
                source: 'history'
              });
            }
          }
        });
      } catch (e: any) {
        if (e.response?.status !== 422) {
          console.warn("Blockscout transfers failed:", e.message);
        }
      }

      // 3. 1inch Token List
      try {
        const oneInchRes = await axios.get('https://tokens.1inch.io/v1.1/8453', { timeout: 8000 });
        if (oneInchRes.data) {
          Object.values(oneInchRes.data).slice(0, 200).forEach((t: any) => {
            const addr = t.address.toLowerCase();
            if (!tokens.has(addr)) {
              tokens.set(addr, {
                symbol: t.symbol,
                address: t.address,
                decimals: t.decimals,
                source: 'aggregator'
              });
            }
          });
        }
      } catch (e: any) {
        console.warn("1inch list failed:", e.message);
      }

      res.json({ tokens: Array.from(tokens.values()) });
    } catch (error: any) {
      console.error("Critical backend scan failure:", error.message);
      res.status(500).json({ error: "Internal server error during scan" });
    }
  });

  // 1inch Swap endpoint - YOUR ORIGINAL FUNCTION
  app.get("/api/swap/quote", async (req, res) => {
    const { fromTokenAddress, toTokenAddress, amount, fromAddress, slippage } = req.query;
    
    if (!process.env.ONE_INCH_API_KEY) {
      return res.status(401).json({ 
        error: "Invalid API key", 
        description: "ONE_INCH_API_KEY is missing in environment variables" 
      });
    }

    try {
      const response = await axios.get(`https://api.1inch.dev/swap/v6.0/8453/swap`, {
        params: {
          src: fromTokenAddress,
          dst: toTokenAddress,
          amount: amount,
          from: fromAddress,
          slippage: slippage || 3,
          disableEstimate: true
        },
        headers: {
          'Authorization': `Bearer ${process.env.ONE_INCH_API_KEY || ''}`,
          'accept': 'application/json'
        },
        timeout: 10000
      });
      res.json(response.data);
    } catch (e: any) {
      console.error("1inch swap failed:", e.response?.data || e.message);
      res.status(e.response?.status || 500).json(e.response?.data || { error: "Swap quote failed" });
    }
  });

  // Proxy for merkle.io to avoid CORS
  app.post('/api/proxy/merkle', async (req, res) => {
    try {
      console.log('Proxying request to merkle.io');
      const response = await axios.post('https://eth.merkle.io/', req.body, {
        headers: {
          'Content-Type': 'application/json',
          'Origin': 'https://dust-engine.onrender.com',
          'User-Agent': 'DustEngine/1.0'
        },
        timeout: 10000
      });
      res.json(response.data);
    } catch (error: any) {
      console.error('Merkle proxy error:', error.message);
      if (error.response) {
        console.error('Response status:', error.response.status);
        console.error('Response data:', error.response.data);
      }
      res.status(error.response?.status || 500).json({ 
        error: 'Proxy request failed',
        details: error.message 
      });
    }
  });

  // Proxy for hey.xyz ENS resolution
  app.get('/api/proxy/ens/:address', async (req, res) => {
    try {
      const { address } = req.params;
      console.log(`Proxying ENS request for address: ${address}`);
      const response = await axios.get(`https://api.hey.xyz/ens/ccip/${address}`, {
        headers: {
          'Origin': 'https://dust-engine.onrender.com',
          'User-Agent': 'DustEngine/1.0'
        },
        timeout: 10000
      });
      res.json(response.data);
    } catch (error: any) {
      console.error('ENS proxy error:', error.message);
      if (error.response) {
        console.error('Response status:', error.response.status);
        console.error('Response data:', error.response.data);
      }
      res.status(error.response?.status || 500).json({ 
        error: 'ENS resolution failed',
        details: error.message 
      });
    }
  });

  // ===== STATIC FILES =====
  const distPath = path.join(__dirname, "dist");
  console.log(`Serving static files from: ${distPath}`);
  app.use(express.static(distPath));

  // Catch-all route - serve index.html for client-side routing
  app.get('*', (req, res) => {
    if (req.path.startsWith('/api/')) {
      return res.status(404).json({ error: `API endpoint ${req.path} not found` });
    }
    res.sendFile(path.join(distPath, 'index.html'));
  });

  app.listen(PORT, "0.0.0.0", () => {
    console.log(`Server running on port ${PORT}`);
    console.log(`Health: http://0.0.0.0:${PORT}/api/health`);
    console.log(`Stats: http://0.0.0.0:${PORT}/api/stats`);
    console.log(`Scan: http://0.0.0.0:${PORT}/api/scan/0x...`);
  });
}

startServer().catch(console.error);
