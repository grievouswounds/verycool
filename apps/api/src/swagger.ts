import swaggerCss from "swagger-ui-dist/swagger-ui.css" with { type: "text" };
import swaggerJavaScript from "swagger-ui-dist/swagger-ui-bundle.js" with { type: "text" };

export const swaggerCssResponse = new Response(swaggerCss, { headers: { "content-type": "text/css; charset=utf-8", "cache-control": "public, max-age=31536000, immutable" } });
export const swaggerJavaScriptResponse = new Response(swaggerJavaScript, { headers: { "content-type": "text/javascript; charset=utf-8", "cache-control": "public, max-age=31536000, immutable" } });
