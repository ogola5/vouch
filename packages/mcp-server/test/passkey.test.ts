import { strict as assert } from "node:assert";
import { after, before, describe, it } from "node:test";
import { createHash, generateKeyPairSync, randomBytes, sign } from "node:crypto";
import type { Server } from "node:http";

import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { LEDGER_GENESIS, VouchStore, canonicalJson, ledgerHash } from "@vouch/db";
import { startMerchantServer } from "@vouch/mock-merchant";
import { RuleBasedReasoningProvider } from "@vouch/reasoning";
import { MockRingProvider } from "@vouch/ring-integration";
import {
  HouseholdAgent,
  HttpMerchantClient,
  PasskeyGuard,
  VouchService,
  startVouchHttpServer,
  verifyApproval,
  verifySignature,
} from "@vouch/mcp-server";
import type { StoredPasskey } from "@vouch/mcp-server";
import type { Vouch } from "@vouch/shared";

/**
 * Passkeys, tested the way a browser would use them — over HTTP, against the
 * real verification code — with a SOFTWARE AUTHENTICATOR: a real P-256 key
 * that signs exactly the bytes a phone or Windows Hello signs. Nothing is
 * mocked on the server side.
 *
 * The rule under test: spending money or widening the agent's authority needs
 * the household's passkey; narrowing it never does. And what is signed is the
 * action itself.
 */

const RP_ID = "localhost";
const ORIGIN = "http://localhost:4030";
const b64 = (b: Buffer | Uint8Array) => Buffer.from(b).toString("base64url");
const sha256 = (d: Buffer | string) => createHash("sha256").update(d).digest();

class SoftwareAuthenticator {
  private readonly keys = generateKeyPairSync("ec", { namedCurve: "P-256" });
  readonly credentialId = b64(randomBytes(16));
  counter = 0;

  authData(flags = 0x05): Buffer {
    this.counter++;
    const count = Buffer.alloc(4);
    count.writeUInt32BE(this.counter);
    return Buffer.concat([sha256(RP_ID), Buffer.from([flags]), count]);
  }

  register(options: { challenge_id: string; challenge: string }) {
    return {
      challenge_id: options.challenge_id,
      credential_id: this.credentialId,
      client_data_json: b64(Buffer.from(JSON.stringify({ type: "webauthn.create", challenge: options.challenge, origin: ORIGIN }))),
      authenticator_data: b64(this.authData()),
      public_key: b64(this.keys.publicKey.export({ type: "spki", format: "der" })),
      algorithm: -7,
    };
  }

  /** Signs a challenge the server issued, as navigator.credentials.get() would. */
  sign(c: { challenge_id: string; challenge: string }, opts: { origin?: string; flags?: number; tamper?: boolean } = {}) {
    const clientData = Buffer.from(JSON.stringify({ type: "webauthn.get", challenge: c.challenge, origin: opts.origin ?? ORIGIN }));
    const auth = this.authData(opts.flags ?? 0x05);
    const signature = sign("sha256", Buffer.concat([auth, sha256(clientData)]), this.keys.privateKey);
    if (opts.tamper) signature[signature.length - 1] ^= 0xff;
    return {
      challenge_id: c.challenge_id,
      credential_id: this.credentialId,
      client_data_json: b64(clientData),
      authenticator_data: b64(auth),
      signature: b64(signature),
    };
  }
}

interface Rig {
  url: string;
  service: VouchService;
  agent: HouseholdAgent;
  store: VouchStore;
  close: () => void;
}

async function rig(location = ":memory:"): Promise<Rig> {
  const merchant = await startMerchantServer(0);
  const store = VouchStore.open(location);
  const service = new VouchService({
    store,
    merchant: new HttpMerchantClient(merchant.url),
    reasoning: new RuleBasedReasoningProvider(),
    physicalEvidence: new MockRingProvider(),
  });
  const agent = new HouseholdAgent({ store, service });
  const passkeys = new PasskeyGuard({ store, rpId: RP_ID, origins: [ORIGIN] });
  const started = await startVouchHttpServer(0, { service, householdAgent: agent, passkeys });
  service.createMandate({
    mandate_id: "m_detergent",
    goal: "Keep laundry detergent stocked",
    constraints: { max_price: 15, preferred_brand: "Brand A", fallback_brand: "Brand B" },
    requires_approval_if: ["price > max_price", "new_brand"],
    authority_type: "explicit",
  });
  return {
    url: started.householdUrl,
    service,
    agent,
    store,
    close: () => {
      started.server.close();
      started.householdServer.close();
      merchant.server.close();
      store.close();
    },
  };
}

async function call<T = any>(r: Rig, path: string, method = "POST", body?: unknown): Promise<{ status: number; body: T }> {
  const res = await fetch(`${r.url}/household/${path}`, {
    method,
    headers: { "Content-Type": "application/json" },
    body: method === "GET" ? undefined : JSON.stringify(body ?? {}),
  });
  return { status: res.status, body: (await res.json()) as T };
}

async function heldBrandC(r: Rig): Promise<Vouch> {
  const result = await r.service.proposePurchase({
    mandate_id: "m_detergent",
    product_id: "detergent-brand-c",
    brand: "Brand C",
    quantity: 1,
    confidence: 0.9,
    reason: ["biggest_bottle"],
  });
  assert.equal(result.outcome, "held_for_approval");
  return result.vouch;
}

async function registerPasskey(r: Rig, auth: SoftwareAuthenticator) {
  const options = await call(r, "passkey/register/options");
  assert.equal(options.status, 200);
  const done = await call(r, "passkey/register", "POST", auth.register(options.body));
  assert.equal(done.status, 200, JSON.stringify(done.body));
}

describe("passkeys: spending and widening need one, narrowing never does", () => {
  let r: Rig;
  const auth = new SoftwareAuthenticator();
  before(async () => {
    r = await rig();
  });
  after(() => r.close());

  it("before a passkey exists, the local surface is trusted — as documented", async () => {
    const held = await heldBrandC(r);
    const res = await call(r, `vouches/${held.vouch_id}/approve`);
    assert.equal(res.status, 200, "trust on first use: nothing registered yet");
    assert.equal(res.body.vouch.household_approval, null, "and the record says no passkey signed it");
  });

  it("registers the household's passkey; only the public key is kept", async () => {
    await registerPasskey(r, auth);
    const status = await call(r, "passkey", "GET");
    assert.equal(status.body.registered, true);
    const stored = r.store.listPasskeys() as StoredPasskey[];
    assert.equal(stored.length, 1);
    assert.ok(!JSON.stringify(stored).includes("PRIVATE"), "no private key material is ever stored");
  });

  it("refuses to add a second passkey silently", async () => {
    assert.equal((await call(r, "passkey/register/options")).status, 409);
  });

  it("then refuses an unsigned approval — and says exactly what must be signed", async () => {
    const held = await heldBrandC(r);
    const res = await call(r, `vouches/${held.vouch_id}/approve`);
    assert.equal(res.status, 401);
    assert.equal(res.body.needs_passkey, true);
    assert.match(res.body.description, /Brand C.*\$27\.80/);
    // The action also carries the record's latest entry (W3b): signing it
    // anchors the whole history before it to the household's device.
    assert.deepEqual(res.body.action, { kind: "approve_purchase", vouch_id: held.vouch_id, chain_head: r.store.ledgerHead() });
    assert.ok(res.body.challenge && res.body.challenge_id);
  });

  it("a valid signature approves exactly that purchase, and the proof on the record re-verifies", async () => {
    const held = await heldBrandC(r);
    const ask = await call(r, `vouches/${held.vouch_id}/approve`);
    const ok = await call(r, `vouches/${held.vouch_id}/approve`, "POST", { passkey: auth.sign(ask.body) });
    assert.equal(ok.status, 200, JSON.stringify(ok.body));
    assert.equal(ok.body.outcome, "completed");

    const approval = ok.body.vouch.household_approval;
    assert.ok(approval, "the approval is written onto the record");
    assert.match(approval.action, new RegExp(held.vouch_id), "and names the purchase it approved");
    const passkey = (r.store.listPasskeys() as StoredPasskey[])[0]!;
    assert.equal(verifySignature(passkey, approval), true, "anyone with the public key can re-check it");
  });

  it("a signature for one purchase cannot approve another", async () => {
    const a = await heldBrandC(r);
    const b = await heldBrandC(r);
    const askA = await call(r, `vouches/${a.vouch_id}/approve`);
    const res = await call(r, `vouches/${b.vouch_id}/approve`, "POST", { passkey: auth.sign(askA.body) });
    assert.equal(res.status, 401);
    assert.match(res.body.error, /different action/);
  });

  it("cannot be replayed", async () => {
    const held = await heldBrandC(r);
    const ask = await call(r, `vouches/${held.vouch_id}/approve`);
    const proof = auth.sign(ask.body);
    // Spend the challenge on a mismatched action first…
    const other = await heldBrandC(r);
    await call(r, `vouches/${other.vouch_id}/approve`, "POST", { passkey: proof });
    // …then the same proof, now for the right purchase, is already used.
    const again = await call(r, `vouches/${held.vouch_id}/approve`, "POST", { passkey: proof });
    assert.equal(again.status, 401);
    assert.match(again.body.error, /expired or was already used/);
  });

  it("refuses a signature from another page, without fingerprint/face/PIN, or altered", async () => {
    for (const [opts, message] of [
      [{ origin: "https://evil.example" }, /unexpected page/],
      [{ flags: 0x01 }, /not verified/],
      [{ tamper: true }, /does not verify/],
    ] as const) {
      const held = await heldBrandC(r);
      const ask = await call(r, `vouches/${held.vouch_id}/approve`);
      const res = await call(r, `vouches/${held.vouch_id}/approve`, "POST", { passkey: auth.sign(ask.body, opts) });
      assert.equal(res.status, 401, JSON.stringify(opts));
      assert.match(res.body.error, message);
    }
  });

  it("narrowing needs nothing: a dispute, a pause, a lower limit", async () => {
    const bought = await r.service.proposePurchase({
      mandate_id: "m_detergent",
      product_id: "detergent-brand-a",
      brand: "Brand A",
      quantity: 1,
      confidence: 0.95,
      reason: ["restock"],
    });
    assert.equal((await call(r, `vouches/${bought.vouch.vouch_id}/dispute`, "POST", { reason: "no" })).status, 200);
    assert.equal((await call(r, "mandates/m_detergent", "PATCH", { constraints: { max_price: 12, preferred_brand: "Brand A", fallback_brand: "Brand B" } })).status, 200);
  });

  it("raising a limit needs the passkey", async () => {
    const body = { constraints: { max_price: 30, preferred_brand: "Brand A", fallback_brand: "Brand B" } };
    const ask = await call(r, "mandates/m_detergent", "PATCH", body);
    assert.equal(ask.status, 401);
    const ok = await call(r, "mandates/m_detergent", "PATCH", { ...body, passkey: auth.sign(ask.body) });
    assert.equal(ok.status, 200, JSON.stringify(ok.body));
    assert.equal(r.service.getMandate("m_detergent")?.constraints.max_price, 30);
  });
});

describe("passkeys: handing an item over to the agent", () => {
  let r: Rig;
  const auth = new SoftwareAuthenticator();
  before(async () => {
    r = await rig();
    r.agent.setUpDemo();
    await registerPasskey(r, auth);
  });
  after(() => r.close());

  it("moving coffee to Auto needs the passkey; moving it back does not", async () => {
    const ask = await call(r, "items/coffee/mode", "POST", { mode: "auto" });
    assert.equal(ask.status, 401);
    assert.match(ask.body.description, /buy coffee on its own/);
    const ok = await call(r, "items/coffee/mode", "POST", { mode: "auto", passkey: auth.sign(ask.body) });
    assert.equal(ok.status, 200, JSON.stringify(ok.body));
    assert.equal(ok.body.autonomy.mode, "auto");

    const back = await call(r, "items/coffee/mode", "POST", { mode: "ask" });
    assert.equal(back.status, 200, "taking authority back never needs proof");
  });

  it("weekend deliveries only is a preference, not authority — no passkey", async () => {
    assert.equal((await call(r, "items/dog-food/mode", "POST", { delivery_days: [0, 6] })).status, 200);
  });
});

describe("the tamper-evident record", () => {
  // A file database, so the test can reach past the application and edit
  // rows directly — the way someone with access to the disk could.
  const path = join(mkdtempSync(join(tmpdir(), "vouch-record-")), "record.db");
  let r: Rig;
  const auth = new SoftwareAuthenticator();
  let approvedId = "";
  before(async () => {
    r = await rig(path);
    await registerPasskey(r, auth);
    // Some history, then a passkey approval that anchors it.
    await r.service.proposePurchase({ mandate_id: "m_detergent", product_id: "detergent-brand-a", brand: "Brand A", quantity: 1, confidence: 0.95, reason: ["restock"] });
    const held = await heldBrandC(r);
    const ask = await call(r, `vouches/${held.vouch_id}/approve`);
    const ok = await call(r, `vouches/${held.vouch_id}/approve`, "POST", { passkey: auth.sign(ask.body) });
    assert.equal(ok.status, 200);
    approvedId = held.vouch_id;
  });
  after(() => r.close());

  it("verifies end to end: the chain, every Vouch, and the passkey approval", async () => {
    const report = await call(r, "record", "GET");
    assert.equal(report.body.ok, true, JSON.stringify(report.body.problems));
    assert.equal(report.body.approvals_checked, 1);
    assert.equal(report.body.entries, 3, "every write of a Vouch is an entry: bought, held, then approved");
  });

  it("the approval re-verifies from the record and the public key alone", () => {
    const vouch = r.service.listVouches({ limit: 50 }).find((v) => v.vouch_id === approvedId)!;
    const key = (r.store.listPasskeys() as StoredPasskey[])[0]!;
    const a = vouch.household_approval!;
    assert.deepEqual(verifyApproval(key, { ...a, nonce: a.nonce! }), { ok: true });
    // Change one character of what was approved and it no longer holds.
    const forged = { ...a, nonce: a.nonce!, action: a.action.replace(approvedId, "vouch_someone_else") };
    assert.equal(verifyApproval(key, forged).ok, false);
  });

  it("catches a price edited straight in the table the console reads", async () => {
    const bought = r.service.listVouches({ limit: 50 }).find((v) => v.decision.product.includes("Brand A"))!;
    r.service.tamperForDemo(bought.vouch_id, 1.99);
    const report = await call(r, "record", "GET");
    assert.equal(report.body.ok, false);
    assert.ok(
      report.body.problems.some((p: any) => p.vouch_id === bought.vouch_id && /no longer matches/.test(p.problem)),
      JSON.stringify(report.body.problems)
    );
  });

  it("catches a whole-ledger rewrite that is internally consistent — through the passkey's anchor", async () => {
    // The hard case: edit the FIRST entry's price, then recompute every hash
    // after it and fix the table to match. The chain alone now checks out.
    // What cannot be recomputed is the chain head the household SIGNED.
    const raw = new DatabaseSync(path);
    const rows = raw.prepare("SELECT seq, vouch_id, doc FROM ledger ORDER BY seq").all() as { seq: number; vouch_id: string; doc: string }[];
    let prev = LEDGER_GENESIS;
    for (const row of rows) {
      const snapshot = JSON.parse(row.doc);
      if (row.seq === 1) snapshot.decision.price = 0.99;
      const hash = ledgerHash(prev, row.seq, row.vouch_id, snapshot);
      raw.prepare("UPDATE ledger SET prev_hash = ?, hash = ?, doc = ? WHERE seq = ?").run(prev, hash, canonicalJson(snapshot), row.seq);
      raw.prepare("UPDATE vouches SET doc = ? WHERE vouch_id = ?").run(JSON.stringify(snapshot), row.vouch_id);
      prev = hash;
    }
    raw.close();

    assert.equal(r.store.verifyLedger().ok, true, "a careful rewrite does pass the chain check on its own");
    const report = await call(r, "record", "GET");
    assert.equal(report.body.ok, false, "but not the household's signed anchor");
    assert.ok(report.body.problems.some((p: any) => /rewritten after the household approved/.test(p.problem)), JSON.stringify(report.body.problems));
  });
});

describe("the guard itself", () => {
  it("refuses an expired challenge, and a counter that goes backwards", async () => {
    const store = VouchStore.open(":memory:");
    let now = 1_000_000;
    const guard = new PasskeyGuard({ store, rpId: RP_ID, origins: [ORIGIN], now: () => now });
    const auth = new SoftwareAuthenticator();
    guard.register(auth.register(guard.registrationOptions()));
    const action = { kind: "approve_purchase" as const, vouch_id: "v1", chain_head: null };

    const stale = guard.actionChallenge(action, "Approve v1");
    now += 3 * 60_000;
    assert.throws(() => guard.verify(action, auth.sign(stale)), /expired/);

    guard.verify(action, auth.sign(guard.actionChallenge(action, "Approve v1")));
    auth.counter = 0; // a clone replaying an old counter
    assert.throws(() => guard.verify(action, auth.sign(guard.actionChallenge(action, "Approve v1"))), /counter went backwards/);
    store.close();
  });
});
