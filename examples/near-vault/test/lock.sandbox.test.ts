/**
 * Locking the vault (lib/lock.mjs, used by lock-vault.mjs) against a real local NEAR node:
 * the checks refuse unsafe locks, the lock leaves the vault account with no access keys, the
 * owner still withdraws through the contract afterwards, the agent still pays through it, and
 * nothing can redeploy the contract any more.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { KeyPair, NEAR, Account, actions, loadWasm, startVault } from "../lib/sandbox.mjs";
import { codeHashOf, inspectForLock, lockActions, verifyLocked } from "../lib/lock.mjs";

type Vault = Awaited<ReturnType<typeof startVault>>;

describe("locking the vault", () => {
  let v: Vault;
  let wasm: Buffer;
  beforeAll(async () => {
    wasm = await loadWasm();
    v = await startVault({ vaultBalance: 10n * NEAR });
  });
  afterAll(() => v?.stop());

  const inspect = (overrides: { signerPublicKey?: string; wasm?: Buffer } = {}) =>
    inspectForLock({
      provider: v.provider,
      vaultId: v.ids.vault,
      signerPublicKey: overrides.signerPublicKey ?? v.publicKeyOf(v.ids.vault),
      wasm: overrides.wasm ?? wasm,
    });

  it("refuses when the deployed code is not the local build", async () => {
    const plan = await inspect({ wasm: Buffer.from("not the vault") });
    expect(plan.ok).toBe(false);
    expect(plan.problems.join(" ")).toMatch(/is not the local build of contracts\/vault/);
  });

  it("refuses when the signing key is not a full-access key of the vault account", async () => {
    const plan = await inspect({ signerPublicKey: KeyPair.fromRandom("ed25519").getPublicKey().toString() });
    expect(plan.ok).toBe(false);
    expect(plan.problems.join(" ")).toMatch(/is not an access key of vault\.sandbox/);
  });

  it("passes every check on the deployed vault and plans to delete every key", async () => {
    const plan = await inspect();
    expect(plan.problems).toEqual([]);
    expect(plan.facts.codeHashOnChain).toBe(codeHashOf(wasm));
    expect(plan.facts.ownerId).toBe(v.ids.owner);
    expect(plan.facts.ownerFullAccessKeys).toBeGreaterThan(0);
    expect(plan.keysToDelete).toEqual([v.publicKeyOf(v.ids.vault)]);
  });

  it("locks: the vault account has no access keys left and the code is unchanged", async () => {
    const plan = await inspect();
    const tx = await v.vaultAccount.signAndSendTransaction({
      receiverId: v.ids.vault,
      actions: lockActions(plan.keysToDelete),
      waitUntil: "FINAL",
      throwOnFailure: false,
    });
    expect(JSON.stringify(tx.status)).not.toMatch(/Failure/);
    expect(await verifyLocked({ provider: v.provider, vaultId: v.ids.vault, wasm })).toEqual({
      keysLeft: 0,
      fullAccessKeysLeft: 0,
      codeHashOnChain: codeHashOf(wasm),
      codeUnchanged: true,
    });
    const again = await inspect();
    expect(again.ok).toBe(false);
    expect(again.problems.join(" ")).toMatch(/already locked/);
  });

  it("after locking, the owner withdraws through the contract", async () => {
    const amount = NEAR;
    const vaultBefore = await v.balance(v.ids.vault);
    const ownerBefore = await v.balance(v.ids.owner);
    const r = await v.ownerCall("withdraw", { amount: amount.toString() });
    expect(r.failure).toBeUndefined();
    expect(r.events.map((e: { event: string }) => e.event)).toContain("withdrawn");
    const vaultAfter = await v.balance(v.ids.vault);
    const ownerAfter = await v.balance(v.ids.owner);
    // The vault pays the amount; it also receives the 1 yoctoNEAR deposit and a share of the
    // call's gas fees as the contract's reward, so allow a small margin.
    expect(vaultBefore - vaultAfter).toBeGreaterThan(amount - NEAR / 100n);
    expect(vaultBefore - vaultAfter).toBeLessThanOrEqual(amount);
    expect(ownerAfter - ownerBefore).toBeGreaterThan(amount - NEAR / 100n); // amount minus the owner's gas
  });

  it("after locking, the agent still pays an allowlisted recipient through the contract", async () => {
    const before = await v.balance("shop.sandbox");
    const r = await v.requestPayment({ request_id: "after-lock", recipient_id: "shop.sandbox", amount: (NEAR / 10n).toString() });
    expect(r.value).toMatchObject({ decision: "ALLOW" });
    expect((await v.balance("shop.sandbox")) - before).toBe(NEAR / 10n);
  });

  it("after locking, nothing can redeploy the contract or sign as the vault account", async () => {
    // The vault's former full-access key no longer exists, so the protocol rejects the transaction.
    await expect(
      v.vaultAccount.signAndSendTransaction({ receiverId: v.ids.vault, actions: [actions.deployContract(Buffer.from(wasm))], waitUntil: "FINAL" }),
    ).rejects.toThrow(/access key|does not exist|not found/i);
    // Nor can any other key: the vault account has none.
    const stranger = new Account(v.ids.vault, v.provider, KeyPair.fromRandom("ed25519").toString());
    await expect(
      stranger.signAndSendTransaction({ receiverId: v.ids.vault, actions: [actions.deployContract(Buffer.from(wasm))], waitUntil: "FINAL" }),
    ).rejects.toThrow(/access key|does not exist|not found/i);
    // The owner's key belongs to another account: a DeployContract it signs can only target
    // the owner's own account, never the vault.
    const byOwner = await v.owner.signAndSendTransaction({
      receiverId: v.ids.vault,
      actions: [actions.deployContract(Buffer.from(wasm))],
      waitUntil: "FINAL",
      throwOnFailure: false,
    });
    expect(JSON.stringify(byOwner.status)).toMatch(/ActorNoPermission/);
    expect((await verifyLocked({ provider: v.provider, vaultId: v.ids.vault, wasm })).codeUnchanged).toBe(true);
  });
});
