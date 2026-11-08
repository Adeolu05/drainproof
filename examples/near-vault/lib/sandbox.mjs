// Local NEAR sandbox harness for the Drainproof Vault.
//
// Everything here runs against a NEAR node on 127.0.0.1 started by the official
// `near-sandbox` package (nearcore sandbox 2.14.0). Nothing touches testnet or mainnet.
// Every key is generated at runtime with KeyPair.fromRandom and lives only in memory.
import { rm } from "node:fs/promises";
import { GenesisAccount, Sandbox } from "near-sandbox";
import { Account, JsonRpcProvider, KeyPair, actions } from "near-api-js";
import { decodeReturn, eventsOf, failureMessage, gasBurnt } from "./outcome.mjs";
import { loadWasm } from "./wasm.mjs";

export { Account, KeyPair, actions };
export { eventsOf, failureMessage, gasBurnt, logsOf } from "./outcome.mjs";
export { WASM_PATH, loadWasm } from "./wasm.mjs";

export const NEAR = 10n ** 24n;
export const TGAS = 10n ** 12n;
/** The default test policy, as the contract's JSON `VaultPolicy`. Amounts are yoctoNEAR strings. */
/**
 * Stops a sandbox node without hanging. near-sandbox 0.3.5's tearDown() sends SIGTERM and then
 * waits for the process's "exit" event with no time limit: if the node is slow to shut down,
 * or has already exited, that wait never ends. Here the node gets `graceMs` to stop, then
 * SIGKILL; a node that already exited only has its data directory removed.
 */
export async function stopSandbox(sandbox, graceMs = 20_000) {
  const child = sandbox.childProcess;
  if (child.exitCode !== null || child.signalCode !== null) {
    await rm(sandbox.homeDir, { recursive: true, force: true });
    return;
  }
  const done = sandbox.tearDown();
  let timer;
  const timedOut = new Promise((resolve) => {
    timer = setTimeout(resolve, graceMs, "timeout");
  });
  const first = await Promise.race([done.then(() => "done"), timedOut]);
  clearTimeout(timer);
  if (first === "timeout") {
    child.kill("SIGKILL");
    await Promise.race([done, new Promise((resolve) => setTimeout(resolve, 10_000))]);
    await rm(sandbox.homeDir, { recursive: true, force: true });
  }
}

export function testPolicy(recipients, overrides = {}) {
  return {
    max_transaction: (NEAR / 2n).toString(),
    max_daily_spend: (2n * NEAR).toString(),
    max_daily_count: 10,
    approval_required_above: (NEAR / 4n).toString(),
    recipient_mode: "allowlist",
    allowed_recipients: recipients,
    daily_window_utc_offset_minutes: 0,
    allow_zero_amount: false,
    approval_ttl_seconds: 900,
    policy_hash: "sha256:sandbox-test",
    ...overrides,
  };
}

/**
 * Starts a sandbox with an owner, an agent, a vault and the given recipient accounts,
 * deploys and initialises the vault, and gives the agent a function-call key limited to
 * the vault's `request_payment` method.
 */
export async function startVault({
  policy,
  recipients = ["shop.sandbox", "data.sandbox"],
  extraAccounts = [],
  vaultBalance = 50n * NEAR,
  agentAllowance = NEAR / 4n,
  wasm,
} = {}) {
  const code = wasm ?? (await loadWasm());
  const keys = new Map();
  const genesis = (id, balance) => {
    const kp = KeyPair.fromRandom("ed25519");
    keys.set(id, kp);
    return new GenesisAccount(id, kp.getPublicKey().toString(), kp.toString(), balance);
  };
  const ids = { owner: "owner.sandbox", agent: "agent.sandbox", vault: "vault.sandbox" };
  const sandbox = await Sandbox.start({
    config: {
      additionalAccounts: [
        genesis(ids.owner, 100n * NEAR),
        genesis(ids.agent, 5n * NEAR),
        genesis(ids.vault, vaultBalance),
        ...[...recipients, ...extraAccounts].map((id) => genesis(id, NEAR)),
      ],
    },
  });
  const provider = new JsonRpcProvider({ url: sandbox.rpcUrl });
  const fullAccess = (id) => new Account(id, provider, keys.get(id).toString());

  const vaultAccount = fullAccess(ids.vault);
  const owner = fullAccess(ids.owner);
  const agentFullAccess = fullAccess(ids.agent);

  // Deploy and initialise in one transaction signed by the vault account, so nobody can
  // call `new` in between.
  const deployTx = await vaultAccount.signAndSendTransaction({
    receiverId: ids.vault,
    actions: [
      actions.deployContract(code),
      actions.functionCall("new", { owner_id: ids.owner, agent_id: ids.agent, policy: policy ?? testPolicy(recipients) }, 100n * TGAS, 0n),
    ],
    waitUntil: "FINAL",
    throwOnFailure: false,
  });
  const deployFailure = failureMessage(deployTx);
  if (deployFailure) {
    await stopSandbox(sandbox);
    throw new Error(`vault deployment failed: ${deployFailure}`);
  }

  // The agent's runtime gets only this function-call key.
  const agentKey = KeyPair.fromRandom("ed25519");
  await agentFullAccess.signAndSendTransaction({
    receiverId: ids.agent,
    actions: [actions.addFunctionCallAccessKey(agentKey.getPublicKey(), ids.vault, ["request_payment"], agentAllowance)],
    waitUntil: "FINAL",
  });
  const agent = new Account(ids.agent, provider, agentKey.toString());

  /** Sends one function call to the vault and returns the parsed outcome (never throws on a contract panic). */
  async function call(account, method, args = {}, { deposit = 0n, gas = 100n * TGAS, receiverId = ids.vault } = {}) {
    const tx = await account.signAndSendTransaction({
      receiverId,
      actions: [actions.functionCall(method, args, gas, deposit)],
      waitUntil: "FINAL",
      throwOnFailure: false,
    });
    return { tx, value: decodeReturn(tx.status), failure: failureMessage(tx), events: eventsOf(tx), gasBurnt: gasBurnt(tx) };
  }

  const view = (method, args = {}) => provider.callFunction({ contractId: ids.vault, method, args });
  const balance = async (accountId) => BigInt((await provider.viewAccount({ accountId, finalityQuery: { finality: "final" } })).amount);

  return {
    sandbox,
    provider,
    ids,
    owner,
    agent,
    agentFullAccess,
    agentKey,
    vaultAccount,
    fullAccess,
    /** The public key of a genesis account's full-access key. */
    publicKeyOf: (id) => keys.get(id).getPublicKey().toString(),
    call,
    view,
    balance,
    /** request_payment, signed with the agent's function-call key. */
    requestPayment: (args, opts) => call(agent, "request_payment", args, opts),
    /** An owner call with the 1 yoctoNEAR the vault requires. */
    ownerCall: (method, args, opts = {}) => call(owner, method, args, { deposit: 1n, ...opts }),
    stop: () => stopSandbox(sandbox),
  };
}
