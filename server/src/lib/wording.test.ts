import { describe, expect, it } from 'vitest';
import { wordingConfig } from './wording.js';
import { ConfigError } from './versionedConfig.js';

describe('wording', () => {
  it('keeps only labels that differ from the original', async () => {
    expect(await wordingConfig.spec.validate({ 'app.name': 'DeX CRM', 'dip.threadUrl': 'Internal Mail Thread URL' })).toEqual({ 'app.name': 'DeX CRM' });
  });
  it('rejects unknown and empty labels', async () => {
    const fails = async (raw: unknown) => { try { await wordingConfig.spec.validate(raw); return false; } catch (e) { return e instanceof ConfigError; } };
    expect(await fails({ 'made.up': 'x' })).toBe(true);
    expect(await fails({ 'app.name': '  ' })).toBe(true);
  });
});
