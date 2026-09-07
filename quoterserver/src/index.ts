import express, { NextFunction, Request, Response } from "express";
import { config } from "./config";
import { priceRouter } from "./routes/price";
import { tradeRouter } from "./routes/trade";
import { aquaRouter } from "./routes/aqua";
import { ApiError } from "./types";

const app = express();
app.use(express.json());

app.get("/health", (_req, res) => {
  res.json({ status: "ok" });
});

app.use("/price", priceRouter);
app.use("/trade", tradeRouter);
app.use("/aqua", aquaRouter);

// 404 handler
app.use((req: Request, res: Response) => {
  res.status(404).json({ error: `Not found: ${req.method} ${req.path}` });
});

// Centralized error handler — translates ApiError (and anything else) into
// a consistent JSON error response.
app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
  if (err instanceof ApiError) {
    res.status(err.status).json({ error: err.message });
    return;
  }
  console.error(err);
  res.status(500).json({ error: "Internal server error" });
});

app.listen(config.port, () => {
  console.log(`1inch price server listening on port ${config.port}`);
});
