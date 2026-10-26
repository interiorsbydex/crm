import { describe, expect, it } from 'vitest';
import { googleFormSecretCheck } from './questionnaire.js';

describe('google form webhook secret', () => {
  it('still accepts requests when no secret is configured', () => {
    expect(googleFormSecretCheck(undefined, '')).toBe('unconfigured');
    expect(googleFormSecretCheck('anything', '')).toBe('unconfigured');
  });
  it('accepts only the exact secret once one is set', () => {
    expect(googleFormSecretCheck('s3cret', 's3cret')).toBe('ok');
    expect(googleFormSecretCheck('s3creT', 's3cret')).toBe('bad');
    expect(googleFormSecretCheck('s3cret-and-more', 's3cret')).toBe('bad');
    expect(googleFormSecretCheck(undefined, 's3cret')).toBe('bad');
  });
});
