/**
 * Kitty's own user tokens for Crossmint ("Custom tokens" JWT auth).
 *
 * Crossmint only accepts card authorizations (order intents) and card saving
 * from a client key plus a user JWT. We don't run a separate auth provider, so
 * Kitty signs short-lived RS256 tokens itself; Crossmint verifies them against
 * the public key served at `<ONBOARD_URL>/api/jwks`.
 */

import { createPrivateKey, createPublicKey, sign, type KeyObject } from "node:crypto";

export interface CrossmintJwtConfig {
  /** PKCS#8 PEM private key (RSA). `\n` escapes are accepted, for .env files. */
  privateKeyPem: string;
  /** Key id; must match the `kid` in the published JWKS. */
  kid: string;
  /** Must match the issuer registered in the Crossmint console. */
  issuer: string;
  audience?: string;
  /** Token lifetime. Default 1 hour. */
  ttlSeconds?: number;
  now?: () => number;
}

function b64url(data: Buffer | string): string {
  return Buffer.from(data).toString("base64url");
}

function loadKey(pem: string): KeyObject {
  return createPrivateKey(pem.includes("\\n") ? pem.replace(/\\n/g, "\n") : pem);
}

export class CrossmintJwtSigner {
  private readonly key: KeyObject;

  constructor(private readonly cfg: CrossmintJwtConfig) {
    this.key = loadKey(cfg.privateKeyPem);
  }

  /** A signed token whose `sub` is the Crossmint user id. */
  tokenFor(userId: string): string {
    const iat = Math.floor((this.cfg.now ?? Date.now)() / 1000);
    const header = { alg: "RS256", typ: "JWT", kid: this.cfg.kid };
    const payload: Record<string, string | number> = {
      iss: this.cfg.issuer,
      sub: userId,
      iat,
      exp: iat + (this.cfg.ttlSeconds ?? 3600),
    };
    if (this.cfg.audience) payload.aud = this.cfg.audience;
    const input = `${b64url(JSON.stringify(header))}.${b64url(JSON.stringify(payload))}`;
    const signature = sign("RSA-SHA256", Buffer.from(input), this.key);
    return `${input}.${b64url(signature)}`;
  }

  /** The JWKS document to publish (public half only). */
  jwks(): { keys: Array<Record<string, string>> } {
    const jwk = createPublicKey(this.key).export({ format: "jwk" }) as Record<string, string>;
    return { keys: [{ ...jwk, kid: this.cfg.kid, alg: "RS256", use: "sig" }] };
  }
}
