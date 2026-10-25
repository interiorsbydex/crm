import DatePicker from 'react-datepicker';
import 'react-datepicker/dist/react-datepicker.css';

/**
 * Calendar + clock picker replacements for native <input type="date">,
 * type="time">, and type="datetime-local">.
 *
 * These preserve the exact same string value contract as the native inputs
 * they replace ("YYYY-MM-DD", "HH:MM", "YYYY-MM-DDTHH:mm") so every existing
 * onChange handler, IST-conversion helper (dateFormat.ts), and server
 * payload stays untouched — only the input widget itself changes. Values are
 * built from local Date components (never `new Date(string)`, which parses
 * date-only strings as UTC), matching how the native inputs behaved.
 */

const baseClassName =
  'w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-brand-400';

function pad(n: number) {
  return String(n).padStart(2, '0');
}

function parseDateOnly(value: string | undefined | null): Date | null {
  if (!value) return null;
  const [y, m, d] = value.split('-').map(Number);
  if (!y || !m || !d) return null;
  return new Date(y, m - 1, d);
}

function formatDateOnly(date: Date): string {
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

function parseTimeOnly(value: string | undefined | null): Date | null {
  if (!value) return null;
  const [h, m] = value.split(':').map(Number);
  if (h === undefined || m === undefined || Number.isNaN(h) || Number.isNaN(m)) return null;
  const d = new Date();
  d.setHours(h, m, 0, 0);
  return d;
}

function formatTimeOnly(date: Date): string {
  return `${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function parseDateTimeLocal(value: string | undefined | null): Date | null {
  if (!value) return null;
  const [datePart, timePart] = value.split('T');
  const [y, m, d] = (datePart ?? '').split('-').map(Number);
  const [h, min] = (timePart ?? '00:00').split(':').map(Number);
  if (!y || !m || !d) return null;
  return new Date(y, m - 1, d, h || 0, min || 0);
}

function formatDateTimeLocal(date: Date): string {
  return `${formatDateOnly(date)}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

interface DateInputProps {
  value: string | undefined | null;
  onChange: (value: string) => void;
  min?: string;
  max?: string;
  required?: boolean;
  className?: string;
  placeholderText?: string;
  id?: string;
  disabled?: boolean;
}

/** Calendar-only picker. Value/onChange use "YYYY-MM-DD" strings. */
export function DateInput({ value, onChange, min, max, required, className, placeholderText, id, disabled }: DateInputProps) {
  return (
    <DatePicker
      id={id}
      selected={parseDateOnly(value)}
      onChange={(date: Date | null) => onChange(date ? formatDateOnly(date) : '')}
      minDate={parseDateOnly(min) ?? undefined}
      maxDate={parseDateOnly(max) ?? undefined}
      dateFormat="dd MMM yyyy"
      placeholderText={placeholderText ?? 'Select date…'}
      className={className ?? baseClassName}
      wrapperClassName="w-full"
      autoComplete="off"
      required={required}
      isClearable={!required}
      disabled={disabled}
    />
  );
}

interface TimeInputProps {
  value: string | undefined | null;
  onChange: (value: string) => void;
  min?: string;
  required?: boolean;
  className?: string;
  placeholderText?: string;
  id?: string;
  disabled?: boolean;
}

/** Clock-only picker. Value/onChange use "HH:MM" (24h) strings. */
export function TimeInput({ value, onChange, min, required, className, placeholderText, id, disabled }: TimeInputProps) {
  return (
    <DatePicker
      id={id}
      selected={parseTimeOnly(value)}
      onChange={(date: Date | null) => onChange(date ? formatTimeOnly(date) : '')}
      showTimeSelect
      showTimeSelectOnly
      timeIntervals={15}
      timeCaption="Time"
      dateFormat="h:mm aa"
      minDate={parseTimeOnly(min) ?? undefined}
      placeholderText={placeholderText ?? 'Select time…'}
      className={className ?? baseClassName}
      wrapperClassName="w-full"
      autoComplete="off"
      required={required}
      isClearable={!required}
      disabled={disabled}
    />
  );
}

interface DateTimeInputProps {
  value: string | undefined | null;
  onChange: (value: string) => void;
  min?: string;
  max?: string;
  required?: boolean;
  className?: string;
  placeholderText?: string;
  id?: string;
  disabled?: boolean;
}

/** Calendar + clock picker. Value/onChange use "YYYY-MM-DDTHH:mm" strings. */
export function DateTimeInput({ value, onChange, min, max, required, className, placeholderText, id, disabled }: DateTimeInputProps) {
  return (
    <DatePicker
      id={id}
      selected={parseDateTimeLocal(value)}
      onChange={(date: Date | null) => onChange(date ? formatDateTimeLocal(date) : '')}
      minDate={parseDateTimeLocal(min) ?? undefined}
      maxDate={parseDateTimeLocal(max) ?? undefined}
      showTimeSelect
      timeIntervals={15}
      dateFormat="dd MMM yyyy, h:mm aa"
      placeholderText={placeholderText ?? 'Select date & time…'}
      className={className ?? baseClassName}
      wrapperClassName="w-full"
      autoComplete="off"
      required={required}
      isClearable={!required}
      disabled={disabled}
    />
  );
}
