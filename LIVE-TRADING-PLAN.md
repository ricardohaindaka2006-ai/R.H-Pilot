# Selected release plan — MT5 / CFDs, Render Free

**Decision recorded:** MT5/CFDs, Render Free only, small/bounded storage and owner email `ricardohaindaka2006@gmail.com`. The earlier Options-versus-MT5 decision and paid-hosting proposal are superseded. There is no request to choose a product or approve a paid plan again.

## Implemented in this change

- Separate MT5 terminal pairing, account isolation, monitoring and explicit **demo-only** entry control in the existing bronze Wallet dashboard.
- Outbound Windows Python agent using the local MT5 SDK. No inbound client port, uploaded terminal password, paid bridge, VPS or MT5 installation on Render.
- Persisted order intents, SQLite pre-send journal, duplicate protection, process fencing, uncertain-send reconciliation, complete broker-deal costs and restart disarming. Paper P/L is never used as MT5 settlement.
- Independent editable MT5 strategy/risk settings, mandatory $1 / 1.5% planned per-trade risk, daily/drawdown/streak protections and minimum-volume/margin/SLTP checks. No daily trade-count/default-profit ceiling. Broker gaps, fees and slippage are not insured.
- Optional operator-supplied PostgreSQL state, persistence-before-success authentication, encrypted Options tokens, separate PAT/OAuth registrations and preserved admin identity.
- Bounded application state/backups/histories and native journal retention that preserves risk/unresolved exposure. No silent financial reset when capacity/storage fails.
- Backend, native-agent, real PostgreSQL and responsive browser fixtures, wired into CI. Frozen strategy diagnostics remain unchanged.

## Canonical topology

```text
ricardohaindaka2006-ai/R.H-Pilot
            │
            ▼
one existing r-h-pilot-3 Render Free web service
            ├── operator-owned durable PostgreSQL (not automatically provisioned)
            └── outbound HTTPS from each user's own Windows MT5 agent
```

No service/repository has been deleted and no paid resource has been provisioned. Unknown obsolete resources are not cleanup targets. Actual Render inventory, deployed revision and private configuration remain operator verification items.

## Remaining operational gates

1. **Rotate exposed secrets privately.** Keep the owner's email; set a new admin password and revoke any exposed broker credential. Never reuse a password supplied in chat.
2. **Configure durable state before clients/demo execution.** Supply a suitable free/direct/session PostgreSQL arrangement and a stable token-encryption key. Migrate existing identities/licences/risk before redeploying ephemeral files. Explicit empty-database initialization is one-time only; no automatic reset/fallback.
3. **Configure optional Options authentication separately.** Register the actual PAT application and/or OAuth client, exact callback and required scopes. These are not MT5 credentials. MT5-only users can sign in with workspace email/Google and pair the terminal.
4. **Deploy only reviewed code to the canonical service.** Check health SHA, storage durability, owner sign-in and account isolation. Coordinate a single-writer shutdown/handoff; never bypass the database lock with another namespace.
5. **Perform native Windows/demo acceptance.** Check the exact broker account, SDK, symbol specifications, buy/sell/close/SLTP lifecycle, partial fills, all costs, network/storage/terminal faults and restart recovery. Offline FakeMT5 tests cannot substitute for this.
6. **Validate strategy and operations before any future real release.** There is no demonstrated live edge, 90–95% live win rate, principal guarantee, microsecond fill guarantee or 24/7 Free-service SLA. Real-money execution remains disabled; no activation is authorized here.

Render Free's sleep/ephemeral-file limitations and expiring Free PostgreSQL prevent claiming permanent, always-on customer durability from a Free web process alone. An external state adapter is implemented, not a promise that an unspecified provider is permanent or free. [1](https://render.com/docs/free)

## Operator handoff

- [MT5-FREE-SETUP.md](MT5-FREE-SETUP.md): exact private setup, migration, Windows agent, storage policy, recovery and actual-demo checklist.
- [DERIV-CONNECTION.md](DERIV-CONNECTION.md): optional Options PAT/OAuth sign-in and security boundaries.
- [MT5-VERIFICATION.md](MT5-VERIFICATION.md): what was tested locally and what is not established.
- [RISK-MANAGEMENT.md](RISK-MANAGEMENT.md), [REPORT-engine.md](REPORT-engine.md): unchanged paper-risk and frozen synthetic evidence; not MT5 profitability evidence.

There is no purchase, upgrade, automatic real activation or instruction to delete unidentified resources in this plan.
