# Foundry Arena — boxd development machine

    ssh foundry-dev.boxd          # or: boxd machine connect foundry-dev
    cd ~/freeq-foundry
    pi                            # your Claude account, already authenticated

Everything below is installed and verified working on this machine.

## Toolchain

| | |
|---|---|
| node / pnpm | v24.18 / 10.34 — symlinked into `/usr/local/bin` so every shell sees them |
| pi | 0.83.0, same as the laptop. `PI_PROVIDER=anthropic` |
| claude / codex | preinstalled; Claude credentials present |
| gh | logged in as `chad`, `gh auth setup-git` done — `git push` works |
| ollama | installed, `gemma3:1b` pulled (CPU-only, 2 vCPU) |
| tmux | preinstalled — use it, agent runs outlive an SSH drop |

Auto-suspend is **off**. Arena runs are quiet on CPU and network and would otherwise be
suspended mid-session, freezing the payroll clock.

## Keys

`~/freeq-foundry/.env` (mode 600, gitignored) holds ANTHROPIC_API_KEY and
OPENAI_API_KEY. Loaded automatically by `~/.bashrc` and by `scripts/run-corp.sh`. Both
verified against the live APIs from here (HTTP 200).

boxd's account-level secret injection never reached this machine — not at scope
`shared`, not at `all`, not after a reboot — which is why the keys are in a .env. If
that starts working, delete the .env and the two `.bashrc` lines.

## Git

Real remote, full history, tracking `origin/main`:

    git pull        # works
    git push        # works (gh credential helper)

## Run it

    # free, no keys, no network
    node apps/foundry-agents/dist/cli.js simulate --port 7667

    # free local agents (gemma3:1b via ollama)
    ./scripts/run-corp.sh my-run --only lune

    # paid, ~$1-2
    ./scripts/run-corp.sh my-run

    # the commons scenario: no stated objective
    node apps/foundry-agents/dist/cli.js --owner did:plc:4qsyxmnsblo4luuycm3572bq \
      --yes-spend-money --max-spend-usd 8 --channel '#foundry' \
      --run-id commons-6 --rules rulesets/commons.json --only ada,briar,cyrus,dara

    # analysis (offline, no keys)
    node apps/foundry-agents/dist/cli.js report out/*/events.ndjson
    node apps/foundry-agents/dist/cli.js site --out site/index.html

Five real runs are in `out/` so `report`, `dashboard` and `site` have data.

## Gotchas

- `boxd machine exec` runs a **non-login** shell: nvm's PATH is absent, which is why
  node/pi are symlinked into `/usr/local/bin`. Interactive SSH is fine.
- The boxd CLI restructured in v0.2.3: `boxd machine exec|cp|reboot`, not `boxd exec`.
- macOS `tar` smuggles AppleDouble `._*` files into transfers and vitest tries to run
  `._policy.test.ts` as a test. Use `COPYFILE_DISABLE=1 tar` if you copy from the Mac.
- Ollama is CPU-only here. `gemma3:1b` is fine; anything larger will crawl.

## Where the work stood

- `commons` ran live twice. First ended in insolvency with the group never organising —
  confounded by tuning, since the inflow rule never fired once. Retuned: 600k pool,
  ~8 periods, empty periods now reported so there is something to learn from.
- `private_plus_dms` has had two live runs and produced **zero DMs**. Unresolved:
  prompting gap, or agents that see no value in private coordination.
- Everything else in the arena README's "honest limits" still stands.
