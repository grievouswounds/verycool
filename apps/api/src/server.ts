import { activityListQuerySchema, activityWipeSchema, addressSchema, AppError, challengeRequestSchema, parseStrictJson, sessionRequestSchema, subscriptionRequestSchema, tradingRequestSchema } from "@aqua/core";
import type { AuthenticatedPrincipal, AuthenticationScope, RuntimeManifest } from "@aqua/core";
import type { AuthService, LedgerWebAuthnService, OAuthService } from "@aqua/adapters";
import type { AuthenticationResponseJSON, RegistrationResponseJSON } from "@simplewebauthn/server";
import type { ActivityService } from "@aqua/activity";
import type { TradingService } from "@aqua/orderbook";
import { createQuoterRoutes } from "@aqua/quoter";
import type { QuoterService } from "@aqua/quoter";
import { z, ZodError } from "zod";
import { docsHtml, openApiDocument } from "./openapi.ts";
import { swaggerCssResponse, swaggerJavaScriptResponse } from "./swagger.ts";
import { handleMcp } from "./mcp.ts";

export interface ServerDependencies {
  readonly trading: TradingService;
  readonly auth: AuthService;
  readonly activity: ActivityService;
  readonly webauthn: LedgerWebAuthnService;
  readonly oauth: OAuthService;
  readonly quoter: QuoterService;
  readonly corsOrigin: string;
  readonly issuer: string;
  readonly resource: string;
  readonly manifest: RuntimeManifest;
  readonly readiness: () => Promise<boolean>;
}

interface ValidationIssue { readonly code: string; readonly path: string; readonly message: string }

const problem = (status: number, type: string, detail: string, requestId: string, issues?: readonly ValidationIssue[]): Response =>
  Response.json({ type, title: statusTitle(status), status, detail, requestId, ...(issues === undefined ? {} : { issues }) }, {
    status, headers: { "content-type": "application/problem+json", "x-request-id": requestId },
  });

const statusTitle = (status: number): string => ({
  400: "Bad Request", 401: "Unauthorized", 402: "Authorization Required", 403: "Forbidden", 404: "Not Found",
  405: "Method Not Allowed", 413: "Content Too Large", 415: "Unsupported Media Type",
  422: "Unprocessable Content", 429: "Too Many Requests", 500: "Internal Server Error",
  502: "Bad Gateway", 503: "Service Unavailable", 504: "Gateway Timeout",
})[status] ?? "Request Failed";

const requestIdLanguage = /^[A-Za-z0-9._:-]{1,128}$/u;
const requestId = (request: Request): string => {
  const supplied = request.headers.get("x-request-id");
  return supplied !== null && requestIdLanguage.test(supplied) ? supplied : crypto.randomUUID();
};

const parseJson = async (request: Request): Promise<unknown> => {
  const mediaType = request.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase();
  if (mediaType !== "application/json") {
    throw new AppError(415, "urn:aqua:error:content-type", "Content-Type must be application/json");
  }
  const contentLength = request.headers.get("content-length");
  if (contentLength !== null && !/^(?:0|[1-9][0-9]{0,5})$/u.test(contentLength)) {
    throw new AppError(400, "urn:aqua:error:content-length", "Content-Length is not canonical");
  }
  if (contentLength !== null && Number(contentLength) > 65_536) throw new AppError(413, "urn:aqua:error:body-size", "Request body exceeds 64 KiB");
  const bytes = new Uint8Array(await request.arrayBuffer());
  if (bytes.length > 65_536) throw new AppError(413, "urn:aqua:error:body-size", "Request body exceeds 64 KiB");
  let text: string;
  try { text = new TextDecoder("utf-8", { fatal: true }).decode(bytes); }
  catch { throw new AppError(400, "urn:aqua:error:utf8", "Request body must be valid UTF-8"); }
  try { return parseStrictJson(text); }
  catch { throw new AppError(400, "urn:aqua:error:json", "Malformed JSON body"); }
};

const parseActivityQuery = (request: Request) => {
  const allowed = new Set(["address", "classification", "from", "to", "cursor", "limit"]);
  const parameters = new URL(request.url).searchParams;
  const value: Record<string, string> = {};
  for (const key of parameters.keys()) {
    if (!allowed.has(key)) throw new AppError(422, "urn:aqua:error:query", `Unknown query parameter: ${key}`);
    if (parameters.getAll(key).length !== 1) throw new AppError(422, "urn:aqua:error:query", `Duplicate query parameter: ${key}`);
    const item = parameters.get(key);
    if (item !== null) value[key] = item;
  }
  return activityListQuerySchema.parse(value);
};

const bearer = async (request: Request, auth: AuthService): Promise<AuthenticatedPrincipal> => {
  const header = request.headers.get("authorization");
  if (header?.startsWith("Bearer ") !== true) {
    throw new AppError(401, "urn:aqua:error:authentication", "Bearer access token is required");
  }
  return auth.authenticate(header.slice(7));
};

const optionalBearer = async (request: Request, auth: AuthService): Promise<AuthenticatedPrincipal | null> => {
  const header = request.headers.get("authorization");
  if (header === null) return null;
  if (!header.startsWith("Bearer ")) throw new AppError(401, "urn:aqua:error:authentication", "Authorization must use the Bearer scheme");
  return auth.authenticate(header.slice(7));
};

const requireScope = (principal: AuthenticatedPrincipal, scope: AuthenticationScope): void => {
  if (!principal.scopes.has(scope)) {
    throw new AppError(403, "urn:aqua:error:scope", `Required scope: ${scope}`, { requiredScope: scope });
  }
};

const cookie = (request: Request, name: string): string | null => {
  const values = request.headers.get("cookie")?.split(";") ?? [];
  for (const item of values) {
    const [key, ...rest] = item.trim().split("=");
    if (key === name) return rest.join("=");
  }
  return null;
};
const registrationResponseSchema=z.custom<RegistrationResponseJSON>((value)=>typeof value==="object"&&value!==null);
const authenticationResponseSchema=z.custom<AuthenticationResponseJSON>((value)=>typeof value==="object"&&value!==null);
const webauthnFinishRegistrationSchema=z.object({id:z.uuid(),response:registrationResponseSchema}).strict();
const webauthnStartAuthenticationSchema=z.object({address:addressSchema}).strict();
const webauthnFinishAuthenticationSchema=z.object({id:z.uuid(),response:authenticationResponseSchema,clientId:z.string().min(1).max(256).default("aqua-mcp-local")}).strict();
const oauthStartSchema=z.object({address:addressSchema,authorization:z.object({client_id:z.string(),redirect_uri:z.url(),resource:z.url(),scope:z.string(),state:z.string(),code_challenge:z.string(),code_challenge_method:z.literal("S256"),response_type:z.literal("code")}).strict()}).strict();
const oauthCompleteSchema=z.object({id:z.uuid(),response:authenticationResponseSchema}).strict();
const form=async(request:Request):Promise<URLSearchParams>=>{const media=request.headers.get("content-type")?.split(";",1)[0]?.trim();if(media!=="application/x-www-form-urlencoded")throw new AppError(415,"invalid_request","OAuth token requests must be form encoded");const text=await request.text();if(text.length>16_384)throw new AppError(413,"invalid_request","OAuth form is too large");return new URLSearchParams(text);};

export const authenticationChallenge = (error: AppError): string | null => {
  if (error.status === 401 && error.type === "urn:aqua:error:authentication") {
    return error.details?.["bearerError"] === "invalid_token" ? 'Bearer error="invalid_token"' : "Bearer";
  }
  if (error.status === 403 && error.type === "urn:aqua:error:scope") {
    const requiredScope = error.details?.["requiredScope"];
    return typeof requiredScope === "string"
      ? `Bearer error="insufficient_scope", scope="${requiredScope}"`
      : null;
  }
  return null;
};

const execute = async (request: Request, action: () => Promise<Response>, corsOrigin: string): Promise<Response> => {
  const id = requestId(request);
  try {
    const response = await action();
    response.headers.set("x-request-id", id);
    response.headers.set("access-control-allow-origin", corsOrigin);
    return response;
  } catch (error: unknown) {
    if (error instanceof AppError) {
      const response = problem(error.status, error.type, error.message, id);
      const challenge = authenticationChallenge(error);
      if (challenge !== null) response.headers.set("www-authenticate", challenge);
      return response;
    }
    if (error instanceof ZodError) return problem(
      422, "urn:aqua:error:validation", "Request does not belong to the endpoint input language", id,
      error.issues.map((issue) => ({ code: issue.code, path: issue.path.map(String).join("."), message: issue.message })),
    );
    console.error(JSON.stringify({ level: "error", requestId: id, message: error instanceof Error ? error.message : "Unknown error" }));
    return problem(500, "urn:aqua:error:internal", "Unexpected server error", id);
  }
};

export const createServerOptions = (dependencies: ServerDependencies): Bun.Serve.Options<undefined> => ({
  routes: {
    ...createQuoterRoutes({quoter:dependencies.quoter,boundary:{
      execute:(request,action)=>execute(request,action,dependencies.corsOrigin),
      parseJson,
      authenticate:async(request,scope)=>{const principal=await bearer(request,dependencies.auth);requireScope(principal,scope);return principal;},
    }}),
    "/.well-known/oauth-protected-resource": () => Response.json({resource:dependencies.resource,authorization_servers:[dependencies.issuer],scopes_supported:["trading:read","trading:write","activity:read","activity:write"]}),
    "/.well-known/oauth-authorization-server": () => Response.json({issuer:dependencies.issuer,authorization_endpoint:`${dependencies.issuer}/authorize`,token_endpoint:`${dependencies.issuer}/token`,registration_endpoint:`${dependencies.issuer}/register`,response_types_supported:["code"],grant_types_supported:["authorization_code","refresh_token"],code_challenge_methods_supported:["S256"],scopes_supported:["trading:read","trading:write","activity:read","activity:write"]}),
    "/authorize": new Response("<!doctype html><meta charset=utf-8><title>Ledger MCP sign-in</title><h1>Ledger MCP sign-in</h1><p>Use the Ledger Security Key app to approve this authorization request.</p><p>This endpoint is completed by the local MCP bridge through <code>/oauth/authorize/start</code> and <code>/oauth/authorize/complete</code>.</p>",{headers:{"content-type":"text/html; charset=utf-8","content-security-policy":"default-src 'none'; style-src 'unsafe-inline'"}}),
    "/register": {POST:(request)=>execute(request,async()=>Response.json(await dependencies.oauth.register(await parseJson(request)),{status:201}),dependencies.corsOrigin)},
    "/oauth/authorize/start": {POST:(request)=>execute(request,async()=>{const input=oauthStartSchema.parse(await parseJson(request));const ceremony=await dependencies.webauthn.authenticationOptions(input.address);await dependencies.oauth.begin(input.address,input.authorization,ceremony.id);return Response.json(ceremony);},dependencies.corsOrigin)},
    "/oauth/authorize/complete": {POST:(request)=>execute(request,async()=>{const input=oauthCompleteSchema.parse(await parseJson(request));const assertion=await dependencies.webauthn.authenticate(input.id,input.response);return Response.json({redirect_uri:await dependencies.oauth.complete(input.id,assertion.owner)});},dependencies.corsOrigin)},
    "/token": {POST:(request)=>execute(request,async()=>{const input=await form(request);const grant=input.get("grant_type");const clientId=input.get("client_id")??"";const resource=input.get("resource")??"";if(grant==="authorization_code")return Response.json(await dependencies.oauth.exchangeCode(input.get("code")??"",clientId,input.get("redirect_uri")??"",resource,input.get("code_verifier")??""));if(grant==="refresh_token")return Response.json(await dependencies.oauth.refresh(input.get("refresh_token")??"",clientId,resource));throw new AppError(400,"unsupported_grant_type","Only authorization_code and refresh_token are accepted");},dependencies.corsOrigin)},
    "/mcp": {POST:(request)=>handleMcp(request,dependencies.manifest,(token)=>dependencies.auth.authenticate(token))},
    "/health/live": new Response("ok", { headers: { "content-type": "text/plain" } }),
    "/health/ready": async () => (await dependencies.readiness())
      ? Response.json({ status: "ready" })
      : Response.json({ status: "not-ready" }, { status: 503 }),
    "/openapi.json": () => Response.json(openApiDocument),
    "/docs": new Response(docsHtml, { headers: { "content-type": "text/html; charset=utf-8" } }),
    "/docs/swagger-ui.css": swaggerCssResponse,
    "/docs/swagger-ui.js": swaggerJavaScriptResponse,
    "/v1/capabilities": () => Response.json({
      apiStyle: "agent-first",
      amountLanguage: "canonical unsigned decimal string; no signs, exponent notation, separators, or leading zeroes",
      tradingEndpoint: "POST /v1/trading",
      actions: ["createOrder", "amendOrder", "cancelOrders", "executeOrder", "prepareSwap", "batch", "query", "manageWrappedNative"],
      orderKinds: ["market", "limit", "stopMarket", "stopLimit", "trailingStop", "takeProfitMarket", "takeProfitLimit", "oco", "bracket"],
      timeInForce: ["gtc", "gtd", "ioc", "fok"],
      fillPolicies: ["partial", "allOrNone"],
      postPolicies: ["normal", "postOnly", "bookOrCancel"],
      defaults: { marketTimeInForce: "ioc", slippageBps: "50", restingTimeInForce: "gtc", fillPolicy: "partial", postPolicy: "normal" },
      authorizationProfile: "aqua-intent-v1 challenge/retry; not x402 payment",
      chainSelection: "deployment-configured; chainId is never accepted in request bodies",
      prices: { available: dependencies.quoter.pricesAvailable, provider: "1inch", endpoints: ["GET /v1/prices/address/:address", "GET /v1/prices/name/:name"] },
      quoteEndpoint: "POST /v1/quotes/aqua",
      erc20Monitoring: {
        transport: "minute polling; no websocket", initialLookbackSeconds: 60,
        classifications: ["buy", "sell", "sent", "received", "minted", "burned", "selfTransfer"],
        buySellPolicy: "inferred only from opposite ERC-20 counterflows in the same transaction",
      },
    }),
    "/v1/auth/challenges": {
      POST: (request) => execute(request, async () => {
        const input = challengeRequestSchema.parse(await parseJson(request));
        return Response.json(await dependencies.auth.challenge(input.address), { status: 201 });
      }, dependencies.corsOrigin),
    },
    "/v1/auth/ledger/registration/options": { POST:(request)=>execute(request,async()=>{const principal=await bearer(request,dependencies.auth);if(principal.authenticationMethods?.has("fido2")===true)throw new AppError(409,"urn:aqua:error:enrollment","Ledger credential is already active");return Response.json(await dependencies.webauthn.registrationOptions(principal.address));},dependencies.corsOrigin) },
    "/v1/auth/ledger/registration/verify": { POST:(request)=>execute(request,async()=>{const principal=await bearer(request,dependencies.auth);const input=webauthnFinishRegistrationSchema.parse(await parseJson(request));const result=await dependencies.webauthn.register(input.id,input.response);if(result.owner!==principal.address)throw new AppError(401,"urn:aqua:error:enrollment","SIWE owner does not match the Ledger credential");return Response.json(result,{status:201});},dependencies.corsOrigin) },
    "/v1/auth/ledger/authentication/options": { POST:(request)=>execute(request,async()=>{const input=webauthnStartAuthenticationSchema.parse(await parseJson(request));return Response.json(await dependencies.webauthn.authenticationOptions(input.address));},dependencies.corsOrigin) },
    "/v1/auth/ledger/authentication/verify": { POST:(request)=>execute(request,async()=>{const input=webauthnFinishAuthenticationSchema.parse(await parseJson(request));const result=await dependencies.webauthn.authenticate(input.id,input.response);return Response.json(await dependencies.auth.issueHardware(result.owner,input.clientId,["trading:read","trading:write","activity:read","activity:write"]));},dependencies.corsOrigin) },
    "/v1/erc20-monitor/subscriptions": {
      GET: (request) => execute(request, async () => {
        const principal = await bearer(request, dependencies.auth);
        requireScope(principal, "activity:read");
        return Response.json({ subscriptions: await dependencies.activity.listSubscriptions(principal) });
      }, dependencies.corsOrigin),
      POST: (request) => execute(request, async () => {
        const principal = await bearer(request, dependencies.auth);
        requireScope(principal, "activity:write");
        const input = subscriptionRequestSchema.parse(await parseJson(request));
        return Response.json(await dependencies.activity.subscribe(input.address, principal));
      }, dependencies.corsOrigin),
    },
    "/v1/erc20-monitor/subscriptions/:address": {
      DELETE: (request) => execute(request, async () => {
        const principal = await bearer(request, dependencies.auth);
        requireScope(principal, "activity:write");
        const address = addressSchema.parse(request.params["address"]);
        return Response.json({ removed: await dependencies.activity.unsubscribe(address, principal) });
      }, dependencies.corsOrigin),
    },
    "/v1/erc20-monitor/actions": {
      GET: (request) => execute(request, async () => {
        const principal = await bearer(request, dependencies.auth);
        requireScope(principal, "activity:read");
        return Response.json(await dependencies.activity.listActions(parseActivityQuery(request), principal));
      }, dependencies.corsOrigin),
    },
    "/v1/erc20-monitor/actions/wipe": {
      POST: (request) => execute(request, async () => {
        const principal = await bearer(request, dependencies.auth);
        requireScope(principal, "activity:write");
        const input = activityWipeSchema.parse(await parseJson(request));
        return Response.json({ deletedCount: (await dependencies.activity.wipe(input, principal)).toString(10) });
      }, dependencies.corsOrigin),
    },
    "/v1/auth/sessions": {
      POST: (request) => execute(request, async () => {
        const input = sessionRequestSchema.parse(await parseJson(request));
        const result = await dependencies.auth.session(input.challengeId, input.message, input.signature);
        const response = Response.json({ accessToken: result.accessToken, expiresIn: result.expiresIn });
        response.headers.append("set-cookie", `refresh_token=${result.refreshToken}; HttpOnly; Secure; SameSite=Strict; Path=/v1/auth; Max-Age=2592000`);
        return response;
      }, dependencies.corsOrigin),
    },
    "/v1/auth/refresh": {
      POST: (request) => execute(request, async () => {
        const refreshToken = cookie(request, "refresh_token");
        if (refreshToken === null) throw new AppError(401, "urn:aqua:error:refresh", "Refresh cookie is required");
        const result = await dependencies.auth.refresh(refreshToken);
        const response = Response.json({ accessToken: result.accessToken, expiresIn: result.expiresIn });
        response.headers.append("set-cookie", `refresh_token=${result.refreshToken}; HttpOnly; Secure; SameSite=Strict; Path=/v1/auth; Max-Age=2592000`);
        return response;
      }, dependencies.corsOrigin),
    },
    "/v1/trading": {
      POST: (request) => execute(request, async () => {
        const input = tradingRequestSchema.parse(await parseJson(request));
        const result = await dependencies.trading.execute(
          input, await optionalBearer(request, dependencies.auth), request.headers.get("aqua-authorization"),
        );
        const response = Response.json(result.body, { status: result.status });
        if (result.headers !== undefined) for (const [name, value] of Object.entries(result.headers)) response.headers.set(name, value);
        return response;
      }, dependencies.corsOrigin),
    },
  },
  fetch(request) {
    const path = new URL(request.url).pathname;
    const getPaths = new Set(["/.well-known/oauth-protected-resource","/.well-known/oauth-authorization-server","/authorize","/health/live", "/health/ready", "/openapi.json", "/docs", "/docs/swagger-ui.css", "/docs/swagger-ui.js", "/v1/capabilities", "/v1/erc20-monitor/subscriptions", "/v1/erc20-monitor/actions"]);
    const postPaths = new Set(["/register","/oauth/authorize/start","/oauth/authorize/complete","/token","/mcp","/v1/auth/challenges", "/v1/auth/sessions", "/v1/auth/refresh", "/v1/auth/ledger/registration/options","/v1/auth/ledger/registration/verify","/v1/auth/ledger/authentication/options","/v1/auth/ledger/authentication/verify", "/v1/trading", "/v1/quotes/aqua", "/v1/erc20-monitor/subscriptions", "/v1/erc20-monitor/actions/wipe"]);
    if (/^\/v1\/erc20-monitor\/subscriptions\/0x[0-9a-fA-F]{40}$/u.test(path)) {
      const response = problem(405, "urn:aqua:error:method", "Method is not allowed for this route", requestId(request));
      response.headers.set("allow", "DELETE");
      return response;
    }
    if (/^\/v1\/prices\/(?:address|name)\/[^/]+$/u.test(path)) {
      const response = problem(405, "urn:aqua:error:method", "Method is not allowed for this route", requestId(request));
      response.headers.set("allow", "GET");
      return response;
    }
    if (getPaths.has(path) || postPaths.has(path)) {
      const response = problem(405, "urn:aqua:error:method", "Method is not allowed for this route", requestId(request));
      response.headers.set("allow", getPaths.has(path) && postPaths.has(path) ? "GET, POST" : getPaths.has(path) ? "GET" : "POST");
      return response;
    }
    return problem(404, "urn:aqua:error:not-found", "Route not found", requestId(request));
  },
  error(error) {
    console.error(JSON.stringify({ level: "error", message: error.message }));
    return problem(500, "urn:aqua:error:internal", "Unexpected server error", crypto.randomUUID());
  },
});
