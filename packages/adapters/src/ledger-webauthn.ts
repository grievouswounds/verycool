/* eslint-disable @typescript-eslint/prefer-optional-chain -- explicit guards preserve verifier union narrowing */
import type { SQL } from "bun";
import {
  generateAuthenticationOptions,
  generateRegistrationOptions,
  SettingsService,
  verifyAuthenticationResponse,
  verifyRegistrationResponse,
} from "@simplewebauthn/server";
import type { AuthenticationResponseJSON, RegistrationResponseJSON, WebAuthnCredential } from "@simplewebauthn/server";
import { AppError, addressSchema } from "@aqua/core";
import type { Address } from "@aqua/core";
import { z } from "zod";

export const LEDGER_ATTESTATION_ROOT = `-----BEGIN CERTIFICATE-----
MIIBgTCCAScCFFM1QCDXg122F9cvWFVmqeGX3tQWMAoGCCqGSM49BAMCMEMxCzAJ
BgNVBAYTAkZSMQ8wDQYDVQQKDAZMZWRnZXIxIzAhBgNVBAMMGkxlZGdlciBGSURP
IEF0dGVzdGF0aW9uIENBMB4XDTI0MDUzMDE0MTk0MFoXDTM0MDUyODE0MTk0MFow
QzELMAkGA1UEBhMCRlIxDzANBgNVBAoMBkxlZGdlcjEjMCEGA1UEAwwaTGVkZ2Vy
IEZJRE8gQXR0ZXN0YXRpb24gQ0EwWTATBgcqhkjOPQIBBggqhkjOPQMBBwNCAATK
7nXyH4pgN3TMwCWSoMDRe4EV8Jl3XzuhicZ/2gvh+zz3WmW0OZ/EcRYEA8F26cee
uMcd21WQRRKWpjWD+JWiMAoGCCqGSM49BAMCA0gAMEUCIQD8J+0/b8PeYjFRQYkU
Rcqhax27olw1jY/pbskhBuRp4AIgOAHb6n+7fNffyoxpeCq3VZ7B1jN3wqmPNfna
eAjdoXs=
-----END CERTIFICATE-----`;

export const LEDGER_AAGUIDS = new Set([
  "fcb1bcb4-f370-078c-6993-bc24d0ae3fbe", // Nano X
  "58b44d0b-0a7c-f33a-fd48-f7153c871352", // Nano S+
  "6e24d385-004a-16a0-7bfe-efd963845b34", // Stax
  "1d8cac46-47a1-3386-af50-e88ae46fe802", // Flex
  "b3315166-f36c-b05f-fea8-66a3dfdad171", // Apex P
]);

type Ceremony = "registration" | "authentication";
interface ChallengeRecord { readonly id: string; readonly owner: Address; readonly ceremony: Ceremony; readonly challenge: string }
interface CredentialRecord { readonly id: string; readonly owner: Address; readonly publicKey: Uint8Array; readonly counter: number; readonly transports?: WebAuthnCredential["transports"] }

export interface LedgerWebAuthnStore {
  saveChallenge(value: ChallengeRecord, expiresAt: Date): Promise<void>;
  consumeChallenge(id: string, ceremony: Ceremony): Promise<ChallengeRecord | null>;
  saveCredential(value: CredentialRecord, aaguid: string): Promise<void>;
  credential(id: string): Promise<CredentialRecord | null>;
  credentials(owner: Address): Promise<readonly CredentialRecord[]>;
  advanceCounter(id: string, previous: number, next: number): Promise<boolean>;
}

interface ChallengeRow { id: string; owner: Address; kind: Ceremony; challenge: string }
interface CredentialRow { credential_id: string; owner: Address; public_key: Uint8Array; counter: string; transports: string[] | null }
const sqlRows = <T>(value: T | T[]): T[] => Array.isArray(value) ? value : [value];
const transportsSchema = z.array(z.enum(["ble","cable","hybrid","internal","nfc","smart-card","usb"]));

export class PostgresLedgerWebAuthnStore implements LedgerWebAuthnStore {
  private readonly database: SQL;
  public constructor(database: SQL) { this.database = database; }
  public async saveChallenge(value: ChallengeRecord, expiresAt: Date): Promise<void> { await this.database`INSERT INTO webauthn_challenges(id,owner,kind,challenge,expires_at) VALUES(${value.id},${value.owner},${value.ceremony},${value.challenge},${expiresAt})`; }
  public async consumeChallenge(id: string, ceremony: Ceremony): Promise<ChallengeRecord | null> { const row=sqlRows(await this.database<ChallengeRow>`UPDATE webauthn_challenges SET used_at=now() WHERE id=${id} AND kind=${ceremony} AND used_at IS NULL AND expires_at>now() RETURNING id,owner,kind,challenge`)[0]; return row===undefined?null:{id:row.id,owner:row.owner,ceremony:row.kind,challenge:row.challenge}; }
  public async saveCredential(value: CredentialRecord, aaguid: string): Promise<void> { await this.database`INSERT INTO webauthn_credentials(credential_id,owner,public_key,counter,transports,aaguid,device_type,backed_up) VALUES(${value.id},${value.owner},${value.publicKey},${value.counter},${JSON.stringify(value.transports??[])},${aaguid},'singleDevice',false)`; }
  private map(row: CredentialRow): CredentialRecord { return { id:row.credential_id, owner:row.owner, publicKey:Uint8Array.from(row.public_key), counter:Number(row.counter), ...(row.transports===null?{}:{transports:transportsSchema.parse(row.transports)}) }; }
  public async credential(id: string): Promise<CredentialRecord | null> { const row=sqlRows(await this.database<CredentialRow>`SELECT credential_id,owner,public_key,counter::text,transports FROM webauthn_credentials WHERE credential_id=${id}`)[0]; return row===undefined?null:this.map(row); }
  public async credentials(owner: Address): Promise<readonly CredentialRecord[]> { return sqlRows(await this.database<CredentialRow>`SELECT credential_id,owner,public_key,counter::text,transports FROM webauthn_credentials WHERE owner=${owner}`).map((row)=>this.map(row)); }
  public async advanceCounter(id: string, previous: number, next: number): Promise<boolean> { const result=sqlRows(await this.database<{credential_id:string}>`UPDATE webauthn_credentials SET counter=${next},last_used_at=now() WHERE credential_id=${id} AND counter=${previous} AND (${next}>counter OR (${next}=0 AND counter=0)) RETURNING credential_id`); return result.length===1; }
}

export class LedgerWebAuthnService {
  private readonly store: LedgerWebAuthnStore; private readonly rpID: string; private readonly origin: string;
  public constructor(store: LedgerWebAuthnStore, rpID: string, origin: string) { this.store=store; this.rpID=rpID; this.origin=origin; SettingsService.setRootCertificates({identifier:"packed",certificates:[LEDGER_ATTESTATION_ROOT]}); }
  public async registrationOptions(ownerInput: Address): Promise<{id:string;options:Awaited<ReturnType<typeof generateRegistrationOptions>>}> { const owner=addressSchema.parse(ownerInput); const options=await generateRegistrationOptions({rpName:"Aqua Ledger MCP",rpID:this.rpID,userName:owner,userID:new TextEncoder().encode(owner),attestationType:"direct",supportedAlgorithmIDs:[-7],authenticatorSelection:{authenticatorAttachment:"cross-platform",residentKey:"required",userVerification:"required"}}); const id=crypto.randomUUID(); await this.store.saveChallenge({id,owner,ceremony:"registration",challenge:options.challenge},new Date(Date.now()+300_000)); return {id,options}; }
  public async register(id:string,response:RegistrationResponseJSON):Promise<{owner:Address;credentialId:string}> { const challenge=await this.store.consumeChallenge(id,"registration"); if(challenge===null) throw new AppError(409,"urn:aqua:error:webauthn-challenge","Registration challenge is invalid, expired, or used"); const result=await verifyRegistrationResponse({response,expectedChallenge:challenge.challenge,expectedOrigin:this.origin,expectedRPID:this.rpID,requireUserVerification:true,supportedAlgorithmIDs:[-7]}); const info=result.registrationInfo; if(!result.verified||info===undefined||info.fmt!=="packed"||!LEDGER_AAGUIDS.has(info.aaguid)||info.credentialDeviceType!=="singleDevice"||info.credentialBackedUp) throw new AppError(401,"urn:aqua:error:ledger-attestation","A direct Ledger hardware attestation is required"); await this.store.saveCredential({id:info.credential.id,owner:challenge.owner,publicKey:info.credential.publicKey,counter:info.credential.counter,...(info.credential.transports===undefined?{}:{transports:info.credential.transports})},info.aaguid); return {owner:challenge.owner,credentialId:info.credential.id}; }
  public async authenticationOptions(ownerInput:Address):Promise<{id:string;options:Awaited<ReturnType<typeof generateAuthenticationOptions>>}> { const owner=addressSchema.parse(ownerInput); const credentials=await this.store.credentials(owner); if(credentials.length===0) throw new AppError(404,"urn:aqua:error:webauthn-credential","No Ledger credential is enrolled"); const options=await generateAuthenticationOptions({rpID:this.rpID,userVerification:"required",allowCredentials:credentials.map((credential)=>({id:credential.id,...(credential.transports===undefined?{}:{transports:credential.transports})}))}); const id=crypto.randomUUID(); await this.store.saveChallenge({id,owner,ceremony:"authentication",challenge:options.challenge},new Date(Date.now()+300_000)); return {id,options}; }
  public async authenticate(id:string,response:AuthenticationResponseJSON):Promise<{owner:Address;amr:readonly ["fido2","hwk"]}> { const challenge=await this.store.consumeChallenge(id,"authentication"); if(challenge===null) throw new AppError(409,"urn:aqua:error:webauthn-challenge","Authentication challenge is invalid, expired, or used"); const stored=await this.store.credential(response.id); if(stored===null||stored.owner!==challenge.owner) throw new AppError(401,"urn:aqua:error:webauthn-credential","Credential is not bound to this Ledger owner"); const credential:WebAuthnCredential={id:stored.id,publicKey:Uint8Array.from(stored.publicKey),counter:stored.counter,...(stored.transports===undefined?{}:{transports:stored.transports})}; const result=await verifyAuthenticationResponse({response,expectedChallenge:challenge.challenge,expectedOrigin:this.origin,expectedRPID:this.rpID,credential,requireUserVerification:true}); if(!result.verified||!result.authenticationInfo.userVerified||!await this.store.advanceCounter(stored.id,stored.counter,result.authenticationInfo.newCounter)) throw new AppError(401,"urn:aqua:error:webauthn-assertion","Ledger assertion failed or its counter rolled back"); return {owner:stored.owner,amr:["fido2","hwk"]}; }
}
