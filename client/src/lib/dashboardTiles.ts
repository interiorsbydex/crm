/**
 * Every configurable dashboard tile (Admin → Dashboards). Each entry must match a
 * <Tile id=…> on its dashboard; lib/dashboardLayout.tsx warns in development if not.
 * `section` groups tiles the way they sit on screen; order is changed within a section
 * (the Designer dashboard's "Sections" can also be reordered among themselves).
 */
export interface DashboardTileDef { id: string; dashboard: string; section: string; label: string }

export const DASHBOARD_NAMES: Record<string, string> = {
  bh: 'Branch Head dashboard',
  bl: 'Business Lead dashboard',
  blTeam: 'Business Lead — team panel',
  designer: 'Designer dashboard',
  cre: 'CRE dashboard',
  reports: 'Reports page',
};

export const DASHBOARD_TILES: DashboardTileDef[] = [
  // Branch Head dashboard
  { id: 'bh.salesPipeline', dashboard: 'bh', section: 'Key numbers', label: 'Sales Pipeline' },
  { id: 'bh.activeLeads', dashboard: 'bh', section: 'Key numbers', label: 'Active Leads' },
  { id: 'bh.activeProjects', dashboard: 'bh', section: 'Key numbers', label: 'Active Projects' },
  { id: 'bh.inDelivery', dashboard: 'bh', section: 'Key numbers', label: 'In Delivery' },
  { id: 'bh.collectedThisMonth', dashboard: 'bh', section: 'Key numbers', label: 'Collected This Month' },
  { id: 'bh.outstanding', dashboard: 'bh', section: 'Key numbers', label: 'Outstanding' },
  { id: 'bh.needsAttention', dashboard: 'bh', section: 'Key numbers', label: 'Needs Attention' },
  { id: 'bh.npsScore', dashboard: 'bh', section: 'Key numbers', label: 'NPS Score' },
  { id: 'bh.obProgress', dashboard: 'bh', section: 'Progress', label: 'OB Progress' },
  { id: 'bh.revenueGenerated', dashboard: 'bh', section: 'Progress', label: 'Revenue Generated' },
  { id: 'bh.npsByStage', dashboard: 'bh', section: 'Client satisfaction', label: 'Client Satisfaction by Stage' },
  { id: 'bh.pipelineFunnel', dashboard: 'bh', section: 'Charts', label: 'Pipeline Funnel' },
  { id: 'bh.leadSources', dashboard: 'bh', section: 'Charts', label: 'Lead Sources' },
  { id: 'bh.stageConversion', dashboard: 'bh', section: 'Conversion and SLA', label: 'Stage Conversion' },
  { id: 'bh.slaBreaches', dashboard: 'bh', section: 'Conversion and SLA', label: 'SLA Breaches' },
  { id: 'bh.todaysActivity', dashboard: 'bh', section: 'Activity', label: 'Today\'s Activity' },
  // Business Lead dashboard
  { id: 'bl.medal', dashboard: 'bl', section: 'Medal', label: 'Medal' },
  { id: 'bl.salesPipeline', dashboard: 'bl', section: 'Key numbers', label: 'Sales Pipeline' },
  { id: 'bl.inDelivery', dashboard: 'bl', section: 'Key numbers', label: 'In Delivery' },
  { id: 'bl.collectedThisMonth', dashboard: 'bl', section: 'Key numbers', label: 'Collected This Month' },
  { id: 'bl.outstanding', dashboard: 'bl', section: 'Key numbers', label: 'Outstanding' },
  { id: 'bl.needsAttention', dashboard: 'bl', section: 'Key numbers', label: 'Needs Attention' },
  { id: 'bl.nps', dashboard: 'bl', section: 'Key numbers', label: 'NPS' },
  { id: 'bl.npsByStage', dashboard: 'bl', section: 'Client satisfaction', label: 'Client Satisfaction by Stage' },
  { id: 'bl.phaseLoad', dashboard: 'bl', section: 'Delivery', label: 'Phase Load' },
  { id: 'bl.needsAttentionList', dashboard: 'bl', section: 'Delivery', label: 'Needs Attention (projects list)' },
  { id: 'bl.collectionsDue', dashboard: 'bl', section: 'Delivery', label: 'Collections Due' },
  // Business Lead — team panel
  { id: 'blTeam.announcements', dashboard: 'blTeam', section: 'Top', label: 'Announcements & design inspiration' },
  { id: 'blTeam.teamTable', dashboard: 'blTeam', section: 'Team', label: 'Team by designer' },
  // Designer dashboard
  { id: 'designer.announcements', dashboard: 'designer', section: 'Top', label: 'Announcements & design inspiration' },
  { id: 'designer.activeLeads', dashboard: 'designer', section: 'Key numbers', label: 'Active Leads' },
  { id: 'designer.ppDone', dashboard: 'designer', section: 'Key numbers', label: 'PP Done' },
  { id: 'designer.bookingDone', dashboard: 'designer', section: 'Key numbers', label: 'Booking Done' },
  { id: 'designer.creditsEarned', dashboard: 'designer', section: 'Key numbers', label: 'Credits Earned' },
  { id: 'designer.leadProgression', dashboard: 'designer', section: 'Sections', label: 'Lead Progression' },
  { id: 'designer.pipelinePotential', dashboard: 'designer', section: 'Sections', label: 'Pipeline Potential' },
  { id: 'designer.conversionInsights', dashboard: 'designer', section: 'Insights', label: 'Conversion Insights' },
  { id: 'designer.todaysFocus', dashboard: 'designer', section: 'Insights', label: 'Today\'s Focus' },
  { id: 'designer.teamLeaderboard', dashboard: 'designer', section: 'Sections', label: 'Team Leaderboard' },
  { id: 'designer.attentionRequired', dashboard: 'designer', section: 'Alerts', label: 'Attention Required' },
  { id: 'designer.recentNotifications', dashboard: 'designer', section: 'Alerts', label: 'Recent Notifications' },
  { id: 'designer.clientHealth', dashboard: 'designer', section: 'Sections', label: 'Client Health' },
  { id: 'designer.monthlyMedal', dashboard: 'designer', section: 'Sections', label: 'Monthly Medal' },
  // CRE dashboard
  { id: 'cre.atEffectiveLead', dashboard: 'cre', section: 'Key numbers', label: 'At Effective Lead' },
  { id: 'cre.mqlAwaitingBl', dashboard: 'cre', section: 'Key numbers', label: 'MQL — Awaiting BL' },
  { id: 'cre.mqlBlAssigned', dashboard: 'cre', section: 'Key numbers', label: 'MQL — BL Assigned' },
  { id: 'cre.pushedBack', dashboard: 'cre', section: 'Key numbers', label: 'Pushed Back' },
  { id: 'cre.elSection', dashboard: 'cre', section: 'Lead lists', label: 'Effective Lead — Pending Qualification' },
  { id: 'cre.mqlAwaitingSection', dashboard: 'cre', section: 'Lead lists', label: 'MQL — Awaiting BL Allocation' },
  { id: 'cre.mqlAssignedSection', dashboard: 'cre', section: 'Lead lists', label: 'MQL — BL Assigned' },
  // Reports page (sections show only to the roles that already see them)
  { id: 'reports.incentiveOverview', dashboard: 'reports', section: 'Designer view', label: 'Incentive overview' },
  { id: 'reports.npsAnalytics', dashboard: 'reports', section: 'Designer view', label: 'NPS analytics' },
  { id: 'reports.salesPipeline', dashboard: 'reports', section: 'Main sections', label: 'Sales pipeline' },
  { id: 'reports.designerPerformance', dashboard: 'reports', section: 'Main sections', label: 'Designer performance' },
  { id: 'reports.monthlyTrend', dashboard: 'reports', section: 'Main sections', label: 'Monthly trend' },
  { id: 'reports.offerPerformance', dashboard: 'reports', section: 'Main sections', label: 'Offer performance' },
  { id: 'reports.campaignPerformance', dashboard: 'reports', section: 'Main sections', label: 'Campaign performance' },
  { id: 'reports.meetingPerformance', dashboard: 'reports', section: 'Main sections', label: 'Meeting performance' },
  { id: 'reports.inactiveLeads', dashboard: 'reports', section: 'Main sections', label: 'Inactive leads' },
  { id: 'reports.credits', dashboard: 'reports', section: 'Main sections', label: 'Designer credits / BL & Team Credits' },
  { id: 'reports.blPerformance', dashboard: 'reports', section: 'Additional reports', label: 'BL performance' },
  { id: 'reports.salesCycle', dashboard: 'reports', section: 'Additional reports', label: 'Sales cycle' },
  { id: 'reports.timelinePerformance', dashboard: 'reports', section: 'Additional reports', label: 'Timeline performance' },
  { id: 'reports.leadAging', dashboard: 'reports', section: 'Additional reports', label: 'Lead aging' },
  { id: 'reports.conversionDetail', dashboard: 'reports', section: 'Additional reports', label: 'Conversion funnel detail' },
  { id: 'reports.clientHealth', dashboard: 'reports', section: 'Designer view — bottom', label: 'Client health' },
];

// ── Report tabs (the tabs inside the Designer / BL report blocks on the Reports page) ──────────────────────────
/** The first row of each block is the block's heading: untick it to hide the whole block, or type a new heading. Tab names: renaming "My Performance" renames it for Designers, BLs and Branch Heads alike. Tab ids are stable per block: "dr" = Designer Reports / BL Reports / My Reports, "ba" = BL & Admin Reports (Branch Head). */
export function reportTabId(block: 'dr' | 'ba', key: string): string {
  return `reports.${block}${key.split('-').map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join('')}`;
}
export const REPORT_BLOCK_IDS = { dr: 'reports.drBlock', ba: 'reports.baBlock' } as const;

const DR_TAB_NAMES: [string, string][] = [
  ['my-performance', 'My Performance'], ['my-lead-funnel', 'My Lead Funnel'], ['my-commitment', 'My Commitment'],
  ['my-trends-sales', 'Trends — Sales'], ['task-call-activity', 'Task / Call Activity'],
  ['bl-pipeline', 'BL Pipeline'], ['bl-conversion', 'BL Conversion'], ['discount-metrics', 'Discount Metrics'],
  ['designer-pipeline', 'Designer Pipeline'], ['designer-conversion', 'Designer Conversion'], ['designer-discount-metrics', 'Designer Discount Metrics'],
];
const BA_TAB_NAMES: [string, string][] = [
  ['bl-performance', 'BL Performance'], ['bl-pipeline', 'BL Pipeline'], ['bl-conversion', 'BL Conversion'], ['discount-metrics', 'Discount Metrics'],
  ['team-meetings', 'Team Meetings'], ['company-lead-summary', 'Company Lead Summary'], ['company-pipeline', 'Company Pipeline'],
  ['designer-performance-all', 'Designer Performance (All)'], ['bl-performance-all', 'BL Performance (All)'], ['source-campaign', 'Source & Campaign'],
  ['inactive-leads', 'Inactive Leads'], ['lead-aging', 'Lead Aging'], ['trend', 'Trend'], ['offer-performance', 'Offer Performance'],
];
DASHBOARD_TILES.push(
  { id: REPORT_BLOCK_IDS.dr, dashboard: 'reports', section: 'Report tabs — Designer Reports / BL Reports / My Reports', label: 'Designer Reports' },
  ...DR_TAB_NAMES.map(([key, label]) => ({ id: reportTabId('dr', key), dashboard: 'reports', section: 'Report tabs — Designer Reports / BL Reports / My Reports', label })),
  { id: REPORT_BLOCK_IDS.ba, dashboard: 'reports', section: 'Report tabs — BL & Admin Reports (Branch Head)', label: 'BL & Admin Reports' },
  ...BA_TAB_NAMES.map(([key, label]) => ({ id: reportTabId('ba', key), dashboard: 'reports', section: 'Report tabs — BL & Admin Reports (Branch Head)', label })),
);
