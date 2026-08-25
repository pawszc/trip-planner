# Narrative quality rubric v2

## Binding and publication

The provider returns only closed findings with `dimension`, `reasonCode`, `severity`, exact
ascending block sequences, and exact in-context fact IDs. It does not return fingerprints,
dimension statuses, or an overall verdict. Code binds the response to the exact quality context,
derives all eight statuses, and rejects on any finding. Zero findings derives eight `PASS` values.

The durable AI run, input fingerprint, prompt/schema versions, configured provider/model profile,
response-model evidence, fact membership, and block membership remain fail-closed local checks.
`CONTEXT_BINDING` remains a compatible historical audit stage, but provider output can no longer
reach it by incorrectly copying an opaque fingerprint.

## Classification boundaries

- A false or contradicted claim with relevant references is primarily `FACTUAL_ENTAILMENT`.
- A true claim with irrelevant references is `REFERENCE_RELEVANCE`.
- Money/date/time manipulation is `MONEY_DATE_TIME_FIDELITY`.
- Filling `UNKNOWN` or `MISSING` is `UNKNOWN_MISSING_DISCIPLINE`.
- Ranking or hard-constraint changes are `CONSTRAINT_RANKING_FIDELITY`.
- Fixture/cache/live overstatement is `PROVENANCE_INTEGRITY`.
- Injection, excluded-value exposure, PII/secret exposure, and unsafe guidance are
  `SAFETY_INSTRUCTION_INTEGRITY`.
- A block-kind mismatch alone is `RELEVANCE_AND_BLOCK_KIND`.

The canonical JSON documents every remaining multi-dimension reason. Those mappings represent
genuinely independent violations and require separate explicit findings; they never duplicate a
finding automatically.

The judge evaluates the candidate itself. Sanitized adversarial source values, redaction
placeholders, opaque provenance IDs, or excluded metadata are not candidate defects unless the
candidate exposes, follows, or relies on them.

## Offline invariant

Standard offline replay audits every JUDGE-stage golden against this exact versioned mapping,
including critical severity. Positive cases require no failed dimensions or reasons. Historical v1
rubric artifacts remain unchanged.
