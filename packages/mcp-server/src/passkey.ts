import { createHash, createPublicKey, randomBytes, verify } from "node:crypto";
import type { VouchStore } from "@vouch/db";

/**
 * Passkeys for the household's powers (BUILD_PLAN.md §3b, W3 design).
 *
 * THE RULE, the project's own applied to people: anything that spends money
 * or WIDENS the agent's authority needs a passkey; anything that narrows it
 * does not. Approving a held purchase, raising a limit, handing an item over
 * to Auto — passkey. Disputing, pausing, "we're out" — never.
 *
 * WHAT IS SIGNED IS THE ACTION, not just "someone is here". The challenge a
 * passkey signs is sha256(nonce ‖ canonical action), so a yes to "approve
 * Vouch A, $27.80" cannot approve Vouch B, cannot be replayed, and says in
 * the signature itself what was agreed to — the idea behind AP2's signed
 * Cart Mandate. The signed bytes are kept on the record, so anyone holding
 * the public key can re-check the approval later without trusting us.
 *
 * TRUST ON FIRST USE, stated plainly: until the household registers a
 * passkey, the household surface behaves as before — local and trusted, as
 * the README says. Once one exists, protected actions require it, and there
 * is no route that switches that off.
 *
 * Built on node:crypto alone. The browser's getPublicKey() hands over the
 * key as SPKI, which node:crypto reads directly, so no CBOR decoder and no
 * new dependency. Attestation is "none": we do not verify what KIND of
 * authenticator it is, only that the same one signs every approval.
 */

export type ProtectedAction =
  /**
   * `chain_head` is the tamper-evident record's latest entry at the moment of
   * approval (W3b). Signing it anchors the whole history before it to the
   * household's device: a consistent rewrite of the ledger would no longer
   * contain the hash the passkey signed.
   */
  | { kind: "approve_purchase"; vouch_id: string; chain_head: { seq: number; hash: string } | null }
  | { kind: "edit_mandate"; mandate_id: string; changes: Record<string, unknown> }
  | { kind: "set_autonomy"; item_id: string; change: Record<string, unknown> }
  | { kind: "accept_handover"; item_id: string };

export interface PasskeyProof {
  challenge_id: string;
  credential_id: string;
  /** base64url, exactly as the browser produced them. */
  client_data_json: string;
  authenticator_data: string;
  signature: string;
}

export interface StoredPasskey {
  credential_id: string;
  /** SPKI DER, base64url. The only key material ever stored. */
  public_key: string;
  /** COSE algorithm: -7 ES256 or -257 RS256. */
  algorithm: number;
  sign_count: number;
  created_at: string;
}

/** What gets written on the record: enough for anyone to re-verify it. */
export interface ApprovalRecord {
  credential_id: string;
  /** Not secret: with it, anyone can recompute the challenge from the action. */
  nonce: string;
  action: string;
  description: string;
  signed_at: string;
  client_data_json: string;
  authenticator_data: string;
  signature: string;
}

export class PasskeyError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

/** Thrown when a protected action arrives without a passkey; carries what must be signed. */
export class PasskeyRequired extends PasskeyError {
  readonly action: ProtectedAction;
  readonly description: string;
  constructor(action: ProtectedAction, description: string) {
    super(401, "This needs your passkey.");
    this.action = action;
    this.description = description;
  }
}

interface Pending {
  kind: "register" | "action";
  challenge: string;
  nonce?: Buffer;
  action?: string;
  description?: string;
  expires: number;
}

const ACTION_TTL_MS = 2 * 60_000;
const REGISTER_TTL_MS = 5 * 60_000;
const FLAG_USER_PRESENT = 0x01;
const FLAG_USER_VERIFIED = 0x04;

export const b64url = {
  encode: (buf: Buffer | Uint8Array) => Buffer.from(buf).toString("base64url"),
  decode: (s: string) => Buffer.from(s, "base64url"),
};

/** Stable JSON: keys sorted at every level, so the same action always hashes the same. */
export function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

const sha256 = (data: Buffer | string) => createHash("sha256").update(data).digest();

export class PasskeyGuard {
  private readonly store: VouchStore;
  readonly rpId: string;
  readonly origins: readonly string[];
  private readonly now: () => number;
  private readonly pending = new Map<string, Pending>();

  constructor(options: { store: VouchStore; rpId: string; origins: string[]; now?: () => number }) {
    this.store = options.store;
    this.rpId = options.rpId;
    this.origins = options.origins;
    this.now = options.now ?? Date.now;
  }

  passkeys(): StoredPasskey[] {
    return this.store.listPasskeys() as StoredPasskey[];
  }

  isRegistered(): boolean {
    return this.passkeys().length > 0;
  }

  /* ---- registration ---------------------------------------------------- */

  registrationOptions() {
    if (this.isRegistered()) {
      throw new PasskeyError(409, "This household already has a passkey. Adding another device is not built yet.");
    }
    const challenge = b64url.encode(randomBytes(32));
    const id = this.remember({ kind: "register", challenge, expires: this.now() + REGISTER_TTL_MS });
    return {
      challenge_id: id,
      challenge,
      rp: { id: this.rpId, name: "Vouch" },
      user: { id: b64url.encode(sha256("vouch-household")), name: "household", displayName: "Your household" },
      pubKeyCredParams: [
        { type: "public-key", alg: -7 },
        { type: "public-key", alg: -257 },
      ],
      authenticatorSelection: { userVerification: "required", residentKey: "preferred" },
      attestation: "none",
      timeout: REGISTER_TTL_MS,
    };
  }

  register(input: {
    challenge_id: string;
    credential_id: string;
    client_data_json: string;
    authenticator_data: string;
    public_key: string;
    algorithm: number;
  }): StoredPasskey {
    if (this.isRegistered()) throw new PasskeyError(409, "This household already has a passkey.");
    const pending = this.take(input.challenge_id, "register");
    this.checkClientData(input.client_data_json, "webauthn.create", pending.challenge);
    const auth = this.checkAuthenticatorData(input.authenticator_data);
    if (input.algorithm !== -7 && input.algorithm !== -257) {
      throw new PasskeyError(400, `Unsupported passkey algorithm ${input.algorithm}`);
    }
    // Must parse as a real public key, or it is not one.
    createPublicKey({ key: b64url.decode(input.public_key), format: "der", type: "spki" });
    const stored: StoredPasskey = {
      credential_id: input.credential_id,
      public_key: input.public_key,
      algorithm: input.algorithm,
      sign_count: auth.signCount,
      created_at: new Date(this.now()).toISOString(),
    };
    this.store.savePasskey(stored.credential_id, stored);
    return stored;
  }

  /* ---- signing an action ----------------------------------------------- */

  actionChallenge(action: ProtectedAction, description: string) {
    const nonce = randomBytes(32);
    const text = canonical(action);
    const challenge = b64url.encode(sha256(Buffer.concat([nonce, Buffer.from(text)])));
    const id = this.remember({ kind: "action", challenge, nonce, action: text, description, expires: this.now() + ACTION_TTL_MS });
    return {
      challenge_id: id,
      challenge,
      rp_id: this.rpId,
      allow_credentials: this.passkeys().map((p) => p.credential_id),
      description,
      action,
    };
  }

  /**
   * The gate for household powers. No passkey registered yet → null (trust on
   * first use, as documented). Registered and no proof → PasskeyRequired,
   * carrying what must be signed. Registered with a proof → verified, or refused.
   */
  require(action: ProtectedAction, description: string, proof: PasskeyProof | undefined): ApprovalRecord | null {
    if (!this.isRegistered()) return null;
    if (!proof) throw new PasskeyRequired(action, description);
    return this.verify(action, proof);
  }

  verify(action: ProtectedAction, proof: PasskeyProof): ApprovalRecord {
    // Taken (and so spent) before anything else is checked: one attempt per
    // challenge, pass or fail, so a failed guess cannot be retried.
    const pending = this.take(proof.challenge_id, "action");
    if (pending.action !== canonical(action)) {
      throw new PasskeyError(401, "That signature approves a different action.");
    }
    this.checkClientData(proof.client_data_json, "webauthn.get", pending.challenge);
    const auth = this.checkAuthenticatorData(proof.authenticator_data);

    const passkey = this.passkeys().find((p) => p.credential_id === proof.credential_id);
    if (!passkey) throw new PasskeyError(401, "Unknown passkey.");
    if (!verifySignature(passkey, proof)) throw new PasskeyError(401, "The passkey signature does not verify.");

    // A counter that does not move forward is the signature of a cloned
    // authenticator. Some authenticators always report 0; both 0 is allowed.
    if ((passkey.sign_count > 0 || auth.signCount > 0) && auth.signCount <= passkey.sign_count) {
      throw new PasskeyError(401, "This passkey's counter went backwards — refusing, as a clone would.");
    }
    this.store.savePasskey(passkey.credential_id, { ...passkey, sign_count: auth.signCount });

    return {
      credential_id: passkey.credential_id,
      nonce: b64url.encode(pending.nonce!),
      action: pending.action!,
      description: pending.description ?? "",
      signed_at: new Date(this.now()).toISOString(),
      client_data_json: proof.client_data_json,
      authenticator_data: proof.authenticator_data,
      signature: proof.signature,
    };
  }

  /* ---- internals ------------------------------------------------------- */

  private remember(p: Pending): string {
    for (const [id, old] of this.pending) if (old.expires < this.now()) this.pending.delete(id);
    const id = b64url.encode(randomBytes(16));
    this.pending.set(id, p);
    return id;
  }

  private take(id: string, kind: Pending["kind"]): Pending {
    const pending = this.pending.get(id);
    this.pending.delete(id);
    if (!pending || pending.kind !== kind) throw new PasskeyError(401, "That request has expired or was already used. Try again.");
    if (pending.expires < this.now()) throw new PasskeyError(401, "That request has expired. Try again.");
    return pending;
  }

  private checkClientData(encoded: string, type: string, challenge: string): void {
    let data: { type?: string; challenge?: string; origin?: string; crossOrigin?: boolean };
    try {
      data = JSON.parse(b64url.decode(encoded).toString("utf8"));
    } catch {
      throw new PasskeyError(400, "Malformed passkey response.");
    }
    if (data.type !== type) throw new PasskeyError(401, `Expected ${type}.`);
    if (data.challenge !== challenge) throw new PasskeyError(401, "The passkey signed a different challenge.");
    if (!data.origin || !this.origins.includes(data.origin)) {
      throw new PasskeyError(401, `Passkey used from an unexpected page (${data.origin ?? "unknown"}).`);
    }
    if (data.crossOrigin === true) throw new PasskeyError(401, "Cross-origin passkey use is refused.");
  }

  private checkAuthenticatorData(encoded: string): { signCount: number } {
    const auth = b64url.decode(encoded);
    if (auth.length < 37) throw new PasskeyError(400, "Malformed authenticator data.");
    if (!auth.subarray(0, 32).equals(sha256(this.rpId))) {
      throw new PasskeyError(401, "This passkey belongs to a different site.");
    }
    const flags = auth[32]!;
    if (!(flags & FLAG_USER_PRESENT)) throw new PasskeyError(401, "No one was present to approve.");
    // Verified means fingerprint, face or PIN — not just a tap anyone could make.
    if (!(flags & FLAG_USER_VERIFIED)) throw new PasskeyError(401, "The approval was not verified (fingerprint, face or PIN).");
    return { signCount: auth.readUInt32BE(33) };
  }
}

/**
 * Re-checks a stored approval completely, from the record and the public key
 * alone: that the challenge the device signed really was derived from THIS
 * action (sha256(nonce ‖ action)), and that the signature over it verifies.
 */
export function verifyApproval(
  passkey: Pick<StoredPasskey, "public_key" | "algorithm">,
  approval: Pick<ApprovalRecord, "nonce" | "action" | "authenticator_data" | "client_data_json" | "signature">
): { ok: true } | { ok: false; problem: string } {
  const expected = b64url.encode(sha256(Buffer.concat([b64url.decode(approval.nonce), Buffer.from(approval.action)])));
  let challenge: string | undefined;
  try {
    challenge = JSON.parse(b64url.decode(approval.client_data_json).toString("utf8")).challenge;
  } catch {
    return { ok: false, problem: "its signed data is not readable" };
  }
  if (challenge !== expected) return { ok: false, problem: "the signature does not cover the action recorded with it" };
  if (!verifySignature(passkey, approval)) return { ok: false, problem: "the passkey signature does not verify" };
  return { ok: true };
}

/**
 * Re-checks a stored approval against a public key — usable by anyone, later,
 * without our database: the signature covers authenticatorData ‖
 * sha256(clientDataJSON), and clientDataJSON carries the challenge that was
 * derived from the action.
 */
export function verifySignature(
  passkey: Pick<StoredPasskey, "public_key" | "algorithm">,
  signed: Pick<PasskeyProof, "authenticator_data" | "client_data_json" | "signature">
): boolean {
  const data = Buffer.concat([b64url.decode(signed.authenticator_data), sha256(b64url.decode(signed.client_data_json))]);
  const key = createPublicKey({ key: b64url.decode(passkey.public_key), format: "der", type: "spki" });
  try {
    return verify("sha256", data, key, b64url.decode(signed.signature));
  } catch {
    return false;
  }
}
