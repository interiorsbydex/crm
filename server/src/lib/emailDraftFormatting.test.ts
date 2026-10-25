import { describe, expect, it } from 'vitest';

const helperPath = new URL('../../../client/src/lib/emailDraftFormatting.ts', import.meta.url).pathname;
const { prepareEmailDraft, renderEditedEmail } = await import(/* @vite-ignore */ helperPath);
const table = '<table><thead><tr><th>Milestone</th><th>Date</th></tr></thead><tbody><tr><td>Site documentation</td><td>25 Oct 2026</td></tr></tbody></table>';
const original = `<p>Dear client,</p><p>Your timeline:</p>${table}<p>Thank you.</p>`;

describe('Email preview preserves the onboarding table', () => {
  it('sends the original structured HTML when the message is unchanged', () => {
    expect(renderEditedEmail(original, prepareEmailDraft(original).body)).toBe(original);
  });

  it('preserves exactly one table when the surrounding message is edited', () => {
    const body = prepareEmailDraft(original).body.replace('Dear client,', 'Dear synthetic QA,');
    const result = renderEditedEmail(original, body);
    expect(result).toContain('<p>Dear synthetic QA,</p>');
    expect(result).toContain(table);
    expect(result.match(/<table/g)).toHaveLength(1);
    expect(result).not.toContain('[Included table');
    expect(result).not.toContain('<p><table');
  });

  it('does not silently drop the automatic table when its text marker is removed', () => {
    expect(renderEditedEmail(original, 'Edited welcome message.')).toContain(table);
  });

  it('escapes edited text instead of allowing HTML injection', () => {
    const result = renderEditedEmail(original, '<script>alert("test")</script>\nUpdated message');
    expect(result).not.toContain('<script>');
    expect(result).toContain('&lt;script&gt;');
    expect(result).toContain('<br/>Updated message');
  });

  it('keeps original NPS buttons and fallback link unchanged when not edited', () => {
    const nps = '<p>Feedback</p><a href="https://synthetic.invalid/nps/token?score=7">7</a>';
    expect(renderEditedEmail(nps, prepareEmailDraft(nps).body)).toBe(nps);
  });

  it('keeps usable HTTP links when an NPS message is edited', () => {
    const nps = '<p>Feedback</p><a href="https://synthetic.invalid/nps/token?score=7">7</a>';
    const result = renderEditedEmail(nps, prepareEmailDraft(nps).body.replace('Feedback', 'Your feedback'));
    expect(result).toContain('href="https://synthetic.invalid/nps/token?score=7"');
  });
});
