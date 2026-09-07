import { NextFunction, Request, Response, Router } from "express";
import { quoteAquaOrder } from "../aquaQuote";
import { ApiError, AquaQuoteRequest } from "../types";

export const aquaRouter = Router();

// POST /aqua/quote
aquaRouter.post("/quote", async (req: Request, res: Response, next: NextFunction) => {
  try {
    const body = req.body as Partial<AquaQuoteRequest>;
    const fields: Array<keyof AquaQuoteRequest> = ["chainId", "encodedOrder", "tokenIn", "tokenOut", "amountIn", "taker"];
    for (const field of fields) {
      if (body[field] === undefined || body[field] === "") {
        throw new ApiError(400, `Missing required field: ${field}`);
      }
    }
    res.json(await quoteAquaOrder(body as AquaQuoteRequest));
  } catch (error) {
    next(error);
  }
});
