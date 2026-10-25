import SettingsScreen, { Choice } from './SettingsScreen';

// Admin → Lead Routing & Access (server: lib/leadRouting.ts).

interface Value {
  adLeads: 'CRE' | 'MANUAL';
  qualifiedLeads: 'BL' | 'BL_THEN_DESIGNER' | 'MANUAL';
  visibility: { DESIGNER: 'own' | 'team' | 'all'; CRE: 'own' | 'all'; BL: 'team' | 'all' };
}

export default function LeadRoutingAdmin() {
  return (
    <SettingsScreen<Value>
      path="/lead-routing"
      title="Lead Routing & Access"
      testId="lead-routing-admin"
      intro="Who receives new leads, and which leads each role can open and work on. The Branch Head always sees every lead. Changes apply to the next lead that arrives or moves."
    >
      {(draft, setDraft) => (
        <>
          <div className="bg-white rounded-xl border border-gray-200 p-5 space-y-5">
            <h3 className="text-sm font-semibold text-gray-800">Who receives new leads</h3>
            <Choice name="adLeads" label="Leads from ads, the agency link and imports" value={draft.adLeads}
              onChange={(v) => setDraft({ ...draft, adLeads: v })}
              options={[
                { value: 'CRE', label: 'The next CRE in turn', help: 'The CRE qualifies the lead first.' },
                { value: 'MANUAL', label: 'Nobody — wait for someone to allocate it', help: 'The Branch Head (or anyone with the allocate permission) picks who gets it.' },
              ]} />
            <Choice name="qualifiedLeads" label="When a lead is qualified (reaches MQL)" value={draft.qualifiedLeads}
              onChange={(v) => setDraft({ ...draft, qualifiedLeads: v })}
              options={[
                { value: 'BL', label: 'The next Business Lead in turn; the BL chooses the designer' },
                { value: 'BL_THEN_DESIGNER', label: 'The next Business Lead in turn, and the next designer in that BL\'s team', help: 'The designer starts straight away; the BL still oversees the lead.' },
                { value: 'MANUAL', label: 'Nobody — wait for someone to allocate it' },
              ]} />
          </div>

          <div className="bg-white rounded-xl border border-gray-200 p-5 space-y-5">
            <h3 className="text-sm font-semibold text-gray-800">Which leads each role can open and work on</h3>
            <Choice name="visDesigner" label="Designers" value={draft.visibility.DESIGNER}
              onChange={(v) => setDraft({ ...draft, visibility: { ...draft.visibility, DESIGNER: v } })}
              options={[
                { value: 'own', label: 'Only leads assigned to them' },
                { value: 'team', label: 'Their whole team\'s leads (everyone under the same Business Lead)' },
                { value: 'all', label: 'All leads' },
              ]} />
            <Choice name="visCre" label="CREs" value={draft.visibility.CRE}
              onChange={(v) => setDraft({ ...draft, visibility: { ...draft.visibility, CRE: v } })}
              options={[
                { value: 'own', label: 'Only leads they own or created' },
                { value: 'all', label: 'All leads' },
              ]} />
            <Choice name="visBl" label="Business Leads" value={draft.visibility.BL}
              onChange={(v) => setDraft({ ...draft, visibility: { ...draft.visibility, BL: v } })}
              options={[
                { value: 'team', label: 'Their own team\'s leads' },
                { value: 'all', label: 'All leads' },
              ]} />
          </div>
        </>
      )}
    </SettingsScreen>
  );
}
