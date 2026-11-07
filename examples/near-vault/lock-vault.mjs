// Locks the vault on NEAR TESTNET: deletes every access key of the vault account, so the
// contract can never be redeployed or upgraded and nobody can sign as the vault account.
// The owner still withdraws through the contract's own `withdraw` method. IRREVERSIBLE.
//
//   node lock-vault.mjs            dry run: runs every check and prints what would be deleted
//   node lock-vault.mjs --lock     locks, with these variables:
//     DRAINPROOF_NEAR_EXECUTION=testnet
//     NEAR_TESTNET_ACCOUNT_ID=vault.<owner>.testnet   the VAULT account (it signs its own DeleteKey actions)
//     NEAR_TESTNET_PRIVATE_KEY=ed25519:...            a full-access key of the vault account
//     DRAINPROOF_VAULT_ACCOUNT_ID=vault.<owner>.testnet
//     DRAINPROOF_CONFIRM_LOCK=vault.<owner>.testnet   must repeat the vault account, to confirm
//
// It refuses unless: the opt-in is set and the RPC reports "testnet"; every account is a
// testnet account; the signer is the vault account; the deployed code hash equals the local
// build of contracts/vault (pnpm build:vault); the vault's owner is another account that
// holds a full-access key (so it can still call withdraw); and the signing key is a
// full-access key of the vault. Afterwards it checks that the vault account has no keys left.
import { loadWasm } from "./lib/wasm.mjs";
import { inspectForLock, lockActions, verifyLocked } from "./lib/lock.mjs";
import { Refusal, connectTestnet, printOutcome, runScript, send, testnetAccountFromEnv } from "./lib/testnet.mjs";

const fmt = (yocto) => (yocto === undefined ? "unknown" : `${yocto} yoctoNEAR`);

await runScript(async () => {
  const args = process.argv.slice(2);
  const unknown = args.filter((a) => a !== "--lock");
  if (unknown.length) throw new Refusal(`unknown argument(s): ${unknown.join(" ")}`);
  const lock = args.includes("--lock");

  const vaultId = testnetAccountFromEnv("DRAINPROOF_VAULT_ACCOUNT_ID");
  let wasm;
  try {
    wasm = await loadWasm();
  } catch (err) {
    throw new Refusal(err.message);
  }
  const vault = await connectTestnet();
  if (vault.signerId !== vaultId) {
    throw new Refusal(`NEAR_TESTNET_ACCOUNT_ID must be the vault account ${vaultId} (only it can delete its own keys), not ${vault.signerId}`);
  }

  const plan = await inspectForLock({ provider: vault.provider, vaultId, signerPublicKey: vault.publicKey.toString(), wasm });
  const f = plan.facts;
  console.log(`Vault:              ${vaultId} (RPC ${vault.rpcUrl}, chain id testnet)`);
  console.log(`Deployed code hash: ${f.codeHashOnChain}`);
  console.log(`Local build hash:   ${f.codeHashLocal} (contracts/vault, pnpm build:vault)`);
  console.log(`Owner:              ${f.ownerId ?? "unknown"} (${f.ownerFullAccessKeys ?? 0} full-access key(s), so it can call withdraw)`);
  console.log(`Paused:             ${f.paused}`);
  console.log(`Available to withdraw through the contract: ${fmt(f.availableBalance)}`);
  console.log(`Access keys of the vault account (${f.vaultKeys.length}):`);
  for (const k of f.vaultKeys) console.log(`  ${k.publicKey}  ${k.fullAccess ? "full access" : "function call"}`);
  if (f.missingRecipients?.length) {
    console.log(`\nWarning: allowlisted recipients that do not exist on testnet: ${f.missingRecipients.join(", ")}.`);
    console.log("Anyone could create them and receive the vault's payments. The owner can remove them with push-policy.mjs, before or after locking.");
  }
  if (!plan.ok) throw new Refusal(`cannot lock safely:\n  - ${plan.problems.join("\n  - ")}`);

  console.log(`\nThe lock deletes all ${plan.keysToDelete.length} key(s) above in one transaction signed by ${vaultId}.`);
  console.log("After it, nobody can redeploy or upgrade the contract or sign as the vault account. This cannot be undone.");
  console.log(`The owner withdraws through the contract: withdraw, signed by ${f.ownerId} with 1 yoctoNEAR attached.`);
  if (!lock) {
    console.log("\nDry run: every check passed and nothing was signed or sent. Add --lock (and DRAINPROOF_CONFIRM_LOCK) to lock.");
    return;
  }
  if (process.env.DRAINPROOF_CONFIRM_LOCK !== vaultId) {
    throw new Refusal(`set DRAINPROOF_CONFIRM_LOCK=${vaultId} to confirm the lock`);
  }

  const r = await send(vault.account, vaultId, lockActions(plan.keysToDelete));
  printOutcome("\nLock (delete every access key of the vault account)", r);
  if (r.failure) process.exit(1);

  const after = await verifyLocked({ provider: vault.provider, vaultId, wasm });
  console.log(`\nAccess keys left on ${vaultId}: ${after.keysLeft} (full access: ${after.fullAccessKeysLeft})`);
  console.log(`Code hash: ${after.codeHashOnChain} (${after.codeUnchanged ? "unchanged" : "CHANGED"})`);
  const locked = after.keysLeft === 0 && after.codeUnchanged;
  console.log(locked ? "Verified: the vault is locked." : "NOT LOCKED as expected. Check the account.");
  if (!locked) process.exit(1);
});
