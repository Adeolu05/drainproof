// Locking the vault: removing every access key of the vault account, so that the contract
// code can never be replaced and nobody can sign as the vault account again. Shared by
// lock-vault.mjs (testnet) and the sandbox tests, so both run exactly the same checks.
//
// After locking, the owner still gets funds out through the contract's own `withdraw` method
// (signed by the owner's account, which is a different account). What is lost for good is any
// redeploy or upgrade of the contract, and any action signed by the vault account itself.
import { createHash } from "node:crypto";
import { PublicKey, actions, baseEncode } from "near-api-js";

/** NEAR's code hash: base58 of the SHA-256 of the wasm bytes. */
export function codeHashOf(wasm) {
  return baseEncode(createHash("sha256").update(wasm).digest());
}

const isFullAccess = (key) => key.access_key.permission === "FullAccess";

async function accessKeys(provider, accountId) {
  const list = await provider.viewAccessKeyList({ accountId, finalityQuery: { finality: "final" } });
  return list.keys;
}

/**
 * Reads everything the lock depends on and decides whether it is safe. Returns
 * { ok, problems, facts, keysToDelete }. Nothing is signed here.
 *
 * Safe means: the deployed code is exactly the local build of contracts/vault; the vault
 * reports an owner that is a different account; that owner account exists and holds a
 * full-access key (owner calls attach 1 yoctoNEAR, which needs one), so it can still call
 * `withdraw`; and the key that will sign the lock is a full-access key of the vault account.
 */
export async function inspectForLock({ provider, vaultId, signerPublicKey, wasm }) {
  const problems = [];
  const facts = {};

  const vault = await provider.viewAccount({ accountId: vaultId });
  facts.codeHashOnChain = vault.code_hash;
  facts.codeHashLocal = codeHashOf(wasm);
  facts.vaultBalance = BigInt(vault.amount);
  if (facts.codeHashOnChain !== facts.codeHashLocal) {
    problems.push(
      `the deployed code (${facts.codeHashOnChain}) is not the local build of contracts/vault (${facts.codeHashLocal}). Locking would freeze code that was not checked`,
    );
  }

  let config;
  try {
    config = await provider.callFunction({ contractId: vaultId, method: "get_config", args: {} });
  } catch (err) {
    problems.push(`could not read the vault's configuration: ${err.message}`);
  }
  if (config) {
    facts.ownerId = config.owner_id;
    facts.paused = config.paused;
    if (config.owner_id === vaultId) {
      problems.push("the vault's owner is the vault account itself; after locking nobody could call withdraw");
    } else {
      let ownerKeys = [];
      try {
        ownerKeys = await accessKeys(provider, config.owner_id);
      } catch (err) {
        problems.push(`could not read the owner account ${config.owner_id}: ${err.message}`);
      }
      facts.ownerFullAccessKeys = ownerKeys.filter(isFullAccess).length;
      if (facts.ownerFullAccessKeys === 0) {
        problems.push(`the owner ${config.owner_id} has no full-access key, so it could not call withdraw (owner calls attach 1 yoctoNEAR)`);
      }
    }
    try {
      const policy = await provider.callFunction({ contractId: vaultId, method: "get_policy", args: {} });
      facts.missingRecipients = [];
      for (const id of policy.allowed_recipients) {
        try {
          await provider.viewAccount({ accountId: id });
        } catch {
          facts.missingRecipients.push(id);
        }
      }
    } catch (err) {
      problems.push(`could not read the vault's policy: ${err.message}`);
    }
    try {
      facts.availableBalance = BigInt(await provider.callFunction({ contractId: vaultId, method: "available_balance", args: {} }));
    } catch (err) {
      problems.push(`could not read available_balance: ${err.message}`);
    }
  }

  const keys = await accessKeys(provider, vaultId);
  facts.vaultKeys = keys.map((k) => ({ publicKey: k.public_key, fullAccess: isFullAccess(k) }));
  const signer = keys.find((k) => k.public_key === signerPublicKey);
  if (!signer) problems.push(`the signing key ${signerPublicKey} is not an access key of ${vaultId}`);
  else if (!isFullAccess(signer)) problems.push(`the signing key ${signerPublicKey} is not a full-access key of ${vaultId}`);
  if (keys.length === 0) problems.push(`${vaultId} has no access keys: it is already locked`);

  // Every key goes, function-call keys included: a function-call key on the vault account
  // could call the contract with the vault as predecessor (for example its #[private]
  // callback). The signing key is deleted last, in the same transaction.
  const keysToDelete = [
    ...keys.filter((k) => k.public_key !== signerPublicKey).map((k) => k.public_key),
    ...(signer ? [signer.public_key] : []),
  ];
  return { ok: problems.length === 0, problems, facts, keysToDelete };
}

/** The DeleteKey actions of the lock transaction, signed by the vault account. */
export function lockActions(keysToDelete) {
  return keysToDelete.map((publicKey) => actions.deleteKey(PublicKey.fromString(publicKey)));
}

/** After the lock: the vault account must have no access key left, and the same code. */
export async function verifyLocked({ provider, vaultId, wasm }) {
  const keys = await accessKeys(provider, vaultId);
  const vault = await provider.viewAccount({ accountId: vaultId });
  return {
    keysLeft: keys.length,
    fullAccessKeysLeft: keys.filter(isFullAccess).length,
    codeHashOnChain: vault.code_hash,
    codeUnchanged: vault.code_hash === codeHashOf(wasm),
  };
}
