/** Saves rows (one object per line, keys become the headings) as a CSV file the user can open in Excel. */
export function downloadCsv(filename: string, rows: Record<string, unknown>[]): void {
  const headers = rows.length ? Object.keys(rows[0]) : [];
  const cell = (v: unknown) => {
    const s = v === null || v === undefined ? '' : String(v);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const text = [headers.join(','), ...rows.map((r) => headers.map((h) => cell(r[h])).join(','))].join('\n');
  const url = URL.createObjectURL(new Blob(['﻿' + text], { type: 'text/csv;charset=utf-8' }));
  const a = document.createElement('a');
  a.href = url; a.download = filename.endsWith('.csv') ? filename : `${filename}.csv`; a.click();
  URL.revokeObjectURL(url);
}
