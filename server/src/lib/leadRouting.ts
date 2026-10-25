/**
 * Lead routing & access (Admin → Lead Routing & Access).
 *
 * adLeads: where a lead captured from ads/agency/import goes first —
 *   'CRE'    next CRE in turn (today's behaviour), or
 *   'MANUAL' nobody; a Branch Head or CRE allocates it.
 * qualifiedLeads: what happens when a lead is qualified (reaches MQL, or a CRE
 *   creates it already qualified) —
 *   'BL'               next Business Lead in turn; the BL picks the designer (today),
 *   'BL_THEN_DESIGNER' next BL in turn and the next designer in that BL's team,
 *   'MANUAL'           nobody; it waits to be allocated.
 * visibility: which leads each role can open and work on.
 */
import { z } from 'zod';
import { ConfigError, describeIssues, versionedConfig } from './versionedConfig.js';

export type AdLeadRouting = 'CRE' | 'MANUAL';
export type QualifiedLeadRouting = 'BL' | 'BL_THEN_DESIGNER' | 'MANUAL';
export interface LeadVisibility { DESIGNER: 'own' | 'team' | 'all'; CRE: 'own' | 'all'; BL: 'team' | 'all' }
export interface LeadRoutingSettings { adLeads: AdLeadRouting; qualifiedLeads: QualifiedLeadRouting; visibility: LeadVisibility }

export function defaultLeadRouting(): LeadRoutingSettings {
  return { adLeads: 'CRE', qualifiedLeads: 'BL', visibility: { DESIGNER: 'own', CRE: 'own', BL: 'team' } };
}

const schema = z.object({
  adLeads: z.enum(['CRE', 'MANUAL']),
  qualifiedLeads: z.enum(['BL', 'BL_THEN_DESIGNER', 'MANUAL']),
  visibility: z.object({
    DESIGNER: z.enum(['own', 'team', 'all']),
    CRE: z.enum(['own', 'all']),
    BL: z.enum(['team', 'all']),
  }).strict(),
}).strict();

export const leadRoutingConfig = versionedConfig<LeadRoutingSettings>({
  key: 'lead_routing_v1',
  action: 'LEAD_ROUTING',
  noun: 'the lead routing and access settings',
  defaults: defaultLeadRouting,
  merge: (saved) => {
    const d = defaultLeadRouting();
    return { ...d, ...(saved ?? {}), visibility: { ...d.visibility, ...(saved?.visibility ?? {}) } };
  },
  validate: (raw) => {
    const parsed = schema.safeParse(raw);
    if (!parsed.success) {
      throw new ConfigError(400, 'The lead routing settings could not be saved', describeIssues(parsed.error.issues, {
        adLeads: 'New leads from ads', qualifiedLeads: 'Qualified leads', visibility: 'Who sees which leads',
        DESIGNER: 'Designers', CRE: 'CREs', BL: 'Business Leads',
      }));
    }
    return parsed.data;
  },
});

export async function getLeadRouting(): Promise<LeadRoutingSettings> {
  return leadRoutingConfig.get();
}
