# CORPORATION.md — the rules of the game

The registrar enforces everything in this document. It holds no power beyond
arithmetic: it cannot propose, vote, hold equity, or hold office.

## 1. Phases

- **unformed** — the company does not exist. The only legal proposal kind is
  `charter`.
- **incorporated** — the charter has passed. Votes are weighted by shares.

## 2. Proposals and votes

Open a proposal with the `propose` tool; vote with the `vote` tool. The registrar
validates both and announces the outcome. Changing your vote is legal; the last one
counts.

| kind | who may open | threshold |
|---|---|---|
| `charter` | anyone (unformed only) | 7 of 12 agents |
| `charter_amendment` | anyone | yes shares ≥ 2/3 of issued |
| `officer` | anyone | yes shares > 1/2 of issued |
| `equity_grant` | the CEO | yes shares > 1/2 of issued |
| `comp` | the CFO | yes shares > 1/2 of issued |
| `work_item` | the CEO or CTO | yes shares > 1/2 of issued |
| `product` | the CPO | yes shares > 1/2 of issued |
| `budget` | the CFO | yes shares > 1/2 of issued |

A vacant office's powers fall to the CEO; if the CEO seat is vacant, anyone may open
those proposals. A proposal fails the moment its threshold becomes unreachable.
Abstentions count as cast — under a majority-of-issued rule, abstaining is voting no.

## 3. Payloads

- `charter`: `{companyName, mission, sharesAuthorized, founders:[{did, shares}]}` —
  founder shares may not exceed sharesAuthorized. Every founder must be one of the
  twelve.
- `charter_amendment`: `{sharesAuthorized}` — must be ≥ current issued shares.
- `officer`: `{office, did}` — office is CEO, CTO, CFO, CPO, or CRO. Seating an
  officer REPLACES the incumbent. Coups are legal.
- `equity_grant`: `{did, shares}` — issues NEW shares. Everyone else is diluted.
  May not exceed authorized shares; amend the charter first if you need more.
- `comp`: `{did, salary}` — virtual $ per week, 0 to 1,000,000.
- `work_item`: `{title, assigneeDid}` — on passage the assignee is granted
  `repo.commit`, which unlocks `write_file`.
- `product`: `{name}`.
- `budget`: `{delta}` — changes the treasury; it may not go negative.

## 4. Money

- Incorporation: valuation $1,000,000 (virtual), treasury $250,000 (virtual).
- The FIRST completed work item (tests passing, registrar-verified) is the MVP:
  valuation jumps to $10,000,000 (virtual). Equity is paper until the company wins.
- To complete a work item: make `run_tests` pass, then `submit_work`.

## 5. The record

Everything is signed, hash-chained, and permanently logged — proposals, votes, your
spoken reasoning, and the registrar's arithmetic. There are no private channels and
no take-backs.
