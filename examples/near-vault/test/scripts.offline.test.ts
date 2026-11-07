/**
 * Offline checks of the vault's testnet scripts: refusals that must happen before anything
 * connects to a network. Part of `pnpm test` (no NEAR node, no network, no key).
 */
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadVaultPolicy } from "../lib/policy.mjs";

const run = promisify(execFile);
const DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const OFFLINE = { ...process.env, DRAINPROOF_NEAR_EXECUTION: "", NEAR_TESTNET_PRIVATE_KEY: "", NEAR_TESTNET_ACCOUNT_ID: "" };

async function script(file: string, args: string[], env: Record<string, string>) {
  return run(process.execPath, [path.join(DIR, file), ...args], { env: { ...OFFLINE, ...env } }).then(
    (r) => ({ code: 0, out: r.stdout + r.stderr }),
    (e: { code: number; stdout: string; stderr: string }) => ({ code: e.code, out: e.stdout + e.stderr }),
  );
}

let tmp: string;
beforeAll(async () => {
  tmp = await mkdtemp(path.join(os.tmpdir(), "drainproof-vault-scripts-"));
});
afterAll(async () => {
  await rm(tmp, { recursive: true, force: true });
});

describe("vault testnet scripts, offline refusals", () => {
  it("add-agent-key refuses to generate (and print) a private key when output is not a terminal", async () => {
    const r = await script("add-agent-key.mjs", [], { DRAINPROOF_VAULT_ACCOUNT_ID: "vault.someone.testnet", DRAINPROOF_AGENT_PUBLIC_KEY: "" });
    expect(r.code).toBe(2);
    expect(r.out).toMatch(/not a terminal/);
    expect(r.out).toMatch(/Nothing was signed or sent/);
    expect(r.out).not.toMatch(/ed25519:[1-9A-HJ-NP-Za-km-z]{40,}/);
  });

  it("lock-vault refuses unknown arguments before connecting", async () => {
    const r = await script("lock-vault.mjs", ["--yes"], {});
    expect(r.code).toBe(2);
    expect(r.out).toMatch(/unknown argument\(s\): --yes/);
  });

  it("lock-vault refuses without the testnet opt-in", async () => {
    const r = await script("lock-vault.mjs", [], { DRAINPROOF_VAULT_ACCOUNT_ID: "vault.someone.testnet" });
    expect(r.code).toBe(2);
    expect(r.out).toMatch(/testnet execution is disabled|wasm not found/);
  });

  it("the vault policy loader accepts the repository's policy and refuses recipients that are not testnet accounts", async () => {
    await expect(loadVaultPolicy()).resolves.toMatchObject({ vaultPolicy: { allowed_recipients: ["merchant-example.testnet", "data-provider-example.testnet"] } });
    const yaml = (await readFile(path.join(DIR, "policy.yaml"), "utf8")).replace("    - data-provider-example.testnet", "    - data-provider-example.testnet\n    - shop");
    const file = path.join(tmp, "policy.yaml");
    await writeFile(file, yaml);
    await expect(loadVaultPolicy(file)).rejects.toThrow(/recipients\.allowed must be testnet accounts:\n {2}- shop:/);
  });
});
