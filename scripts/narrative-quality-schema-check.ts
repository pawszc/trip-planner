import { verifyNarrativeQualitySchemaParity } from '../srv/evals/schema-parity.ts';

const evidence = verifyNarrativeQualitySchemaParity();

console.log(
  JSON.stringify({
    status: 'PASS',
    evidenceKind: 'SCHEMA_PARITY',
    ...evidence,
  }),
);
