import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

export class CsrfProtection {
  constructor(private readonly secret = randomBytes(32)) {}

  tokenFor(sessionToken: string): string {
    return createHmac("sha256", this.secret)
      .update("open-desktop-remote:csrf:")
      .update(sessionToken)
      .digest("base64url");
  }

  verify(sessionToken: string, submitted: unknown): boolean {
    if (typeof submitted !== "string") return false;
    const expected = Buffer.from(this.tokenFor(sessionToken));
    const actual = Buffer.from(submitted);
    return (
      expected.length === actual.length &&
      timingSafeEqual(expected, actual)
    );
  }
}
