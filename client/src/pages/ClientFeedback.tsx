import { MessageSquareText } from 'lucide-react';
import { CLIENT_FEEDBACK_ENTRIES } from '../data/clientFeedbackSnapshot';

const TOPIC_LABELS: Record<string, string> = {
  BUG_REPORT: 'Bug report',
  FEATURE_REQUEST: 'Feature request',
  DESIGN: 'Design',
  CONTENT: 'Content',
  OTHER: 'Other',
};

const TOPIC_CLASSES: Record<string, string> = {
  BUG_REPORT: 'bg-red-50 text-red-700 ring-red-100',
  FEATURE_REQUEST: 'bg-violet-50 text-violet-700 ring-violet-100',
  DESIGN: 'bg-amber-50 text-amber-700 ring-amber-100',
  CONTENT: 'bg-sky-50 text-sky-700 ring-sky-100',
  OTHER: 'bg-stone-100 text-stone-600 ring-stone-200',
};

function formatDate(date: string) {
  return new Intl.DateTimeFormat('en-GB', {
    day: 'numeric',
    month: 'long',
    year: 'numeric',
  }).format(new Date(`${date}T00:00:00Z`));
}

function feedbackContext(page: string) {
  try {
    const path = new URL(page).pathname;
    const section = path.split('/').filter(Boolean)[0];
    const labels: Record<string, string> = {
      dashboard: 'Dashboard',
      pipeline: 'Pipeline',
      leads: 'Lead details',
      reports: 'Reports',
      projects: 'Projects',
      collections: 'Collections',
      calendar: 'Calendar',
      tasks: 'Tasks',
      meetings: 'Meetings',
    };
    return labels[section] ?? (section ? section.replace(/-/g, ' ') : 'CRM');
  } catch {
    return 'CRM';
  }
}

export default function ClientFeedback() {
  return (
    <main className="mx-auto max-w-5xl px-4 py-8 sm:px-6 lg:py-10">
      <header className="rounded-3xl border border-orange-100 bg-gradient-to-br from-[#fffaf7] to-white px-6 py-8 shadow-sm sm:px-9">
        <div className="flex flex-wrap items-start justify-between gap-5">
          <div>
            <div className="mb-4 inline-flex items-center gap-2 rounded-full bg-orange-100 px-3 py-1 text-xs font-bold uppercase tracking-wide text-brand-700">
              <MessageSquareText size={14} />
              Client feedback
            </div>
            <h1 className="text-3xl font-extrabold tracking-tight text-stone-900">Feedback Report</h1>
            <p className="mt-2 max-w-2xl text-sm leading-6 text-stone-600">
              A chronological record of feedback submitted through the application.
            </p>
          </div>
          <div className="rounded-2xl border border-orange-100 bg-white px-4 py-3 text-right shadow-sm">
            <p className="text-2xl font-extrabold text-stone-900">{CLIENT_FEEDBACK_ENTRIES.length}</p>
            <p className="text-xs font-medium text-stone-500">feedback entries</p>
          </div>
        </div>
        <div className="mt-6 text-xs text-stone-500">
          <span className="rounded-full bg-white px-3 py-1.5 ring-1 ring-stone-100">
            Dates shown without times
          </span>
        </div>
      </header>

      <div className="mt-7 space-y-5">
        {CLIENT_FEEDBACK_ENTRIES.map((entry, index) => (
          <article key={entry.id} className="overflow-hidden rounded-2xl border border-stone-200 bg-white shadow-sm">
            <div className="flex flex-wrap items-center justify-between gap-3 border-b border-stone-100 bg-stone-50/70 px-5 py-3.5">
              <div className="flex items-center gap-3">
                <span className="flex h-7 w-7 items-center justify-center rounded-full bg-stone-200 text-xs font-bold text-stone-600">
                  {index + 1}
                </span>
                <time className="text-sm font-semibold text-stone-800">{formatDate(entry.date)}</time>
              </div>
              <span className={`rounded-full px-2.5 py-1 text-[11px] font-bold ring-1 ${TOPIC_CLASSES[entry.topic] ?? TOPIC_CLASSES.OTHER}`}>
                {TOPIC_LABELS[entry.topic] ?? entry.topic}
              </span>
            </div>

            <div className="px-5 py-5 sm:px-6">
              <p className="whitespace-pre-wrap text-sm leading-7 text-stone-700">{entry.comment}</p>
              {entry.screenshots?.length > 0 && (
                <div className="mt-4 flex flex-wrap gap-2">
                  {entry.screenshots.map((screenshot, screenshotIndex) => (
                    <a
                      key={`${entry.id}-screenshot-${screenshotIndex}`}
                      href={screenshot}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="rounded-lg border border-stone-200 bg-stone-50 px-3 py-1.5 text-xs font-semibold text-stone-600 transition-colors hover:border-orange-200 hover:bg-orange-50 hover:text-brand-700"
                    >
                      Open reference {screenshotIndex + 1}
                    </a>
                  ))}
                </div>
              )}
              <p className="mt-4 text-xs font-medium text-stone-500">
                About: <span className="font-semibold text-stone-700">{feedbackContext(entry.page)}</span>
              </p>

            </div>
          </article>
        ))}
      </div>
    </main>
  );
}