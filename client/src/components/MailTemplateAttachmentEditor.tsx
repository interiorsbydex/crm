import { useState } from 'react';
import toast from 'react-hot-toast';
import { uploadFile } from '../lib/api';

export interface MailTemplateAttachment {
  storagePath: string;
  name: string;
  size: number;
}

export default function MailTemplateAttachmentEditor({ attachments, onChange, onBusyChange, disabled }: {
  attachments: MailTemplateAttachment[];
  onChange: (files: MailTemplateAttachment[]) => void;
  onBusyChange: (busy: boolean) => void;
  disabled?: boolean;
}) {
  const [uploading, setUploading] = useState(false);
  const upload = async (file: File) => {
    setUploading(true);
    onBusyChange(true);
    try {
      const form = new FormData();
      form.append('file', file);
      const result = await uploadFile<{ attachment: MailTemplateAttachment }>('/admin/mail-templates/OB_OBM_WELCOME/attachments/upload', form);
      onChange([...attachments, result.attachment]);
      toast.success('Document uploaded. Click Save to use it in welcome emails.');
    } catch (error: any) {
      toast.error(error.message ?? 'Document upload failed');
    } finally {
      setUploading(false);
      onBusyChange(false);
    }
  };
  return (
    <div className="rounded-lg border border-gray-200 p-3">
      <p className="text-xs font-semibold text-gray-700">Automatic welcome documents</p>
      <p className="mt-1 text-xs text-gray-500">Upload approved documents, then click Save. Changes apply to future emails; previously sent copies are unchanged. PDF, DOCX, PNG or JPG; 4 MB each, 20 MB total.</p>
      {attachments.length === 0 && <p className="mt-2 text-xs text-amber-700">No automatic documents configured. Welcome emails currently have no automatic attachments.</p>}
      <ul className="mt-2 space-y-1">
        {attachments.map((file) => (
          <li key={file.storagePath} className="flex items-center justify-between gap-3 text-xs text-gray-600">
            <span>{file.name} ({Math.ceil(file.size / 1024)} KB)</span>
            <button type="button" disabled={disabled || uploading} onClick={() => onChange(attachments.filter((item) => item.storagePath !== file.storagePath))} className="text-red-600 disabled:opacity-50">Remove</button>
          </li>
        ))}
      </ul>
      <label className="mt-3 block text-xs text-gray-600">
        {uploading ? 'Uploading…' : 'Add document'}
        <input type="file" accept=".pdf,.docx,.png,.jpg,.jpeg" disabled={disabled || uploading || attachments.length >= 10}
          onChange={(event) => { const file = event.currentTarget.files?.[0]; event.currentTarget.value = ''; if (file) void upload(file); }}
          className="mt-1 block text-xs" />
      </label>
    </div>
  );
}
