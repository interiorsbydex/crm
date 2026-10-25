import type { ReactNode } from 'react';
import SettingsScreen from './SettingsScreen';
import { loadFormulas, type Formulas } from '../../lib/formulas';

// Admin → Formulas (server: lib/formulaSettings.ts).

const CARD = 'bg-white rounded-xl border border-gray-200 p-5 space-y-3';
const INPUT = 'w-24 rounded border border-gray-200 px-2 py-1 text-sm';

function Num({ label, value, onChange, suffix, min = 0, max }: { label: ReactNode; value: number; onChange: (n: number) => void; suffix?: string; min?: number; max?: number }) {
  return (
    <label className="flex flex-wrap items-center gap-2 text-sm text-gray-700">
      <span className="min-w-[260px]">{label}</span>
      <input type="number" className={INPUT} value={value} min={min} max={max}
        onChange={(e) => onChange(e.target.value === '' ? 0 : Number(e.target.value))} />
      {suffix && <span className="text-xs text-gray-400">{suffix}</span>}
    </label>
  );
}

export default function FormulasAdmin() {
  return (
    <SettingsScreen<Formulas>
      path="/formulas"
      title="Formulas"
      testId="formulas-admin"
      onSaved={() => { loadFormulas().catch(() => {}); }}
      intro={<>The numbers behind medals, scores, the booking forecast and the health labels. Every screen and report uses these straight away. What counts as a booking, and its amount, is not changed here: it always follows the completed OBM → DIP checklist and the agreed target value, which credits and targets depend on.</>}
    >
      {(f, set) => (
        <>
          <div className={CARD}>
            <h3 className="text-sm font-semibold text-gray-800">Monthly medals</h3>
            <p className="text-xs text-gray-500">The score a person needs in the cycle for each medal.</p>
            <Num label="Gold from" suffix="%" value={f.medals.gold} onChange={(n) => set({ ...f, medals: { ...f.medals, gold: n } })} />
            <Num label="Silver from" suffix="%" value={f.medals.silver} onChange={(n) => set({ ...f, medals: { ...f.medals, silver: n } })} />
            <Num label="Bronze from" suffix="%" value={f.medals.bronze} onChange={(n) => set({ ...f, medals: { ...f.medals, bronze: n } })} />
          </div>

          <div className={CARD}>
            <h3 className="text-sm font-semibold text-gray-800">Scores</h3>
            <Num label={<>Sales % — share from booking % <span className="text-xs text-gray-400">(the rest from PO %: {100 - f.salesPctBookingWeight}%)</span></>}
              suffix="%" max={100} value={f.salesPctBookingWeight} onChange={(n) => set({ ...f, salesPctBookingWeight: n })} />
            <Num label={<>Designer medal score — share from Sales % <span className="text-xs text-gray-400">(the rest from Design DIP %: {100 - f.designerMedalSalesWeight}%)</span></>}
              suffix="%" max={100} value={f.designerMedalSalesWeight} onChange={(n) => set({ ...f, designerMedalSalesWeight: n })} />
            <p className="pt-2 text-xs text-gray-500">Overall performance score: how much each part counts (0 leaves it out; equal numbers mean equal weight).</p>
            <Num label="Conversion %" max={10} value={f.performanceWeights.conversion} onChange={(n) => set({ ...f, performanceWeights: { ...f.performanceWeights, conversion: n } })} />
            <Num label="Target achievement %" max={10} value={f.performanceWeights.targetAchievement} onChange={(n) => set({ ...f, performanceWeights: { ...f.performanceWeights, targetAchievement: n } })} />
            <Num label="Average booking value" max={10} value={f.performanceWeights.averageBookingValue} onChange={(n) => set({ ...f, performanceWeights: { ...f.performanceWeights, averageBookingValue: n } })} />
          </div>

          <div className={CARD}>
            <h3 className="text-sm font-semibold text-gray-800">Intent tiers (booking forecast and pipeline potential)</h3>
            <Num label="High intent from" suffix="stars" min={1} max={5} value={f.intentTiers.highFrom} onChange={(n) => set({ ...f, intentTiers: { ...f.intentTiers, highFrom: n } })} />
            <Num label="Medium intent from" suffix="stars (below this is low intent)" min={1} max={5} value={f.intentTiers.mediumFrom} onChange={(n) => set({ ...f, intentTiers: { ...f.intentTiers, mediumFrom: n } })} />
          </div>

          <div className={CARD}>
            <h3 className="text-sm font-semibold text-gray-800">Health and activity</h3>
            <Num label="Contact health turns amber after" suffix="days without a completed call or meeting" min={1} value={f.contactHealth.warningDays} onChange={(n) => set({ ...f, contactHealth: { ...f.contactHealth, warningDays: n } })} />
            <Num label="Contact health turns red after" suffix="days" min={1} value={f.contactHealth.highRiskDays} onChange={(n) => set({ ...f, contactHealth: { ...f.contactHealth, highRiskDays: n } })} />
            <Num label="Client details: Healthy from" suffix="% filled" min={1} max={100} value={f.completeness.healthyFrom} onChange={(n) => set({ ...f, completeness: { ...f.completeness, healthyFrom: n } })} />
            <Num label="Client details: At Risk from" suffix="% filled (below is Critical)" max={100} value={f.completeness.atRiskFrom} onChange={(n) => set({ ...f, completeness: { ...f.completeness, atRiskFrom: n } })} />
            <Num label="Reports: fast onboarding is within" suffix="days of MQL" min={1} value={f.fastOnboardingDays} onChange={(n) => set({ ...f, fastOnboardingDays: n })} />
            <Num label="Reports: 'no activity' after" suffix="days without a completed activity" min={1} value={f.noActivityDays} onChange={(n) => set({ ...f, noActivityDays: n })} />
          </div>
        </>
      )}
    </SettingsScreen>
  );
}
