import express from "express";
import { createServer as createViteServer } from "vite";
import axios from "axios";
import dotenv from "dotenv";

dotenv.config();

async function startServer() {
  const app = express();
  const PORT = 3000;

  app.use(express.json());

  // --- Backend Indexing API ---
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
      
      // 2. Blockscout Transfers (History)
      try {
        // Some Blockscout instances prefer 'ERC20' or no type filter at all for this endpoint
        const historyRes = await axios.get(`https://base.blockscout.com/api/v2/addresses/${address}/token-transfers`, {
          params: { limit: 50 }, // Removed 'type' filter to avoid 422 on some instances
          timeout: 8000
        });
        const historyItems = Array.isArray(historyRes.data) ? historyRes.data : (historyRes.data.items || []);
        historyItems.forEach((t: any) => {
          if (t.token?.address && t.token?.type === 'ERC-20') { // Filter manually if needed
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
        // If it's a 422, it likely means the address has no history or the endpoint is sensitive
        if (e.response?.status !== 422) {
          console.warn("Blockscout transfers failed:", e.message);
        }
      }

      // 3. 1inch Token List (Cached or fetched)
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

  // --- 1inch Swap Proxy ---
  app.get("/api/swap/quote", async (req, res) => {
    const { fromTokenAddress, toTokenAddress, amount, fromAddress, slippage } = req.query;
    
    if (!process.env.ONE_INCH_API_KEY) {
      return res.status(401).json({ 
        error: "Invalid API key", 
        description: "ONE_INCH_API_KEY is missing in environment variables. Please add it to your project settings." 
      });
    }

    try {
      // 1inch API v6 on Base
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

  // --- Analytics API (Simple Memory Store for Demo) ---
  let globalStats = {
    totalDustCleanedUsd: 1245.67,
    totalSwaps: 842,
    usersServed: 156
  };

  app.get("/api/health", (req, res) => {
    res.json({
      status: "ok",
      keys: {
        debank: !!process.env.DEBANK_API_KEY,
        oneinch: !!process.env.ONE_INCH_API_KEY
      }
    });
  });

  app.get("/api/stats", (req, res) => {
    res.json(globalStats);
  });

  app.post("/api/report-swap", (req, res) => {
    const { valueUsd } = req.body;
    globalStats.totalDustCleanedUsd += (valueUsd || 0);
    globalStats.totalSwaps += 1;
    res.json({ success: true });
  });

  // Vite middleware for development
  if (process.env.NODE_ENV !== "production") {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: "spa",
    });
    app.use(vite.middlewares);
  } else {
    app.use(express.static("dist"));
    app.get("*", (req, res) => {
      res.sendFile("dist/index.html", { root: "." });
    });
  }

  app.listen(PORT, "0.0.0.0", () => {
    console.log(`Server running on http://0.0.0.0:${PORT}`);
  });
}

startServer();
