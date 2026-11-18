# Group Treasury Agent: working agreement

UBC 2026 hackathon project. **Submission deadline: Fri Nov 20, 12:00 PM CST.** See README.md for the product.
Multiple people and multiple Claude Code sessions (desktop app + VS Code) work on this repo at the same time. Follow these rules so nobody loses work.

## Git workflow

1. **Pull before you start anything.** `git pull --rebase --autostash` on `main` at the start of every session and before creating a branch. (A SessionStart hook does this automatically for Claude Code.)
2. **One short-lived branch per task**, cut from fresh `main`: `feat/<area>-<thing>`, `fix/<thing>`, `chore/<thing>`, `docs/<thing>`. Example: `feat/agent-receipt-split`.
3. **Commit small and often.** Each commit should build and do one thing. Use Conventional Commits:
   `feat(agent): parse receipt totals`, `fix(contracts): revert over weekly limit`, `docs: add Arc addresses`.
4. **Push after every commit** (`git push -u origin HEAD` the first time). Unpushed work doesn't exist for your teammates.
5. **Rebase on main often** (`git fetch && git rebase origin/main`), at least every hour and always before opening a PR.
6. **Open a PR into `main`** as soon as a task works end to end. Squash-merge. Delete the branch after merging.
7. **Never** force-push `main`, commit secrets, or commit directly to `main` (except trivial docs typos).
8. **Two sessions on the same machine must not edit the same checkout at once.** Give the second session (e.g. VS Code) its own worktree: `git worktree add ../ubc2026-<task> -b feat/<task> origin/main`. Otherwise stick to separate folders (one in `contracts/`, one in `agent/`).

## Repo layout (planned)

| Path | What | Tooling |
| --- | --- | --- |
| `contracts/` | `GroupTreasury` contract on Arc testnet | Foundry (`forge build`, `forge test`, `forge fmt`) |
| `agent/` | iMessage bot (Photon) + Claude agent loop + ElevenLabs calling | TypeScript on Node 22 |
| `web/` | Onboarding page: join group, set weekly limit, add card/wallet | TypeScript |
| `docs/` | Architecture, agent decision loop, safety limits, demo script | Markdown |

## Coding standards

- **TypeScript:** `strict: true`, no `any` without a comment explaining why. ESLint + Prettier; run `npm run lint` and `npm run format` before committing.
- **Solidity:** `forge fmt` before committing. Every external function has a test, including revert cases (over limit, unapproved spend, non-member). `forge test` must pass before a PR.
- **Secrets:** only in `.env` (gitignored). Every new variable gets a placeholder line in `.env.example`.
- **Money values:** USDC amounts are integers in base units (6 decimals). Never use floats for money.
- **Safety-critical logic lives in the contract**, not the agent. The agent proposes; the contract enforces limits and approvals.
- Keep functions small, name things plainly, and comment only the *why*.
- Update the README (architecture, contract addresses, how Arc/ElevenLabs are used) in the same PR as the change it describes. The hackathon judges these docs.

## Definition of done (per PR)

- It builds, lints, and tests pass.
- It's been run once for real (not just "should work").
- It's pushed, rebased on `main`, and the PR description says what changed and how it was tested.
