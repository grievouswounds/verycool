import htmxSource from "htmx.org/dist/htmx.min.js" with { type: "text" };
import { AppError } from "@aqua/core";

export const htmxResponse = new Response(htmxSource, {
  headers: { "content-type": "text/javascript; charset=utf-8", "cache-control": "public, max-age=31536000, immutable" },
});

export const oauthParameterNames = [
  "client_id", "redirect_uri", "resource", "scope", "state", "code_challenge", "code_challenge_method", "response_type",
] as const;

export const escapeHtml = (value: string): string =>
  value.replace(/&/gu, "&amp;").replace(/</gu, "&lt;").replace(/>/gu, "&gt;").replace(/"/gu, "&quot;").replace(/'/gu, "&#39;");

export const htmlFragment = (body: string): Response =>
  new Response(body, { headers: { "content-type": "text/html; charset=utf-8" } });

export type DoorPhase = "idle" | "waiting" | "admitted" | "refused";

const steps: readonly { readonly title: string; readonly body: string }[] = [
  { title: "Know the password", body: "Unlock the Ledger with its PIN." },
  { title: "Find the right door", body: "Open the Security Key app (install it from Ledger Live under My Ledger if it is missing). Keep the device on USB." },
  { title: "Give your name", body: "Enter the enrolled owner address — the one written in the guest ledger." },
  { title: "The doorman looks you over", body: "Chrome offers “Use a passkey” then “USB device”. Safari says “Security Key”." },
  { title: "Sign the register", body: "Confirm on the device: both buttons on a Nano, tap on Stax and Flex." },
  { title: "Come on in", body: "We send you back to the loopback listener the CLI is holding open." },
];

const stepState = (phase: DoorPhase, index: number): "done" | "current" | "todo" => {
  if (phase === "admitted") return "done";
  if (phase === "idle") return index <= 2 ? "current" : "todo";
  if (phase === "waiting") {
    if (index <= 2) return "done";
    if (index <= 4) return "current";
    return "todo";
  }
  if (index <= 2) return "done";
  if (index === 3) return "current";
  return "todo";
};

export const renderSteps = (phase: DoorPhase): string =>
  `<ol id="steps" class="steps" hx-swap-oob="true">${steps.map((step, index) => {
    const state = stepState(phase, index);
    return `<li class="step step-${state}"${state === "current" ? ' aria-current="step"' : ""}><span class="step-mark">${state === "done" ? "✓" : String(index + 1)}</span><div><strong>${step.title}</strong><p>${step.body}</p></div></li>`;
  }).join("")}</ol>`;

const doorSvg = `<svg class="door-art" viewBox="0 0 220 280" role="img" aria-label="Speakeasy door">
  <defs><linearGradient id="wood" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#5c2a2a"/><stop offset="1" stop-color="#2a1014"/></linearGradient></defs>
  <rect x="18" y="12" width="184" height="256" rx="6" fill="url(#wood)" stroke="#c9a227" stroke-width="4"/>
  <rect class="peephole-slide" x="88" y="48" width="44" height="44" rx="22" fill="#0b1c1c"/>
  <circle class="peephole" cx="110" cy="70" r="16" fill="#1a3333" stroke="#c9a227" stroke-width="3"/>
  <circle cx="110" cy="70" r="6" fill="#f5ecd7" opacity=".35"/>
  <rect x="156" y="128" width="18" height="10" rx="2" fill="#c9a227"/>
  <text class="admit-stamp" x="110" y="200" text-anchor="middle" fill="#8b1e1e" font-size="22" font-family="Georgia, serif" letter-spacing="4">ADMITTED</text>
</svg>`;

const doormanSvg = `<svg class="doorman-art" viewBox="0 0 160 220" role="img" aria-label="Doorman">
  <ellipse cx="80" cy="208" rx="46" ry="8" fill="#0a1212"/>
  <rect x="52" y="96" width="56" height="88" rx="6" fill="#1a1a24"/>
  <rect x="52" y="96" width="56" height="18" fill="#8b1e1e"/>
  <path d="M68 114h24v8H68z" fill="#f5ecd7"/>
  <circle class="doorman-head" cx="80" cy="62" r="28" fill="#c4a07a"/>
  <rect x="52" y="38" width="56" height="14" fill="#111"/>
  <path d="M64 78q16 10 32 0" fill="none" stroke="#3a2418" stroke-width="3"/>
  <rect x="74" y="118" width="12" height="28" fill="#c9a227"/>
</svg>`;

const martiniSvg = `<svg class="martini-art" viewBox="0 0 120 160" role="img" aria-label="Martini with a Nano stirrer">
  <path d="M16 24h88L60 86 16 24z" fill="none" stroke="#c9a227" stroke-width="4"/>
  <path d="M28 32h64L60 78 28 32z" fill="#dbeee8" opacity=".55"/>
  <path d="M60 86v44" stroke="#c9a227" stroke-width="4"/>
  <path d="M40 138h40" stroke="#c9a227" stroke-width="6" stroke-linecap="round"/>
  <rect class="nano-stirrer" x="70" y="8" width="14" height="52" rx="3" fill="#7a8388" transform="rotate(18 77 34)"/>
  <circle cx="48" cy="48" r="5" fill="#c9a227"/>
</svg>`;

export const renderEnrollmentPanel = (address: string): string =>
  `<section class="panel enroll" data-outcome="enroll">
    <h2>Not on the guest list</h2>
    <p>No Ledger Security Key credential is enrolled for <code>${escapeHtml(address)}</code>. A browser cannot sign the SIWE challenge this door requires, so enrollment happens at the bar, not at the peephole.</p>
    <p>Switch to the <strong>Ethereum app</strong> for the SIWE signature, then the <strong>Security Key app</strong> for FIDO2 registration, and run:</p>
    <pre><code>bun scripts/enroll-ledger.ts</code></pre>
    <p>The script talks to <code>AQUA_API_URL</code> (default <code>http://127.0.0.1:3000</code>) and needs <code>AQUA_PYTHON</code> with python-fido2 — enter <code>nix develop</code> if either is missing.</p>
  </section>`;

const retryButton = `<button type="submit" form="guest" class="retry">Knock again</button>`;

export const renderErrorFragment = (title: string, body: string, extra = ""): string =>
  `<section class="panel error venue-fail" data-outcome="error"><h2>${title}</h2><p>${body}</p>${extra}${doormanSvg}${renderSteps("refused")}</section>`;

export const renderBrowserError = (name: string): string => {
  if (name === "NotAllowedError") {
    return renderErrorFragment("The peephole closed", "The browser cancelled the Security Key prompt, or it timed out. Unlock the Ledger, open the Security Key app, and knock again.", retryButton);
  }
  if (name === "InvalidStateError") {
    return renderErrorFragment("Wrong coat check", "This credential is already bound in a way the browser will not reuse. Re-enroll with <code>bun scripts/enroll-ledger.ts</code>.");
  }
  if (name === "SecurityError") {
    return renderErrorFragment("Wrong street", "This origin does not match the configured relying party. Load the page at the exact host from <code>manifest.auth</code> — for local work that is <code>http://127.0.0.1:3000/authorize</code>.");
  }
  if (name === "NotSupportedError") {
    return renderErrorFragment("This joint has no peephole", "This browser cannot drive a USB Security Key. Use a current Chrome or Safari on the machine with the Ledger plugged in.");
  }
  if (name === "NotFoundError") {
    return renderErrorFragment("No device at the door", "The browser did not find a Security Key. Plug the Ledger in over USB, open the Security Key app, and knock again.", retryButton);
  }
  return renderErrorFragment("The doorman waved you off", "The Ledger ceremony failed before a signature came back. Unlock the device, open the Security Key app, and knock again.", retryButton);
};

export const renderAppErrorFragment = (error: AppError, address = ""): string => {
  if (error.type === "urn:aqua:error:webauthn-credential" && error.status === 404) {
    return `${renderEnrollmentPanel(address)}${renderSteps("refused")}`;
  }
  if (error.type === "urn:aqua:error:webauthn-challenge") {
    return renderErrorFragment("Your password expired", "The WebAuthn challenge went stale or was already used. Knock again while the Security Key app is open.", retryButton);
  }
  if (error.type === "urn:aqua:error:webauthn-assertion" || error.type === "urn:aqua:error:ledger-attestation") {
    return renderErrorFragment("The doorman does not know that handshake", "The signature was rejected, the assertion counter rolled back, or the device is not a genuine Ledger. Open the Security Key app on the enrolled device and knock again.", retryButton);
  }
  if (error.type === "urn:aqua:error:webauthn-credential") {
    return renderErrorFragment("That name is not on this register", "The credential is not bound to this owner. Check the address, or enroll it with <code>bun scripts/enroll-ledger.ts</code>.");
  }
  if (error.type === "invalid_request" || error.type === "invalid_target") {
    return renderErrorFragment("That client is not on the list", "The calling bridge is not registered, or its redirect and resource do not match. Re-run the MCP bridge so it registers again.");
  }
  return renderErrorFragment("The house says no", escapeHtml(error.message), retryButton);
};

export const renderWaitingFragment = (address: string, ceremony: { readonly id: string; readonly options: unknown }): string =>
  `<section class="panel waiting" data-ceremony="${escapeHtml(JSON.stringify(ceremony))}" data-owner="${escapeHtml(address)}">
    <h2>Hold still</h2>
    <p>Approve the Security Key prompt. Chrome: “Use a passkey”, then “USB device”. Safari: “Security Key”. Then confirm on the Ledger.</p>
    ${doorSvg}${martiniSvg}
  </section>${renderSteps("waiting")}`;

export const renderSuccessFragment = (redirectUri: string): string =>
  `<section class="panel admitted" data-redirect="${escapeHtml(redirectUri)}">
    <h2>Come on in</h2>
    <p>The register is signed. The door swings open.</p>
    ${doorSvg}
  </section>${renderSteps("admitted")}`;

const styles = `
:root{--brass:#c9a227;--cream:#f5ecd7;--oxblood:#5c1218;--teal:#071618;--ink:#0b1010}
*{box-sizing:border-box}
html,body{margin:0;min-height:100%;background:var(--teal);color:var(--cream)}
body{font:16px/1.45 Georgia,"Times New Roman",serif;background:
  radial-gradient(circle at 50% -10%,#1a3a3a 0,transparent 42%),
  repeating-conic-gradient(from 0deg at 50% 0%,#0b1c1c 0 8deg,#071618 8deg 16deg);
  padding:1.25rem}
.wrap{max-width:42rem;margin:0 auto;padding:1.5rem 1.4rem 2rem;background:linear-gradient(180deg,#1a0f12 0%,#12090b 100%);border:1px solid var(--brass);box-shadow:0 0 0 6px #3a1a1a,0 24px 60px #000}
.wrap:before{content:"";display:block;height:10px;margin:-1.5rem -1.4rem 1.2rem;background:repeating-linear-gradient(90deg,var(--brass) 0 12px,transparent 12px 22px)}
h1,h2{font-variant:small-caps;letter-spacing:.18em;color:var(--brass);margin:.2rem 0 .6rem}
.tag{letter-spacing:.4em;text-transform:uppercase;font-size:.72rem;color:#d7c89a}
.rule{height:2px;background:repeating-linear-gradient(90deg,var(--brass) 0 10px,transparent 10px 16px);margin:1rem 0}
label,input,button,pre,code,p{font:inherit}
#guest{display:grid;gap:.75rem;margin:1rem 0}
#guest label{display:grid;gap:.35rem}
#address{background:#2a1814;color:var(--cream);border:none;border-bottom:2px solid var(--brass);padding:.7rem .4rem;letter-spacing:.04em}
button{background:var(--oxblood);color:var(--cream);border:1px solid var(--brass);padding:.8rem 1rem;cursor:pointer;letter-spacing:.16em;text-transform:uppercase}
button:disabled{opacity:.5;cursor:wait}
.art-row{display:flex;gap:1rem;align-items:flex-end;justify-content:space-between;flex-wrap:wrap}
.door-art,.doorman-art,.martini-art{width:min(42vw,160px);height:auto}
.admit-stamp{opacity:0}
.admitted .admit-stamp{opacity:1}
.waiting .peephole-slide{transform:translateX(22px);transition:transform .6s ease}
.venue-fail .doorman-head{transform-origin:80px 62px;animation:no 700ms ease-in-out 2}
@keyframes no{0%,100%{transform:rotate(0)}30%{transform:rotate(-14deg)}70%{transform:rotate(14deg)}}
#chase{height:14px;margin:0 0 1rem;border-radius:999px;background:repeating-radial-gradient(circle at 10px 7px,var(--brass) 0 3px,#3a1a1a 4px 18px);opacity:0}
.htmx-request#chase,.htmx-request #chase,#chase.htmx-request{opacity:1;animation:chase 900ms linear infinite}
@keyframes chase{to{background-position:36px 0}}
.waiting .door-art{filter:drop-shadow(0 0 10px #c9a227aa)}
.admitted .door-art{transform:perspective(400px) rotateY(-38deg);transform-origin:left center;transition:transform .9s ease}
.steps{list-style:none;padding:0;margin:1.2rem 0 0}
.step{display:grid;grid-template-columns:auto 1fr;gap:.7rem;padding:.55rem 0;border-bottom:1px solid #3a2a22}
.step p{margin:.2rem 0 0;color:#d7c89a}
.step-mark{width:1.6rem;height:1.6rem;border:1px solid var(--brass);display:grid;place-items:center;color:var(--brass)}
.step-done .step-mark{background:var(--brass);color:#1a0f12}
.step-todo{opacity:.55}
.panel pre{background:#0b1010;padding:.8rem;overflow:auto;border:1px solid var(--brass)}
.warn{display:none;border:1px solid var(--brass);padding:.8rem;margin:0 0 1rem;background:#3a1212}
.warn.show{display:block}
@media (max-width:640px){body{padding:.6rem}.wrap{padding:1rem}.art-row{justify-content:center}}
@media (prefers-reduced-motion:reduce){
  *,*::before,*::after{animation:none!important;transition:none!important}
  .admitted .door-art{transform:none}
  .waiting .peephole-slide{transform:none}
}
`;

const bridgeScript = `
(function(){
  var names=${JSON.stringify(oauthParameterNames)};
  var query=new URLSearchParams(location.search);
  names.forEach(function(name){
    var field=document.querySelector('[name="'+name+'"]');
    var value=query.get(name);
    if(field&&value) field.value=value;
  });
  var warn=document.getElementById('secure-warning');
  if(!window.isSecureContext||typeof window.PublicKeyCredential==='undefined'){
    if(warn) warn.classList.add('show');
  }
  var fromBase64url=function(value){
    var padded=value.replace(/-/g,'+').replace(/_/g,'/');
    while(padded.length%4) padded+='=';
    return Uint8Array.from(atob(padded),function(character){return character.charCodeAt(0);}).buffer;
  };
  var toBase64url=function(value){
    return btoa(String.fromCharCode.apply(null,Array.from(new Uint8Array(value)))).replace(/[+]/g,'-').replace(/[/]/g,'_').replace(/=+$/g,'');
  };
  var stage=document.getElementById('stage');
  var show=function(html){ if(stage) stage.innerHTML=html; };
  var templates={
    NotAllowedError:document.getElementById('tpl-NotAllowedError'),
    InvalidStateError:document.getElementById('tpl-InvalidStateError'),
    SecurityError:document.getElementById('tpl-SecurityError'),
    NotSupportedError:document.getElementById('tpl-NotSupportedError'),
    NotFoundError:document.getElementById('tpl-NotFoundError'),
    unknown:document.getElementById('tpl-unknown')
  };
  document.body.addEventListener('htmx:afterSwap',function(event){
    var detail=event.detail||{};
    var root=detail.elt||stage;
    if(!root) return;
    var admitted=root.querySelector('[data-redirect]');
    if(admitted){
      var href=admitted.getAttribute('data-redirect');
      var delay=window.matchMedia('(prefers-reduced-motion: reduce)').matches?0:1100;
      window.setTimeout(function(){ if(href) location.assign(href); },delay);
      return;
    }
    var waiting=root.querySelector('[data-ceremony]');
    if(!waiting) return;
    var raw=waiting.getAttribute('data-ceremony');
    if(!raw) return;
    var ceremony=JSON.parse(raw);
    var publicKey=ceremony.options;
    publicKey.challenge=fromBase64url(publicKey.challenge);
    publicKey.allowCredentials=(publicKey.allowCredentials||[]).map(function(item){
      return Object.assign({},item,{id:fromBase64url(item.id)});
    });
    navigator.credentials.get({publicKey:publicKey}).then(function(credential){
      if(!(credential instanceof PublicKeyCredential)) throw new Error('not-credential');
      var assertion=credential.response;
      var payload={
        id:credential.id,
        rawId:toBase64url(credential.rawId),
        type:credential.type,
        authenticatorAttachment:credential.authenticatorAttachment,
        clientExtensionResults:credential.getClientExtensionResults(),
        response:{
          clientDataJSON:toBase64url(assertion.clientDataJSON),
          authenticatorData:toBase64url(assertion.authenticatorData),
          signature:toBase64url(assertion.signature),
          userHandle:assertion.userHandle===null?null:toBase64url(assertion.userHandle)
        }
      };
      return window.htmx.ajax('POST','/authorize/grant',{
        values:{id:ceremony.id,response:JSON.stringify(payload)},
        target:'#stage',
        swap:'innerHTML'
      });
    }).catch(function(error){
      var name=error&&error.name?error.name:'unknown';
      var template=templates[name]||templates.unknown;
      if(template) show(template.innerHTML);
    });
  });
})();
`;

const hiddenFields = oauthParameterNames
  .map((name) => `<input type="hidden" name="${name}" value="">`)
  .join("");

export const authorizePageHtml = `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="htmx-config" content='{"allowEval":false,"selfRequestsOnly":true}'>
<title>The Aqua Room</title>
<style>${styles}</style>
<script src="/authorize/htmx.js"></script>
</head>
<body>
<main class="wrap">
<p class="tag">Members only</p>
<h1>The Aqua Room</h1>
<p>Knock twice, bring your Ledger.</p>
<div class="rule"></div>
<aside id="secure-warning" class="warn">WebAuthn will not run here. Load <code>http://127.0.0.1:3000/authorize</code> on this machine rather than a LAN hostname, and use a browser that can talk to a USB Security Key.</aside>
<div class="art-row">${doorSvg}${doormanSvg}${martiniSvg}</div>
<form id="guest" hx-post="/authorize/ceremony" hx-target="#stage" hx-swap="innerHTML" hx-indicator="#chase" hx-disabled-elt="find button">
${hiddenFields}
<label>Name in the leather guest ledger
<input id="address" name="address" required pattern="0x[0-9a-fA-F]{40}" autocomplete="username" spellcheck="false"></label>
<button type="submit">Knock</button>
</form>
<div id="chase" class="htmx-indicator"></div>
<div id="stage"></div>
${renderSteps("idle")}
<template id="tpl-NotAllowedError">${renderBrowserError("NotAllowedError")}</template>
<template id="tpl-InvalidStateError">${renderBrowserError("InvalidStateError")}</template>
<template id="tpl-SecurityError">${renderBrowserError("SecurityError")}</template>
<template id="tpl-NotSupportedError">${renderBrowserError("NotSupportedError")}</template>
<template id="tpl-NotFoundError">${renderBrowserError("NotFoundError")}</template>
<template id="tpl-unknown">${renderBrowserError("unknown")}</template>
</main>
<script>${bridgeScript}</script>
</body></html>`;

export const authorizePageHeaders: HeadersInit = {
  "content-type": "text/html; charset=utf-8",
  "content-security-policy": "default-src 'none'; connect-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'unsafe-inline'; form-action 'none'; base-uri 'none'; frame-ancestors 'none'",
  "referrer-policy": "no-referrer",
  "x-content-type-options": "nosniff",
};

export const authorizePageResponse = new Response(authorizePageHtml, { headers: authorizePageHeaders });
