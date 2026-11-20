import { describe, it, expect } from 'vitest';
import { matchSource, normalisePossession, normaliseProjectType, parseNotesDetails, utmFromUrl } from './truePulse.js';

const SOURCES = [
  { value: 'META_ADS', label: 'Meta Ads' }, { value: 'GOOGLE_ADS', label: 'Google Ads' },
  { value: 'WEBSITE', label: 'Website' }, { value: 'INSTAGRAM', label: 'Instagram' }, { value: 'OTHER', label: 'Other' },
];

describe('True Pulse notes', () => {
  it('reads the agreed format', () => {
    expect(parseNotesDetails('Possession: Ready | Type: 3BHK | Scope: Full home | Location: Adyar, Chennai')).toEqual({
      possessionTimeline: 'Possession Received', projectType: '3BHK', scope: 'Full home', location: 'Adyar, Chennai',
    });
  });
  it('keeps only what is there, in any order and case', () => {
    expect(parseNotesDetails('location : OMR |  scope: Kitchen')).toEqual({ location: 'OMR', scope: 'Kitchen' });
    expect(parseNotesDetails('Call after 6pm')).toEqual({});
    expect(parseNotesDetails(undefined)).toEqual({});
  });
  it('writes possession and flat size the CRM way', () => {
    expect(normalisePossession('RTMI')).toBe('Possession Received');
    expect(normalisePossession('15-03-2027')).toBe('2027-03-15');
    expect(normalisePossession('3-6 months')).toBe('3-6 months');
    expect(normaliseProjectType('3 bhk')).toBe('3BHK');
    expect(normaliseProjectType('Villa')).toBe('Villa');
  });
});

describe('True Pulse landing page', () => {
  it('reads UTM tags, even with the extra underscores the agency sent', () => {
    const url = 'https://interiorsbydex.com/get-in-touch?__utm_source=google&utm_medium=cpc&utm_campaign=IBD_Home_Interiors&utm_term=Interiors+near+me&utm_content=810495976226&gclid=abc';
    expect(utmFromUrl(url)).toEqual({ source: 'google', medium: 'cpc', campaign: 'IBD_Home_Interiors', term: 'Interiors near me', content: '810495976226' });
    expect(utmFromUrl('https://interiorsbydex.com/')).toEqual({});
  });
});

describe('True Pulse source', () => {
  it('maps common words to the CRM sources', () => {
    expect(matchSource('google', SOURCES)).toEqual({ code: 'GOOGLE_ADS', known: true });
    expect(matchSource('Facebook', SOURCES)).toEqual({ code: 'META_ADS', known: true });
    expect(matchSource('META_ADS', SOURCES)).toEqual({ code: 'META_ADS', known: true });
    expect(matchSource('website', SOURCES)).toEqual({ code: 'WEBSITE', known: true });
  });
  it('files anything else under Other', () => {
    expect(matchSource('email', SOURCES)).toEqual({ code: 'OTHER', known: false });
  });
});
