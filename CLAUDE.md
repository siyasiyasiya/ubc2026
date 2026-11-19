# Group Treasury Agent: working agreement

UBC 2026 hackathon project. **Submission deadline: Fri Nov 20, 12:00 PM CST.** See README.md for the product.
Multiple people and multiple Claude Code sessions (desktop app + VS Code) work on this repo at the same time. Follow these rules so nobody loses work.

## Git workflow

Everyone pushes straight to `main` (no PRs). Keep it collision-free:

1. **Pull before you start and before you push:** `git pull --rebase --autostash` (one-time per clone: `git config pull.rebase true`). A SessionStart hook pulls automatically for Claude Code.
2. **Commit small and often.** Each commit builds and does one thing. Conventional Commits:
   `feat(agent): parse receipt totals`, `fix(contracts): revert over weekly limit`, `docs: add Arc addresses`.
3. **Before every push:** `pnpm build && pnpm typecheck && pnpm test` (and `forge test` if you touched `contracts/`). Never push a red `main`.
4. **Push right after committing.** Unpushed work doesn't exist for your teammates.
5. **Never** force-push `main`, rewrite its history, or commit secrets.
6. **Two Claude sessions on one machine must not edit the same checkout at once.** Give the second one its own worktree on `main` (`git worktree add ../ubc2026-<task> main` or a detached `origin/main`), or keep them to separate folders. Tell the other session before editing a file it owns.

## Repo layout

pnpm monorepo (`pnpm install`, `pnpm build`, `pnpm typecheck`, `pnpm test`; Vitest). Run `pnpm build` once before `pnpm typecheck` so packages can see each other's types.

| Path | What | Tooling |
| --- | --- | --- |
| `packages/core` (`@gta/core`) | Shared types, money (USDC micro-dollars), ports, request state machine | TypeScript, Vitest |
| `packages/imessage` | `PhotonChatPort`: iMessage via Photon `@photon-ai/imessage-kit` (local Messages.app; reads chat.db) | TypeScript |
| `packages/agent` | Claude agent turn (tool runner) and `ClaudeReceiptReader` | TypeScript |
| `packages/wallet`, `packages/funding`, `packages/purchase` | Wallet/limits, card-to-USDC funding, store checkout adapters | TypeScript |
| `apps/server` | Runtime driving the state machine, composition root (`pnpm --filter @gta/server dev`), simulator (`... sim`) | TypeScript |
| `contracts/` | `GroupTreasury` contract (Arc testnet) | Foundry (`forge build`, `forge test`, `forge fmt`) |

Before writing new logic, check `@gta/core` for an existing type or port and use it.

## Coding standards

- **TypeScript:** `strict: true`, no `any` without a comment explaining why. Run `pnpm typecheck` and `pnpm test` before committing.
- **Solidity:** `forge fmt` before committing. Every external function has a test, including revert cases (over limit, unapproved spend, non-member). `forge test` must pass before pushing.
- **Secrets:** only in `.env` (gitignored). Every new variable gets a placeholder line in `.env.example`.
- **Money values:** USDC amounts are integers in base units (6 decimals). Never use floats for money.
- **Safety-critical logic lives in the contract**, not the agent. The agent proposes; the contract enforces limits and approvals.
- Keep functions small, name things plainly, and comment only the *why*.
- Update the README (architecture, contract addresses, how Arc/ElevenLabs are used) in the same commit as the change it describes. The hackathon judges these docs.

## Definition of done

- It builds, lints, and tests pass.
- It's been run once for real (not just "should work").
- It's pushed to `main`, and the commit message says what changed and how it was tested.
