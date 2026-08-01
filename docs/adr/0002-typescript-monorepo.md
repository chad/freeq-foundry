# ADR-0002: TypeScript modular monolith in a pnpm workspace

**Status:** Accepted
**Date:** 2026-02-19
**Spec references:** [§32.1](../specification.md#321-architectural-style), [§32.4](../specification.md#324-suggested-repository-layout), [§32.5](../specification.md#325-technology-recommendations)

## Context

The specification declines to mandate a language but recommends TypeScript, and
gives a concrete repository layout of six applications and twenty-four packages
([§32.4](../specification.md#324-suggested-repository-layout)). It also insists the
platform begin as a **modular monolith with event-sourced boundaries, not
premature microservices**, while requiring that the logical components remain
separable ([§32.1](../specification.md#321-architectural-style)).

Those two requirements are in tension unless the module boundaries are enforced
by something other than good intentions. A single package with twenty-four
directories inside it is not separable; it only looks separable.

A further constraint is external: the platform's entire value proposition is that
independent operators can implement agents in any language
([§59.14](../specification.md#59-final-design-principles)). Whatever we choose
internally must not leak into the wire protocol.

## Decision

TypeScript on Node.js, organised as a pnpm workspace, following the
[§32.4](../specification.md#324-suggested-repository-layout) layout.

Specifics:

1. **pnpm workspaces** for package management. Packages depend on each other by
   name (`@freeq-foundry/protocol`), never by relative path across package
   boundaries. An illegal dependency fails to resolve rather than silently
   working — this is the enforcement mechanism the modular monolith needs.
2. **ESM only.** No CommonJS builds. Node 20+ is the floor; development targets
   the current LTS.
3. **Strict TypeScript.** `strict`, `noUncheckedIndexedAccess`,
   `exactOptionalPropertyTypes`, `verbatimModuleSyntax`.
4. **Packages are created when first needed,** not up front. Twenty-four empty
   directories are clutter that implies work has begun where it has not. The
   layout in [§32.4](../specification.md#324-suggested-repository-layout) is the
   target; the filesystem reflects reality.
5. **The dependency graph is acyclic and layered.** `protocol` is the root and
   depends on nothing internal. Nothing depends on an application.
6. **`packages/protocol` has zero runtime dependencies.** It defines the wire
   format; it must be trivially auditable and trivially portable.

TypeScript is an implementation choice, not a protocol choice. The wire format is
JSON with published JSON Schemas ([ADR-0004](0004-canonical-serialization.md)),
and conformance is defined by test vectors that any language can execute.

## Options considered

### TypeScript + pnpm workspace (chosen)

Matches the specification's recommendation. Protocol schemas map naturally to
types; JSON Schema tooling is strong; the target SaaS product may also be
TypeScript, which lets the repository service and sandbox share toolchain
assumptions early.

### Go

Genuinely attractive: better sandboxing primitives, easier single-binary
distribution, stronger concurrency story for the scheduler. Rejected because the
specification's recommendation carries weight in a research context — deviating
invites the question "did the platform language shape the result?" — and because
JSON Schema and structured-output tooling for model adapters is materially
weaker.

### Rust

Rejected. The cryptographic and sandboxing story is the best of the three, but
development velocity matters more at Milestone 1 than memory safety in a system
whose untrusted code already runs in containers
([§31](../specification.md#31-sandboxing-and-real-world-resources)).

### Polyglot from the start

Rejected as premature. It is a plausible endpoint — the sandbox and evaluator are
natural candidates for other languages — but choosing it now buys nothing and
costs a shared toolchain.

### Single package, directories as modules

Rejected. It satisfies "modular monolith" in appearance only. Nothing prevents
`governance` from importing `sandbox` internals, and by the time that matters the
cost of separation is high.

### npm or yarn workspaces

Rejected in favour of pnpm for strict dependency isolation: pnpm's non-flat
`node_modules` prevents accidental reliance on transitive dependencies, which is
the same class of error as ambient authority.

## Consequences

### Positive

- Module boundaries are enforced by the resolver, not by review.
- The protocol package can be published and audited independently.
- One toolchain, one test runner, one lint configuration.

### Negative

- Node's sandboxing story is weak, so the sandbox service
  ([§31](../specification.md#31-sandboxing-and-real-world-resources)) must rely on
  containers or microVMs rather than in-process isolation. This was always true;
  TypeScript makes it unavoidable rather than merely advisable.
- Single-threaded event loop means CPU-bound projection rebuilds need worker
  threads or a separate process.

### Risks accepted

- If the scheduler becomes a throughput bottleneck at
  [Phase 7 scale](../specification.md#phase-7-large-scale-run), it may need
  rewriting. Accepted: the event-sourced boundary means it can be replaced
  independently, which is precisely why the boundary exists.

## Revisit when

- A component demonstrates a throughput or isolation requirement that Node cannot
  meet. Replace that component, not the platform.
- The sandbox service is designed in earnest (Milestone 8). It is the most likely
  first non-TypeScript component.
