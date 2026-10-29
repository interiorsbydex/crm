import { describe, expect, it } from 'vitest';
import { projectTypeGroup, projectTypeGroupLabel, projectTypeWhere } from './projectTypeGroup.js';

describe('projectTypeGroup', () => {
  it('groups by the first word', () => {
    expect(projectTypeGroup('Apartment - 3bhk')).toBe('Apartment');
    expect(projectTypeGroup('apartment 2BHK')).toBe('Apartment');
    expect(projectTypeGroup('Villa')).toBe('Villa');
    expect(projectTypeGroup('Rent - 2bhk')).toBe('Rent');
  });
  it('keeps Independent House together', () => {
    expect(projectTypeGroup('Independent House - 4bhk')).toBe('Independent House');
    expect(projectTypeGroup('independent house')).toBe('Independent House');
  });
  it('treats empty and size-only values as blank', () => {
    expect(projectTypeGroup(null)).toBe('');
    expect(projectTypeGroup('  ')).toBe('');
    expect(projectTypeGroup('5bhk')).toBe('');
    expect(projectTypeGroupLabel('')).toBe('(blank)');
  });
});

describe('projectTypeWhere', () => {
  it('matches a plain word by its start, case-insensitively', () => {
    expect(projectTypeWhere('Apartment')).toEqual({ projectType: { startsWith: 'Apartment', mode: 'insensitive' } });
    expect(projectTypeWhere('Independent House')).toEqual({ projectType: { startsWith: 'Independent House', mode: 'insensitive' } });
  });
  it('keeps an exact match for sized values', () => {
    expect(projectTypeWhere('2BHK')).toEqual({ projectType: { equals: '2BHK', mode: 'insensitive' } });
  });
  it('(blank) matches empty and digit-led values', () => {
    const w = projectTypeWhere('(blank)') as { OR: unknown[] };
    expect(w.OR).toContainEqual({ projectType: null });
    expect(w.OR).toContainEqual({ projectType: '' });
    expect(w.OR).toContainEqual({ projectType: { startsWith: '5' } });
  });
});
