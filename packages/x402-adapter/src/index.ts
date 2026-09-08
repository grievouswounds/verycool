import { createHash } from "node:crypto";
import type { PaymentRequired, PaymentRequirements } from "@x402/core/types";
import { addressSchema, positiveAmountSchema } from "@aqua/core";
import type { Address, RuntimeManifest } from "@aqua/core";
import { z } from "zod";

export const PERMIT2_ADDRESS=addressSchema.parse("0x000000000022D473030F116dDEE9F6B43aC78BA3".toLowerCase());
export const X402_EXACT_PERMIT2_PROXY=addressSchema.parse("0x402085c248EeA27D92E8b30b2C58ed07f9E20001".toLowerCase());
const operationSchema=z.object({operationId:z.uuid(),sellToken:addressSchema,vault:addressSchema,atomicAmount:positiveAmountSchema}).strict();
export interface FundingOperation {readonly operationId:string;readonly sellToken:Address;readonly vault:Address;readonly atomicAmount:string}

export const paymentIdentifier=(operationId:string):string=>createHash("sha256").update(`aqua-order:${operationId}`).digest("hex");

export const exactPermit2UpfrontRequirement=(manifest:RuntimeManifest,input:FundingOperation):PaymentRequired=>{
  const operation=operationSchema.parse(input);
  const accepted:PaymentRequirements={scheme:"exact",network:`eip155:${String(manifest.chain.id)}`,asset:operation.sellToken,amount:operation.atomicAmount,payTo:operation.vault,maxTimeoutSeconds:300,extra:{assetTransferMethod:"permit2",paymentFlow:"upfront",paymentIdentifier:paymentIdentifier(operation.operationId),permit2:manifest.contracts.permit2.address,proxy:manifest.contracts.x402ExactPermit2Proxy.address}};
  return {x402Version:2,error:"Payment is required before trade activation",resource:{url:`${manifest.services.apiUrl}/v1/trades`,description:"Fund the exact immutable Ledger-owned trade plan"},accepts:[accepted]};
};

export const unpaidMcpResult=(paymentRequired:PaymentRequired)=>({isError:true as const,content:[{type:"text" as const,text:"Order vault funding is required before activation"}],_meta:{"x402/payment":paymentRequired}});
export const paidMcpResult=(body:unknown,paymentResponse:unknown)=>({content:[{type:"text" as const,text:JSON.stringify(body)}],_meta:{"x402/payment-response":paymentResponse}});

export interface TokenSimulation {readonly codePresent:boolean;readonly allowance:bigint;readonly balanceBefore:bigint;readonly balanceAfter:bigint;readonly expectedDelta:bigint;readonly stableBalance:boolean}
export const assertStandardTokenFunding=(simulation:TokenSimulation):void=>{if(!simulation.codePresent||simulation.allowance<simulation.expectedDelta||!simulation.stableBalance||simulation.balanceAfter-simulation.balanceBefore!==simulation.expectedDelta)throw new Error("Token failed code, allowance, stability, or exact balance-delta policy");};
