import { describe, expect, it } from 'vitest';
import { redactSensitiveData } from '../../srv/ai/redaction.js';

describe('AI diagnostic redaction', () => {
  it('redacts environment keys and authentication headers case-insensitively', () => {
    const value = redactSensitiveData({
      OPENAI_API_KEY: 'openai-secret',
      anthropic_api_key: 'anthropic-secret',
      Authorization: 'Bearer auth-secret',
      'x-api-key': 'header-secret',
    });

    expect(value).toEqual({
      OPENAI_API_KEY: '[REDACTED]',
      anthropic_api_key: '[REDACTED]',
      Authorization: '[REDACTED]',
      'x-api-key': '[REDACTED]',
    });
  });

  it('redacts provider-style tokens and header fragments embedded in strings', () => {
    const openAiKey = 'sk-' + 'proj-' + 'abcdefghijklmnopqrstuvwxyz1234567890';
    const anthropicKey = 'sk-' + 'ant-' + 'abcdefghijklmnopqrstuvwxyz1234567890';
    const value = redactSensitiveData(
      `OpenAI=${openAiKey}; Anthropic=${anthropicKey}; Authorization: Bearer hidden-token`,
    );

    expect(value).not.toContain(openAiKey);
    expect(value).not.toContain(anthropicKey);
    expect(value).not.toContain('hidden-token');
    expect(value).toContain('[REDACTED]');
  });

  it('deeply copies and redacts nested objects and arrays', () => {
    const source = {
      nested: [{ headers: { authorization: 'Bearer secret' } }, 'sk-abcdefghijklmnopqrstuv'],
      safe: 'keep me',
    };
    const result = redactSensitiveData(source);

    expect(result).toEqual({
      nested: [{ headers: { authorization: '[REDACTED]' } }, '[REDACTED]'],
      safe: 'keep me',
    });
    expect(result).not.toBe(source);
  });

  it('redacts common secret-bearing diagnostic field names', () => {
    expect(
      redactSensitiveData({
        apiKey: 'api-key-value',
        access_token: 'access-token-value',
        token: 'token-value',
        secret: 'secret-value',
        password: 'password-value',
      }),
    ).toEqual({
      apiKey: '[REDACTED]',
      access_token: '[REDACTED]',
      token: '[REDACTED]',
      secret: '[REDACTED]',
      password: '[REDACTED]',
    });
  });

  it('handles circular diagnostic objects without throwing', () => {
    const source: Record<string, unknown> = {};
    source.self = source;

    expect(redactSensitiveData(source)).toEqual({ self: '[CIRCULAR]' });
  });
});
