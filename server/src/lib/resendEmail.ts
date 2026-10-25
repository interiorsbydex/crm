export interface ResendEmailPayload {
  to: string;
  subject: string;
  html: string;
  from: string;
  cc?: string[];
  attachments?: { filename: string; content: string; contentType?: string }[];
}

export interface ResendSendResult {
  id: string;
}

/**
 * Send through the Dex Resend account using the server-side API key.
 * The key is supplied through Replit Secrets and is never exposed to the
 * browser or included in an invite response.
 */
export async function sendViaResend(payload: ResendEmailPayload): Promise<ResendSendResult> {
  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) {
    throw new Error('RESEND_API_KEY is not configured');
  }

  const response = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      from: payload.from,
      to: payload.to,
      subject: payload.subject,
      html: payload.html,
      ...(payload.cc?.length ? { cc: payload.cc } : {}),
      ...(payload.attachments?.length
        ? { attachments: payload.attachments.map((a) => ({ filename: a.filename, content: a.content })) }
        : {}),
    }),
  });

  if (!response.ok) {
    const details = await response.text().catch(() => '');
    throw new Error(`Resend returned ${response.status}${details ? `: ${details}` : ''}`);
  }

  const result = await response.json().catch(() => null) as { id?: unknown } | null;
  if (!result || typeof result.id !== 'string' || !result.id) {
    throw new Error('Resend accepted the email but did not return a message ID');
  }

  return { id: result.id };
}