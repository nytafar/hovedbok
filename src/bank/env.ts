// Env contract for the Enable Banking adapter (README "Enable Banking").
//
//   ENABLE_BANKING_APP_ID        application id from the Control Panel (JWT kid)   required
//   ENABLE_BANKING_KEY_FILE      path to the app's RSA private key (PEM)           required
//   ENABLE_BANKING_API_URL       default https://api.enablebanking.com            optional
//   ENABLE_BANKING_REDIRECT_URL  redirect URL registered on the app; the consent
//                                callback lands here with ?code&state             required for consent
import { DEFAULT_API_URL, EnableBankingClient } from "./client";

export interface BankEnv {
  appId: string;
  keyFile: string;
  apiUrl: string;
  redirectUrl: string | undefined;
}

export function bankEnv(env: Record<string, string | undefined> = process.env): BankEnv {
  const appId = env.ENABLE_BANKING_APP_ID?.trim();
  const keyFile = env.ENABLE_BANKING_KEY_FILE?.trim();
  if (!appId) throw new Error("ENABLE_BANKING_APP_ID is not set");
  if (!keyFile) throw new Error("ENABLE_BANKING_KEY_FILE is not set");
  return {
    appId,
    keyFile,
    apiUrl: env.ENABLE_BANKING_API_URL?.trim() || DEFAULT_API_URL,
    redirectUrl: env.ENABLE_BANKING_REDIRECT_URL?.trim() || undefined,
  };
}

/** A client from the environment; reads the key file once. */
export async function clientFromEnv(env: Record<string, string | undefined> = process.env): Promise<EnableBankingClient> {
  const e = bankEnv(env);
  const privateKeyPem = await Bun.file(e.keyFile).text();
  return new EnableBankingClient({ appId: e.appId, privateKeyPem, apiUrl: e.apiUrl });
}
