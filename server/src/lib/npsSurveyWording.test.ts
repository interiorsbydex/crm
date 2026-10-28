/** The NPS survey page asks the same question, with the same score meanings, as the NPS email. */
import { describe, it, expect } from 'vitest';
import { MAIL_TEMPLATES, extractNpsSurveyWording } from './mailTemplates.js';

const defaultHtml = MAIL_TEMPLATES.find((t) => t.code === 'NPS_SURVEY')!.defaultHtml;

describe('extractNpsSurveyWording', () => {
  it('reads the question and the four score meanings from the default template', () => {
    const w = extractNpsSurveyWording(defaultHtml);
    expect(w.question).toBe("We'd love to know: on a scale of 0–10, how likely are you to recommend us to a friend or family?");
    expect(w.scoreMeanings.map((m) => m.title)).toEqual(['10 – Excellent', '9 – Very Good', '8 – Good', 'Below 8 – Needs Improvement']);
    expect(w.scoreMeanings[0].text).toMatch(/^All requirements were clearly understood/);
  });

  it("follows the admin's own question (live wording, missing space after the comma)", () => {
    const html = defaultHtml.replace(/how likely are you to recommend us to a friend or family\?/, 'How would you rate your experience with DeX so far? ')
      .replace('<strong>0–10</strong>, ', '<strong>0–10</strong>,');
    expect(extractNpsSurveyWording(html).question).toBe("We'd love to know: on a scale of 0–10, How would you rate your experience with DeX so far?");
  });

  it('gives nothing (page keeps its own wording) when the template has neither', () => {
    expect(extractNpsSurveyWording('<p>Dear {{clientName}},</p><p>{{scoreLinksHtml}}</p>')).toEqual({ question: null, scoreMeanings: [] });
  });
});
