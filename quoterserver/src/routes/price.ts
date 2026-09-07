import { Router, Request, Response, NextFunction } from "express";
import { getSpotPriceByAddress, searchToken } from "../oneInchClient";
import { ApiError, PriceResult } from "../types";
import { config } from "../config";

export const priceRouter = Router();

const ADDRESS_REGEX = /^0x[a-fA-F0-9]{40}$/;

function parseChainId(raw: string): number {
  const chainId = Number(raw);
  if (!Number.isInteger(chainId) || chainId <= 0) {
    throw new ApiError(400, `Invalid chainId: ${raw}`);
  }
  return chainId;
}

// GET /price/address/:chainId/:address
// Returns the spot price for a token given its contract address.
priceRouter.get(
  "/address/:chainId/:address",
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const chainId = parseChainId(req.params.chainId);
      const { address } = req.params;
      const currency = (req.query.currency as string) ?? config.defaultCurrency;

      if (!ADDRESS_REGEX.test(address)) {
        throw new ApiError(400, `Invalid token address: ${address}`);
      }

      const price = await getSpotPriceByAddress(chainId, address, currency);

      const result: PriceResult = { chainId, address, currency, price };
      res.json(result);
    } catch (err) {
      next(err);
    }
  },
);

// GET /price/name/:chainId/:name
// Resolves a token name/symbol to an address via the Token API, then fetches
// its spot price via the Spot Price API.
priceRouter.get(
  "/name/:chainId/:name",
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const chainId = parseChainId(req.params.chainId);
      const { name } = req.params;
      const currency = (req.query.currency as string) ?? config.defaultCurrency;

      const token = await searchToken(chainId, name);
      const price = await getSpotPriceByAddress(
        chainId,
        token.address,
        currency,
      );

      const result: PriceResult = {
        chainId,
        address: token.address,
        symbol: token.symbol,
        name: token.name,
        currency,
        price,
      };
      res.json(result);
    } catch (err) {
      next(err);
    }
  },
);
