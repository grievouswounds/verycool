import type { PayingHttpClient } from "@aqua/bazantic";

export const retryAquaPayment = (
  client: Pick<PayingHttpClient, "retryAqua">,
  requiredResponse: Response,
  url: URL,
  init: RequestInit,
  network: `eip155:${string}`,
): Promise<Response> => client.retryAqua(requiredResponse, url, init, network);
