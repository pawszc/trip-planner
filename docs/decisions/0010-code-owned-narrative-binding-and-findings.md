# 0010 — Make narrative binding, disclosures and dimension status code-owned

## Status

Accepted for the offline-only Phase 3B3 contract-v2 hardening Draft PR. This decision does
not authorize a live baseline, create an accepted manifest, mark the phase `DONE`, or begin
Phase 4.

This ADR supersedes only the provider-contract clauses in ADR 0008 that say both `GENERATE`
and `JUDGE` consume `narrative-model-view-v1`, bind through `narrative-quality-context-v1`,
and require JUDGE to echo fingerprints plus eight independent statuses. It also resolves the
deferred decision in ADR 0009 and supersedes that ADR's steps 5–7/static transport description
that retain provider-owned fingerprints and `dimensions`, together with its current report/
manifest v2 binding. Both ADRs remain historical records; their durable-audit, privacy,
fail-closed publication, exact profile, cost-cap and no-retry decisions remain in force.

## Context

The failed Phase 3B3 baseline exposed three avoidable model obligations. `GENERATE` had to
copy an opaque context fingerprint and author mandatory provenance and missing-data wording.
`JUDGE` had to copy two opaque fingerprints and independently emit both findings and a full
eight-entry dimension-status array. Separately, P03 contained a three-way drift between its
authored claim, the persisted synthetic effective-time field and the exact fixture timestamps.

Opaque-value copying is not semantic reasoning and gives code a weaker binding than the
request and durable audit data it already owns. Mandatory provenance and unavailable-data
disclosures must be exact, complete and stable; delegating them to prose generation makes
omission and drift possible. Independent findings and dimension statuses can contradict each
other even though status is completely derivable from findings.

## Decision

`GENERATE` receives `narrative-generation-view-v1`, a deterministic, canonical, fingerprinted
and size-bounded projection of the full context. It contains only narratable `KNOWN` facts and
safe rank/role metadata. Provenance facts, `UNKNOWN`/`MISSING` facts, source URLs, provider
identity, external IDs and source keys are excluded.

The projection is a closed allowlist by exact fact key and exact value shape. Every supported
selection, destination, transport, accommodation, budget and score field is copied explicitly;
unknown keys, duplicate facts and additional nested fields fail closed. Source snapshots and
provenance have no structural path into provider input. Arbitrary source-owned strings are not
searched through independently grounded domain values, object keys, fact IDs or fingerprints, so
an accidental textual collision does not reject an otherwise valid projection.

The provider-visible GENERATE schema is `{ blocks }` with at most six blocks. Local code:

1. validates every provider block and reference against the generation view;
2. rejects provider-owned freshness/demo prose and unavailable-value completion through a closed
   EN/PL, fact-reference-aware assertion contract; broad domain nouns alone do not reserve a
   separately `KNOWN` transport, accommodation or destination fact;
3. requires every money, date/time and remaining numeric token to belong exactly to a cited
   `KNOWN` fact, excluding raw minor-unit strings from provider prose;
4. injects the exact grounded-context fingerprint;
5. appends an exact source disclosure when fixture/demo/cache metadata requires it;
6. appends one exact `UNKNOWN`/`MISSING` limitation block when required;
7. validates the provider prefix plus deterministic tail with a final maximum of eight blocks.

Post-response evidence distinguishes the strict provider transport, exact binding and local
policy phases. Malformed raw `{blocks}` is `TRANSPORT_SCHEMA_VALIDATION`; an exact request,
generation-view, context, reference or injected-fingerprint mismatch is `CONTEXT_BINDING`; and a
structurally valid provider response rejected by deterministic narrative policy is
`NARRATIVE_FINALIZATION`. The expanded allowlisted stage contract is versioned as
`post-response-failure-accounting-v4`. Report v3 and live-execution v3 retain their draft version
identifiers because their intended pre-merge schemas are updated consistently.

The same finalization verifier is part of the request-local output schema, deterministic
precheck and runtime/E2E path. The production entry point requires an exact generation view;
frozen authored JUDGE-stage cases use a separately named eval-only content-safety scan. Provider
prose is never rewritten.

The provider-visible JUDGE v3 schema is `{ findings }`. Each finding contains only a closed
dimension, reason code, severity, ascending unique block sequences and unique in-context fact
IDs. Local code injects the exact quality-context and narrative fingerprints and derives all
eight statuses: a dimension is `FAIL` exactly when at least one validated finding names it;
otherwise it is `PASS`. Any finding causes `REJECT`; partial publication remains impossible.
The request input fingerprint, prompt/schema versions, durable `AiRun`, planning/option IDs,
configured and response models, usage and terminal audit continue to provide operational
binding. Historical `CONTEXT_BINDING` remains a safe enum for already-bound local output, but
a provider can no longer fail merely by miscopying an opaque hash.

Rubric v2 separates the principal boundaries: a false claim with relevant references is
factual entailment; a true claim with irrelevant references is reference relevance; source
freshness overstatement is provenance; injection/excluded content/PII/secrets/unsafe guidance
is safety; money/date/time manipulation, unavailable-value completion, constraint/ranking
changes and block-kind mismatch use their dedicated dimensions. A genuinely independent
multi-dimension defect requires one explicit finding per dimension.

Report v3 records sorted, unique, closed `actualFailedDimensions` and `actualReasonCodes` for
every E2E row and is rebuilt canonically from allowlisted evidence. Baseline manifest v3 is
bound to report v3 and still accepts only a fully passing, completely accounted, exactly linked
report. No accepted manifest is added by this decision.

Dataset and fixture v1 remain tracked. Their v2 successors use one pure production helper for
effective time. For P03, outbound departure plus 255 travel minutes yields arrival
`2026-10-10T11:15:00.000Z`; return departure `2026-10-13T17:00:00.000Z` therefore yields
`floor(delta / 60000) = 4665`. The authored claim and persisted fixture field use that value,
and P03 remains `PUBLISH`.

## Consequences

- Model outputs contain fewer opaque and mutually redundant fields.
- Mandatory disclosures are deterministic, exactly referenced and testable without a provider.
- Generation input cannot expose source-owned or non-`KNOWN` values that code owns.
- Independently grounded short IDs, transport modes and destination codes are not tainted merely
  because the same bytes also occur in source metadata.
- Privacy-safe failure evidence preserves the difference between provider transport, exact
  binding and deterministic narrative finalization without carrying rejected content.
- A custom adapter result is revalidated against the already-bound local schema at the gateway;
  provider transport validation remains a separate earlier phase in each adapter.
- Historical v1 artifacts remain available; current serialized/provider-visible changes have
  explicit successor versions.
- Report evidence remains privacy-safe: no narrative, prompt, context, fact value, source value,
  provider payload, PII or credential is admitted.
- Runtime profiles remain `ANTHROPIC / claude-sonnet-5 / low / 1600` for GENERATE and
  `OPENAI / gpt-5.6-luna / low / 2048` for JUDGE, with zero live calls in this change.

## Rollback

Rollback is the revert of the contract-v2 commits as a unit. Historical v1 dataset/schema
artifacts and nullable legacy persistence fields make that revert reviewable without inventing
a backfill. A v3 report or future v3 manifest must never be silently interpreted as v2, and no
model/provider alias may be substituted during rollback.
