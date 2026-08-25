# 0009 — Separate provider transport from local narrative binding

## Status

Accepted for the Phase 3B3 corrective Draft PR. This decision does not authorize another live
baseline and does not change the phase from `REVIEW`.

## Context

The third separately authorized synthetic baseline stopped on `P01 / JUDGE` with
`INVALID_STRUCTURED_OUTPUT`. The OpenAI SDK parser ran before the adapter could retain the
privacy-safe response metadata needed to distinguish a pre-request schema-construction failure
from a completely accounted post-response contract failure. The previous JUDGE Zod schema also
combined constraints visible to the provider with context-specific and cross-field checks.

Classifying a failure by inspecting Zod error text would make accounting depend on unstable,
potentially value-bearing diagnostics. Treating every invalid output as an unaccounted technical
failure, on the other hand, prevents a complete synthetic baseline from producing a failing
quality report even when the response, usage, cost, and terminal audit are all known.

## Decision

The JUDGE contract is split into these explicit boundaries:

1. provider JSON Schema construction;
2. provider request and privacy-safe response-metadata capture;
3. in-memory JSON parsing;
4. static transport-schema validation;
5. exact context-fingerprint binding;
6. exact eight-dimension binding;
7. finding and cross-field binding.

Each local failure boundary has a closed `validationFailureStage`; no stage is inferred from an
exception message, Zod issues, a path containing values, or raw provider content.

The static transport schema keeps the existing fingerprints, `dimensions` array, enum catalogs,
strict objects, and structural limits. Its `blockSequences` range uses the already frozen maximum
of eight narrative blocks. The previous schema used the actual case block count for the provider
maximum. Moving the exact per-case range into `FINDING_BINDING` therefore creates a small,
intentional provider-visible schema change and requires a new JUDGE schema version and workload
fingerprint. The prompt, rubric, publication policy, dataset, model profile, models, effort,
output-token ceilings, retry count, call plan, and hard caps do not change.

For exact one-block P01, canonical SDK JSON Schema changes in exactly three places:
`dimensions.minItems` changes from 8 to 1 so missing/duplicate membership is classified by
`DIMENSION_BINDING`, while `blockSequences.maxItems` and its item `maximum` change from 1 to the
frozen transport maximum 8 before exact case binding. The canonical v1 schema SHA-256 is
`2f5e8d0edafa7566445925a30f371377cc331ddb11fa95f5a2445e5c0157df14`; v2 is
`41d51c394515d10a194165b21e7350d54f62403271db38ca5ed3349d160a6429`.

OpenAI Responses calls use `create(...).withResponse()`. Terminal status, model and response IDs,
request ID, usage, attempts, incomplete reason, refusal state, and latency are captured before any
local parser runs. Raw `output_text` may exist only transiently in memory and has no field in safe
errors, telemetry, `AiRuns`, eval reports, snapshots, stdout, or stderr.

Production remains fail-closed for every `INVALID_STRUCTURED_OUTPUT`: it produces no narrative or
publication and performs no retry or rewrite. After a truthful durable audit, the product may
persist only the existing privacy-safe rejection review required by the phase contract; it never
persists candidate text or partial narrative product rows. The synthetic live evaluator alone may
continue to the next already planned logical call when all of the following are proven for a
JUDGE failure: terminal `COMPLETED` response, exact provider/model binding, one attempt, complete
usage and integer-only cost settlement, a known post-response validation stage, and durable exact
terminal `FAILED` audit linkage. The case is recorded as a fail-closed `REJECT`, and explicit
primary, repeat, and end-to-end validity gates make the final report fail. Any missing evidence,
profile mismatch, refusal, incomplete response, audit failure, or incomplete accounting stops the
whole run without a partial report.

Report v2 retains the minimal allowlisted primary, repeated-sentinel, end-to-end, and operation
evidence needed to derive every metric, gate, total, and cost again. Before an accepted manifest
v2 can be validated, code rebuilds the complete canonical report from that evidence and the frozen
dataset, then requires exact canonical equality. Stale aggregates, forged passing gates, changed
cost summaries, extra fields, or extra version keys therefore cannot be rebound by merely
recomputing `reportFingerprint`.

## Deferred decision

Removing echoed fingerprints from model output or replacing the provider-visible `dimensions`
array could reduce dynamic output obligations, but either change would alter the prompt/schema
contract and needs separate evidence, versioning, and baseline authorization. This correction
does neither.

## Consequences

- Pre-request failures prove zero provider attempts; post-response invalid outputs retain safe
  accounting metadata without retaining content.
- The report can represent a fully executed but failing baseline, while an accepted manifest still
  requires every gate and every structured output to pass.
- Legacy `AiRuns` keep nullable new fields as `null`; there is no backfill.
- A new live baseline remains forbidden until separately and explicitly authorized.
