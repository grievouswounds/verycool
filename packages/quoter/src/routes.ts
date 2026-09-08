import { addressSchema, AppError } from "@aqua/core";
import type { Address, AuthenticatedPrincipal, AuthenticationScope } from "@aqua/core";
import { aquaQuoteRequestSchema, currencySchema, tokenNameSchema } from "./schemas.ts";
import type { QuoterService } from "./service.ts";

type RouteRequest = Request & { readonly params: Readonly<Record<string, string>> };

export interface QuoterRouteBoundary {
  readonly execute: (request: Request, action: () => Promise<Response>) => Promise<Response>;
  readonly parseJson: (request: Request) => Promise<unknown>;
  readonly authenticate: (request: Request, scope: AuthenticationScope) => Promise<AuthenticatedPrincipal>;
}

export interface QuoterRouteDependencies {
  readonly quoter: QuoterService;
  readonly boundary: QuoterRouteBoundary;
}

export const QUOTER_ROUTE_METHODS = Object.freeze({
  "/v1/prices/address/:address": "GET",
  "/v1/prices/name/:name": "GET",
  "/v1/quotes/aqua": "POST",
} as const);

const currency = (request: Request, defaultCurrency: string): string => {
  const parameters = new URL(request.url).searchParams;
  for (const key of parameters.keys()) if (key !== "currency") throw new AppError(422, "urn:aqua:error:query", `Unknown query parameter: ${key}`);
  if (parameters.getAll("currency").length > 1) throw new AppError(422, "urn:aqua:error:query", "Duplicate query parameter: currency");
  return currencySchema.parse(parameters.get("currency") ?? defaultCurrency);
};

const principal = async (request: Request, dependencies: QuoterRouteDependencies, scope: AuthenticationScope): Promise<Address> =>
  (await dependencies.boundary.authenticate(request, scope)).address;

export const createQuoterRoutes = (dependencies: QuoterRouteDependencies) => ({
  "/v1/prices/address/:address": { GET: (request: RouteRequest) => dependencies.boundary.execute(request, async () => {
    await principal(request, dependencies, "trading:read");
    return Response.json(await dependencies.quoter.priceByAddress(
      addressSchema.parse(request.params["address"]), currency(request, dependencies.quoter.defaultCurrency),
    ));
  }) },
  "/v1/prices/name/:name": { GET: (request: RouteRequest) => dependencies.boundary.execute(request, async () => {
    await principal(request, dependencies, "trading:read");
    return Response.json(await dependencies.quoter.priceByName(
      tokenNameSchema.parse(request.params["name"]), currency(request, dependencies.quoter.defaultCurrency),
    ));
  }) },
  "/v1/quotes/aqua": { POST: (request: Request) => dependencies.boundary.execute(request, async () => {
    const taker = await principal(request, dependencies, "trading:read");
    return Response.json(await dependencies.quoter.quote(aquaQuoteRequestSchema.parse(await dependencies.boundary.parseJson(request)), taker));
  }) },
});
