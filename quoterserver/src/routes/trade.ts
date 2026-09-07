import { NextFunction, Request, Response, Router } from "express";
import { executeAquaTrade } from "../trade";
import { ApiError, TradeRequest } from "../types";

export const tradeRouter = Router();

// POST /trade
tradeRouter.post("/", async (req: Request, res: Response, next: NextFunction) => {
  try {
    const body = req.body as Partial<TradeRequest>;
    const fields: Array<keyof TradeRequest> = ["chainId", "encodedOrder", "tokenIn", "tokenOut", "amountIn", "minAmountOut"];
    for (const field of fields) {
      if (body[field] === undefined || body[field] === "") {
        throw new ApiError(400, `Missing required field: ${field}`);
      }
    }
    res.status(201).json(await executeAquaTrade(body as TradeRequest));
  } catch (error) {
    next(error);
  }
});
