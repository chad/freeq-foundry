# Contributing

## Read the specification first

[`docs/specification.md`](docs/specification.md) is normative. It uses
**MUST**, **MUST NOT**, **SHOULD**, **SHOULD NOT**, and **MAY** in their
conventional requirements sense. Where this repository disagrees with it, the
specification wins.

Cite it. A pull request that implements a normative requirement should say which
one, by section. The citation is what lets a reviewer check the work against
something other than their own opinion.

## Decisions are recorded

Write an [ADR](docs/adr/README.md) for any change that:

- closes one of the [§58](docs/specification.md#58-open-questions) open questions;
- constrains a wire format, credential format, or signature scheme;
- selects a dependency or datastore that would be costly to reverse;
- interprets a **SHOULD** as a **MUST** for this implementation;
- deviates from the specification.

That last case matters most. **A deviation without an ADR is a bug. A deviation
with an ADR is a design.**

This is not bureaucracy. The output of this project is a research claim, and its
credibility depends on a reader being able to ask "was that the agents, or was
that the implementation?" and get an answer.

## The protocol package is special

`packages/protocol` defines the wire format that independent operators implement
in their own languages. It has extra rules:

1. **Zero runtime dependencies.** Its audit surface should be readable in one
   sitting.
2. **Changes to canonical form, hashing, or signing contexts are breaking.**
   They invalidate every previously issued signature. Treat them as protocol
   version changes, not patches.
3. **Assert against external facts where possible.** A test that compares our
   output to our output proves only self-consistency. Prefer published test
   vectors, or values cross-checked against an independent implementation.

## Development

```bash
pnpm install
pnpm typecheck   # strict, includes test files
pnpm test
pnpm build
```

Requires Node 20.11+ and pnpm 10.

### Workspace rules

- Packages depend on each other by name (`@freeq-foundry/protocol`), never by
  relative path across a package boundary. An illegal dependency should fail to
  resolve rather than silently work — that is what keeps the modular monolith
  modular ([ADR-0002](docs/adr/0002-typescript-monorepo.md)).
- The dependency graph is acyclic and layered. `protocol` is the root and
  depends on nothing internal. Nothing depends on an application.
- Packages are created when first needed. The
  [§32.4](docs/specification.md#324-suggested-repository-layout) layout is the
  target; the filesystem should reflect reality, not aspiration.

## Testing

Every rejection needs a distinct, testable error code. "It threw" is not an
assertion — conformance vectors reference codes directly so an implementation in
another language can check not merely *that* a value was rejected but that it was
rejected for the right reason.

Prefer tests that state a property over tests that restate the implementation.
The useful question is "what would a wrong implementation do that this catches?"

### When a test fails

Work out whether the test or the code is wrong before changing either. Three of
the first four failures in this repository were incorrect test expectations, and
one was a real design gap. Fixing the code to satisfy a wrong test would have
been worse than the original bug.

## Commits and pull requests

- Reference the issue: `Refs #13` or `Closes #13`.
- Explain *why* in the body. The diff already shows what.
- Keep the subject under 72 characters, imperative mood.

CI runs typecheck, tests, build, and a check that every Markdown link into the
specification resolves to a real heading. A dead anchor turns a citation into a
decoration.

## Open questions

[`docs/open-questions.md`](docs/open-questions.md) tracks the fifteen
[§58](docs/specification.md#58-open-questions) questions plus any that arise
during implementation. Each has a status and a trigger.

If you hit a question the specification does not answer, add it there rather than
answering it implicitly in code. A question without a trigger is not deferred —
it is forgotten.
