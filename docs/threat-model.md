# Threat model

## Scope

Drainproof evaluates **proposed** financial actions against an explicit policy, records authorised spending, and gates execution. It also tests that this behaviour, or the behaviour of a guard you wrote, matches a security specification (the scenarios). This document covers the engine, the ledger, approvals, the execution gate, the CLI and runner, reports, the dashboard, the NEAR adapter and the Drainproof Vault contract.

## Assets

| Asset | Where it lives |
| --- | --- |
| Signing material (wallet keys) | Outside Drainproof. Only the NEAR executor touches a key: a **testnet** key from the environment, kept inside a closure. |
| Approval signing key | The approval service. The engine holds a verifier. |
| API credentials and CI secrets | The CI secret store. Never read by scenarios or written to reports. |
| Policy configuration | YAML in the repository, under code review. |
| Approval records and ledger state | The ledger implementation. |
| Transaction integrity (amount, recipient, network, asset) | The proposal digest and the execution gate. |
| Test reports | `.drainproof/runs`, CI artifacts and the dashboard. |
| Developer repositories | CI with `contents: read` permissions only. |

## Threats and controls

| Threat | Control | Tested by |
| --- | --- | --- |
| A malicious or compromised agent proposes an over-limit payment | Deterministic limits on BigInt atomic amounts; no LLM in the decision | `tx-limit-*`, `daily-*`, engine property tests |
| Prompt injection or malicious tool output redirects a payment | Recipient, network and asset allowlists; `memo` is never interpreted; unknown fields are rejected | `instruction-injection-in-memo`, `unexpected-fields-rejected`; with an LLM agent and a poisoned page: `examples/llm-agent/test/llm-agent.test.ts` |
| The LLM demo leaks the NEAR AI API key | Read only from `NEAR_AI_API_KEY`, sent only in the `Authorization` header and only over https (or http on 127.0.0.1); redacted from output and errors; a recording that contains it is refused | `examples/llm-agent/test/llm-agent.test.ts` |
| Malformed or adversarial input (negative amounts, floats, exponents, huge strings, prototype keys) | Strict proposal validation, a 4 KiB size limit, plain-object checks, exact grammar | `adversarial-input/*`, amount property tests |
| Identity confusion (case, whitespace, zero-width characters, homoglyphs) | Printable-ASCII identifiers compared byte for byte; no normalisation | `recipient-normalisation` |
| Concurrent requests race past a shared budget | `Ledger.runExclusive`: check-and-reserve is atomic per agent | `concurrent-requests-respect-daily-limit`, plus an unlocked-ledger control experiment |
| Retries cause double accounting or double payment | Idempotency key bound to the proposal digest; atomic `reserved → submitted` gate | `duplicate-request-*`, `concurrent-duplicates-*`, `double-execution-prevented` |
| A replayed, forged, transferred, tampered or expired approval | HMAC over the digest, policy hash, issue and expiry times; lifetime cap; single use | `approval-*`, `forged-approval-rejected`, `changed-recipient-invalidates-approval` |
| `REQUIRE_APPROVAL` mistaken for an authorisation | Nothing is reserved; the execution gate has no reservation to execute | `approval-required-does-not-authorise` |
| A stale policy authorises a transaction after a change | Reservations and approvals record the policy hash; the gate and the verifier reject mismatches | `stale-policy-cannot-execute`, approval policy-mismatch tests |
| Ledger unavailable, or unexpected errors | Fail closed: `BLOCK` with `LEDGER_UNAVAILABLE` or `EVALUATION_ERROR` | `ledger-unavailable-fails-closed`, engine tests |
| Ambiguous provider result (timeout, lost response) treated as success or failure | The reservation stays `submitted` and keeps counting; a hash is recorded only from a network response | `ambiguous-submission-keeps-counting`, NEAR executor tests |
| A developer misconfigures the policy | Strict schema; an empty allowlist means "no one", never "everyone"; warnings for unreachable thresholds; CI fails on loosened limits | policy tests, `regression-gate` CI job |
| A malicious or incorrect custom target or adapter | Results are shape-checked; exceptions and timeouts become `ERROR`; all-skipped runs are incomplete; reports are redacted | runner tests |
| Wrong-network execution (mainnet) | Adapter executes only `near-testnet` and `NEAR`; requires the RPC to report `testnet` and a testnet signer; rejects mainnet-looking RPC URLs | NEAR tests |
| In-process tampering: getters or proxies on proposals or grants, or mutating returned records | JSON snapshots read each field once; reservations and policy objects are deeply frozen; malformed ledger results fail closed | `packages/core/test/regressions.test.ts` |
| An unrelated transaction hash used to settle (or release) a reservation | The executor stores the network hash on a pending reservation; `reconcile` accepts only that hash, or, when none was stored, a transaction matching the signer, receiver and exact amount | NEAR tests |
| Secrets leaking into reports or logs | Key- and pattern-based redaction (applied before values are turned into strings) plus exact-match redaction of secret environment values | redaction tests, runner regressions |
| Dashboard misuse | Read-only; route parameters checked against strict patterns (no path traversal); every report schema-validated; security headers | data-layer tests |
| Compromised dependency | Lockfile and frozen installs in CI; actions pinned to commit SHAs; small dependency set | CI configuration |

## Drainproof Vault (on-chain)

The vault (`contracts/vault`) holds the funds; the agent holds only a function-call key for `request_payment`. Its full design is in [vault-design.md](vault-design.md). Unit tests are in `contracts/vault/src/tests.rs`; sandbox tests, against a real local NEAR node, are in `examples/near-vault/test/vault.sandbox.test.ts`.

| Threat | Control | Tested by |
| --- | --- | --- |
| A compromised agent key transfers NEAR, adds keys, or calls owner methods | The NEAR protocol limits a function-call key to one receiver and the listed methods, with no deposit; owner methods also check the caller and require exactly 1 yoctoNEAR | Sandbox: "what the agent's function-call key cannot do" |
| A compromised agent pays an unknown recipient, or more than the limits | The contract enforces the allowlist, the per-transaction, daily spend and daily count limits, and the approval threshold itself | Unit tests; sandbox "payments and blocks"; 16 built-in scenarios run against the contract |
| Double payment through retries or concurrent duplicates | The idempotency key is checked and recorded in the same call that reserves budget and schedules the transfer | Unit tests; sandbox "concurrent duplicates signed with five different agent keys pay exactly once" |
| Someone other than the vault calls the settlement callback | `#[private]` callback | Sandbox: "other accounts cannot request payments, call the callback or re-initialise" |
| A compromised agent jams the approval queue with requests nobody approves | At most `MAX_PENDING` (50) requests wait at once. An expired request can never be approved, so it never keeps its slot: when the queue is full, a new request that needs approval first removes one expired request. The owner's `clear_expired` removes every expired request in one call (50 at most; measured on a local node: 32.97 TGas and 13,108 bytes of logs, against limits of 300 TGas and 16,384 bytes). Requests that have not expired can still fill the queue for up to the approval period; the owner can reject them, pause the vault or replace the agent with `set_agent`. | Unit: `a_full_queue_frees_one_expired_slot_for_a_new_request`, `clear_expired_removes_every_expired_request_in_one_call`, `clear_expired_is_owner_only`, `clear_expired_requires_one_yocto`, `worst_case_pending_expired_event_fits_the_log_limit`; sandbox: "expired requests cannot jam the approval queue" |
| Storage exhaustion: requests that lock the vault's balance as storage stake | Blocked requests are never stored. At most 50 pending requests exist at once, and expired ones are deleted (they were never paid, so their keys cannot be paid twice). Submitted and paid requests are bounded per day by `max_daily_count`. Rejected requests need an owner transaction each. | Unit tests above; `pending_requests_are_capped` |
| The agent key's gas allowance runs out (payments halt) | Funds are not at risk. The owner adds a new function-call key with the agent account's full-access key, or points the vault at a new agent with `set_agent` | Sandbox: "set_agent revokes the old agent's key" |
| An allowlisted recipient does not exist, and someone creates it to receive the vault's payments | `deploy.mjs` and `push-policy.mjs` refuse recipients that do not exist on-chain; `lock-vault.mjs` warns about them | Rehearsal against a local node (deploy and push refused, lock warns); `test/scripts.offline.test.ts` for non-testnet names |
| Failed transfers leave records that grow storage without a daily bound (known limitation, not fixed in the contract) | **Who can trigger it:** only the agent's key, and only if the policy allowlists a recipient account that does not exist (a transfer to it fails, the vault gives back the amount and the daily count, and keeps the `Failed` record). **What bounds it:** every call costs the agent key's gas allowance (about 0.00044 NEAR per call, so roughly 565 calls with the default 0.25 NEAR), and each record locks 112 to 362 bytes of the vault's balance as storage stake (0.0011 to 0.0036 NEAR), so at most about 0.6 to 2 NEAR per allowance. The owner stops it at any time with `pause`, `set_policy` (remove the recipient) or `set_agent`. **Why it is low:** no NEAR leaves the vault and nobody gains anything; the worst case is that part of the vault's balance stays locked as storage (permanently, since records are never deleted) and payments stop with `INSUFFICIENT_VAULT_BALANCE`. It needs a policy mistake and a compromised agent at the same time, and the scripts now refuse the mistake: `deploy.mjs` and `push-policy.mjs` reject recipients that do not exist, and `lock-vault.mjs` warns about them | Script refusals: the local-node rehearsal. The contract behaviour itself is described in vault-design.md, Known limitations |
| A policy change that moves `daily_window_utc_offset_minutes` resets the daily counters (known limitation, not fixed in the contract) | **Who can trigger it:** only the owner, with `set_policy` (owner account, 1 yoctoNEAR attached). The agent cannot. **What bounds it:** each offset change can add at most about two extra days' budget (`max_daily_spend` and `max_daily_count`) within a few hours, and every payment still goes only to an allowlisted recipient, within `max_transaction_amount`. **Why it is low:** the owner can already raise the limits or withdraw everything directly, so this gives the owner nothing new; the risk is an honest policy change that only moves the time zone and quietly widens one day's budget. Every change emits a `policy_updated` event, and in this repository policy files change only through reviewed pull requests | Described in vault-design.md, Known limitations |
| The deployer bypasses the contract with the vault account's full-access key | Optional `lock-vault.mjs` deletes every key of the vault account after checking the code hash and the owner's ability to withdraw | Sandbox: `test/lock.sandbox.test.ts` (lock, owner withdraws, agent pays, no redeploy possible) |

Residual risk: a compromised agent can still make every payment the policy allows, up to `max_daily_spend` per day, and the owner's full-access key keeps full control. The vault account's full-access key does too, unless the vault has been locked with `lock-vault.mjs`.

## Review

An independent adversarial review (November 2026) tried to break these guarantees and confirmed 7 defects plus 2 fail-open edge cases. They were: TOCTOU on approval grants; live ledger records returned to callers; an exit status that optional scenarios could flip to a pass; an unbound NEAR `reconcile`; a redaction gap; an unchecked `replay` expectation; and replays ignoring blocking reasons. The two edge cases were unparseable grant timestamps and unvalidated ledger usage. All are fixed, and each has a regression test that fails on the old code.

## Out of scope and residual risks

- **Bypass of the enforcement point.** If the agent, or anything it controls, can reach a signing key without `authorize()` and `beginExecution()`, Drainproof cannot stop it. The key must sit behind a component that enforces the gate.
- **Wallet- or chain-level enforcement.** `ALLOW` is not proof that a wallet, smart contract or payment provider independently enforces the same rules.
- **LLM behaviour.** Drainproof does not detect or prevent prompt injection. It limits what an injected agent can achieve, within the policy.
- **Multi-process ledgers.** The in-memory reference ledger only serialises within one process.
- **Symmetric approval keys.** Whoever can verify grants can also issue them.
- **Finite test suites.** Passing the scenarios proves only the tested properties under the tested conditions.
