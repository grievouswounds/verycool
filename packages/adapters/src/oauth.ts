import { createHash, randomBytes, randomUUID } from "node:crypto";
import type { SQL } from "bun";
import { AppError, AUTHENTICATION_SCOPES, addressSchema } from "@aqua/core";
import type { Address, AuthenticationScope } from "@aqua/core";
import { z } from "zod";

const scopeSchema=z.enum(AUTHENTICATION_SCOPES);
export const DEFAULT_OAUTH_SCOPE = AUTHENTICATION_SCOPES.join(" ");
const clientSchema=z.object({
  redirect_uris:z.array(z.url()).min(1).max(8),
  scope:z.string().optional(),
  client_name:z.string().optional(),
  grant_types:z.array(z.string()).optional(),
  response_types:z.array(z.string()).optional(),
  token_endpoint_auth_method:z.string().optional(),
});
const authorizeSchema=z.object({client_id:z.string().min(1),redirect_uri:z.url(),resource:z.url(),scope:z.string(),state:z.string().min(16).max(512),code_challenge:z.string().regex(/^[A-Za-z0-9_-]{43}$/u),code_challenge_method:z.literal("S256"),response_type:z.literal("code")}).strict();
const sha256=(value:string):string=>createHash("sha256").update(value).digest("base64url");
const tokenHash=(value:string):string=>createHash("sha256").update(value).digest("hex");
export const oauthScopeOrDefault=(value:string | undefined):string=>value===undefined||value.trim()===""?DEFAULT_OAUTH_SCOPE:value;
const scopes=(value:string):AuthenticationScope[]=>{const parsed=oauthScopeOrDefault(value).split(" ").map((scope)=>scopeSchema.parse(scope));if(parsed.length===0||new Set(parsed).size!==parsed.length)throw new AppError(400,"invalid_scope","OAuth scope is empty or duplicated");return parsed;};
const loopbackHosts=new Set(["127.0.0.1","localhost","::1"]);
const hostnameOf=(url:URL):string=>url.hostname==="[::1]"?"::1":url.hostname;
export const oauthRedirectAllowed=(value:string):boolean=>{
  const url=new URL(value);
  if(url.hash!=="")return false;
  if(url.protocol==="https:")return true;
  return url.protocol==="http:"&&loopbackHosts.has(hostnameOf(url));
};
export const oauthRedirectMatches=(registered:string,requested:string):boolean=>{
  if(registered===requested)return true;
  const left=new URL(registered); const right=new URL(requested);
  if(!oauthRedirectAllowed(registered)||!oauthRedirectAllowed(requested))return false;
  const leftLoop=left.protocol==="http:"&&loopbackHosts.has(hostnameOf(left));
  const rightLoop=right.protocol==="http:"&&loopbackHosts.has(hostnameOf(right));
  if(leftLoop&&rightLoop)return hostnameOf(left)===hostnameOf(right)&&left.pathname===right.pathname&&left.search===right.search;
  return false;
};
export const oauthMcpResource=(origin:string):string=>`${origin.replace(/\/$/u,"")}/mcp`;
export const oauthResourceAllowed=(origin:string,resource:string):boolean=>{
  const canonical=origin.replace(/\/$/u,"");
  return resource===canonical||resource===oauthMcpResource(canonical);
};
export const authorizationRedirectWithIss=(redirectUri:string,code:string,state:string,issuer:string):string=>{
  const redirect=new URL(redirectUri);
  redirect.searchParams.set("code",code);
  redirect.searchParams.set("state",state);
  redirect.searchParams.set("iss",issuer);
  return redirect.toString();
};
const rows=<T>(value:T|T[]):T[]=>Array.isArray(value)?value:[value];
const jsonArray=(value:unknown):unknown[]=>{
  if(Array.isArray(value))return value;
  if(typeof value==="string"){const parsed:unknown=JSON.parse(value);if(Array.isArray(parsed))return parsed;}
  throw new AppError(500,"urn:aqua:error:internal","OAuth JSON array column is malformed");
};
const jsonScopes=(value:unknown):AuthenticationScope[]=>jsonArray(value).map((scope)=>scopeSchema.parse(scope));
const jsonRedirects=(value:unknown):string[]=>jsonArray(value).map((item)=>z.url().parse(item));
const resourceAccepted=(stored:string,requested:string,origin:string):boolean=>
  requested===stored||(oauthResourceAllowed(origin,requested)&&oauthResourceAllowed(origin,stored));

interface ClientRow {id:string;redirect_uris:string[];scopes:string[]}
interface RequestRow {challenge_id:string;owner:Address;client_id:string;redirect_uri:string;resource:string;scopes:string[];state:string;code_challenge:string}
interface CodeRow {owner:Address;client_id:string;redirect_uri:string;resource:string;scopes:string[];code_challenge:string}
interface RefreshRow {family_id:string;owner:Address;client_id:string;resource:string;scopes:string[]}
export interface OAuthGrant {readonly owner:Address;readonly clientId:string;readonly resource:string;readonly scopes:readonly AuthenticationScope[]}
export interface OAuthTokenResult {readonly access_token:string;readonly token_type:"Bearer";readonly expires_in:number;readonly refresh_token:string;readonly scope:string}

export class OAuthService {
  private readonly database:SQL;private readonly resource:string;private readonly issuer:string;private readonly issue:(grant:OAuthGrant)=>Promise<string>;
  public constructor(database:SQL,resource:string,issuer:string,issue:(grant:OAuthGrant)=>Promise<string>){this.database=database;this.resource=resource;this.issuer=issuer;this.issue=issue;}
  public async register(input:unknown):Promise<{client_id:string;redirect_uris:readonly string[];scope:string}> {
    const parsed=clientSchema.parse(input);
    if(!parsed.redirect_uris.every(oauthRedirectAllowed))throw new AppError(400,"invalid_redirect_uri","Only HTTPS and loopback HTTP redirects are allowed");
    const allowedScopes=scopes(parsed.scope ?? "");
    const id=randomUUID();
    await this.database`INSERT INTO oauth_clients(id,redirect_uris,scopes) VALUES(${id},${JSON.stringify(parsed.redirect_uris)}::jsonb,${JSON.stringify(allowedScopes)}::jsonb)`;
    return {client_id:id,redirect_uris:parsed.redirect_uris,scope:allowedScopes.join(" ")};
  }
  public async begin(ownerInput:Address,input:unknown,challengeId:string):Promise<void>{
    const owner=addressSchema.parse(ownerInput);
    const raw=z.record(z.string(),z.unknown()).parse(input);
    const parsed=authorizeSchema.parse({...raw,scope:oauthScopeOrDefault(typeof raw["scope"]==="string"?raw["scope"]:undefined)});
    if(!oauthResourceAllowed(this.resource,parsed.resource))throw new AppError(400,"invalid_target","OAuth resource audience mismatch");
    const client=rows(await this.database<ClientRow>`SELECT id,redirect_uris,scopes FROM oauth_clients WHERE id=${parsed.client_id}`)[0];
    const requested=scopes(parsed.scope);
    const redirects=client===undefined?[]:jsonRedirects(client.redirect_uris);
    if(client===undefined||!redirects.some((registered)=>oauthRedirectMatches(registered,parsed.redirect_uri))||!requested.every((scope)=>jsonScopes(client.scopes).includes(scope)))throw new AppError(400,"invalid_request","Client, redirect URI, or scope is not registered");
    await this.database`INSERT INTO oauth_authorization_requests(challenge_id,owner,client_id,redirect_uri,resource,scopes,state,code_challenge,expires_at) VALUES(${challengeId},${owner},${parsed.client_id},${parsed.redirect_uri},${parsed.resource},${JSON.stringify(requested)}::jsonb,${parsed.state},${parsed.code_challenge},now()+interval '5 minutes')`;
  }
  public async complete(challengeId:string,owner:Address):Promise<string>{
    const request=rows(await this.database<RequestRow>`UPDATE oauth_authorization_requests SET used_at=now() WHERE challenge_id=${challengeId} AND owner=${owner} AND used_at IS NULL AND expires_at>now() RETURNING challenge_id,owner,client_id,redirect_uri,resource,scopes,state,code_challenge`)[0];
    if(request===undefined)throw new AppError(400,"invalid_grant","Authorization request is invalid, expired, or used");
    const code=randomBytes(32).toString("base64url");
    await this.database`INSERT INTO oauth_authorization_codes(code_hash,owner,client_id,redirect_uri,resource,scopes,code_challenge,expires_at) VALUES(${tokenHash(code)},${request.owner},${request.client_id},${request.redirect_uri},${request.resource},${JSON.stringify(jsonArray(request.scopes))}::jsonb,${request.code_challenge},now()+interval '2 minutes')`;
    return authorizationRedirectWithIss(request.redirect_uri,code,request.state,this.issuer);
  }
  public async exchangeCode(code:string,clientId:string,redirectUri:string,resource:string,verifier:string):Promise<OAuthTokenResult>{
    if(!/^[A-Za-z0-9._~-]{43,128}$/u.test(verifier))throw new AppError(400,"invalid_grant","PKCE verifier is invalid");
    const row=rows(await this.database<CodeRow>`UPDATE oauth_authorization_codes SET used_at=now() WHERE code_hash=${tokenHash(code)} AND client_id=${clientId} AND redirect_uri=${redirectUri} AND code_challenge=${sha256(verifier)} AND used_at IS NULL AND expires_at>now() RETURNING owner,client_id,redirect_uri,resource,scopes,code_challenge`)[0];
    if(row===undefined||!resourceAccepted(row.resource,resource,this.resource))throw new AppError(400,"invalid_grant","Authorization code or PKCE verifier is invalid");
    return this.tokens({owner:row.owner,clientId:row.client_id,resource:row.resource,scopes:jsonScopes(row.scopes)},randomUUID());
  }
  public async refresh(token:string,clientId:string,resource:string):Promise<OAuthTokenResult>{
    const row=rows(await this.database<RefreshRow>`UPDATE oauth_refresh_tokens SET used_at=now() WHERE token_hash=${tokenHash(token)} AND client_id=${clientId} AND used_at IS NULL AND revoked_at IS NULL AND expires_at>now() RETURNING family_id,owner,client_id,resource,scopes`)[0];
    if(row===undefined||!resourceAccepted(row.resource,resource,this.resource))throw new AppError(400,"invalid_grant","Refresh token is invalid, reused, or expired");
    return this.tokens({owner:row.owner,clientId:row.client_id,resource:row.resource,scopes:jsonScopes(row.scopes)},row.family_id);
  }
  private async tokens(grant:OAuthGrant,familyId:string):Promise<OAuthTokenResult>{
    const refresh=randomBytes(32).toString("base64url");
    await this.database`INSERT INTO oauth_refresh_tokens(token_hash,family_id,owner,client_id,resource,scopes,expires_at) VALUES(${tokenHash(refresh)},${familyId},${grant.owner},${grant.clientId},${grant.resource},${JSON.stringify(grant.scopes)}::jsonb,now()+interval '8 hours')`;
    return {access_token:await this.issue(grant),token_type:"Bearer",expires_in:600,refresh_token:refresh,scope:grant.scopes.join(" ")};
  }
}
