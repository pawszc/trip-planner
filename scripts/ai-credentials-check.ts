import { pathToFileURL } from 'node:url';
import { loadAiConfig } from '../srv/ai/config.ts';
import { createCredentialCheckResult } from '../srv/ai/credential-check.ts';
import { AiError } from '../srv/ai/errors.ts';

export function runCredentialCheckScript(
  env: Readonly<Record<string, string | undefined>>,
  writeLine: (line: string) => void,
): 0 | 1 {
  try {
    const result = createCredentialCheckResult(loadAiConfig(env));
    result.lines.forEach(writeLine);
    return result.exitCode;
  } catch (error) {
    const code = error instanceof AiError ? error.code : 'INVALID_AI_CONFIGURATION';
    writeLine(`Credential check failed safely: ${code}. Review non-secret AI settings.`);
    return 1;
  }
}

function isMainModule(): boolean {
  const mainPath = process.argv[1];
  return mainPath !== undefined && import.meta.url === pathToFileURL(mainPath).href;
}

if (isMainModule()) {
  process.exitCode = runCredentialCheckScript(process.env, (line) => console.log(line));
}
