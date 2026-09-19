import { startMerchantServer } from "./server.ts";

/** Entry point for `npm run dev:mock-merchant`. */
const port = Number(process.env.MERCHANT_PORT ?? 4010);

const { url } = await startMerchantServer(port);
console.log(`[mock-merchant] UCP ${url}/ucp/checkout-sessions`);
console.log(`[mock-merchant] discovery ${url}/.well-known/ucp`);
console.log(`[mock-merchant] demo control POST ${url}/demo/price`);
