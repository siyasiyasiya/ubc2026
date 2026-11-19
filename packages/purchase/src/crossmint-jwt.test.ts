import { createPublicKey, generateKeyPairSync, verify } from "node:crypto";
import { describe, expect, it } from "vitest";

import { CrossmintJwtSigner } from "./crossmint-jwt.js";

const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const pem = privateKey.export({ type: "pkcs8", format: "pem" }).toString();

function decode(part: string): Record<string, unknown> {
  return JSON.parse(Buffer.from(part, "base64url").toString()) as Record<string, unknown>;
}

describe("CrossmintJwtSigner", () => {
  const signer = new CrossmintJwtSigner({
    privateKeyPem: pem.replace(/\n/g, "\\n"), // as it sits in a .env file
    kid: "kitty-1",
    issuer: "https://kittyagent.vercel.app",
    now: () => 1_700_000_000_000,
  });

  it("signs an RS256 token for the user that verifies against the published JWKS", () => {
    const token = signer.tokenFor("kitty-neena");
    const [h, p, sig] = token.split(".") as [string, string, string];
    expect(decode(h)).toEqual({ alg: "RS256", typ: "JWT", kid: "kitty-1" });
    expect(decode(p)).toEqual({
      iss: "https://kittyagent.vercel.app",
      sub: "kitty-neena",
      iat: 1_700_000_000,
      exp: 1_700_003_600,
    });

    const jwk = signer.jwks().keys[0]!;
    expect(jwk).toMatchObject({ kty: "RSA", kid: "kitty-1", alg: "RS256", use: "sig" });
    expect(jwk).not.toHaveProperty("d"); // public half only
    const pub = createPublicKey({ key: jwk, format: "jwk" });
    expect(verify("RSA-SHA256", Buffer.from(`${h}.${p}`), pub, Buffer.from(sig, "base64url"))).toBe(true);
  });
});
