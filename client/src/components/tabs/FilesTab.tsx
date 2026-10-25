import { useState, useEffect, useCallback, useRef } from 'react';
import { Upload, FileText, Download, ChevronDown, ChevronRight, Loader2, Paperclip } from 'lucide-react';
import { api, uploadFile } from '../../lib/api';
import toast from 'react-hot-toast';

interface LeadFile {
  id: string;
  leadId: string;
  stage: string;
  fileType: string;
  fileName: string;
  storagePath: string;
  signedUrl?: string;
  createdAt: string;
  uploadedBy: { id: string; name: string };
}

interface Props {
  leadId: string;
  currentStage: string;
  /** Legacy floor plan URL set directly on the Lead record (pre-LeadFile-system
   * uploads, or leads created via webhook). If set and no FLOOR_PLAN LeadFile
   * exists yet, the relevant EL/MQL/DQL folder shows it as satisfied instead
   * of falsely flagging it as missing (task #39). */
  floorPlanUrl?: string | null;
  isLocked?: boolean;
  /** Lets the lead-detail sidebar refresh its latest-quote summary immediately
   * after a quotation file is added. */
  onFilesChanged?: () => void | Promise<void>;
}

// EFFECTIVE_LEAD/HANDED_OVER kept as legacy bookends so currentIdx math still
// works correctly for pre-existing leads still on those stages.
const STAGE_ORDER = [
  'EFFECTIVE_LEAD', 'MQL', 'DQL', 'PROPOSAL_READY', 'PROPOSAL_PRESENTED',
  'PROPOSAL_DISCUSSION', 'ONBOARDING', 'ONBOARDING_MEETING', 'DESIGN_IN_PROGRESS', 'HANDED_OVER',
];
const STAGE_LABELS: Record<string, string> = {
  EFFECTIVE_LEAD: 'Effective Lead', MQL: 'MQL', DQL: 'DQL',
  PROPOSAL_READY: 'Proposal Ready', PROPOSAL_PRESENTED: 'Proposal Presented',
  PROPOSAL_DISCUSSION: 'PD (Pitch Discussion)',
  ONBOARDING: 'Onboarding', ONBOARDING_MEETING: 'Onboarding Meeting',
  DESIGN_IN_PROGRESS: 'Design in Progress', HANDED_OVER: 'Handed Over',
};

/** Upload types and their PDF-only rule come from Admin → Document Types. */
interface DocumentType {
  key: string;
  label: string;
  pdfOnly: boolean;
  builtIn: boolean;
  active: boolean;
}

/** One required-file badge, evaluated server-side by the stage-rules engine. */
interface RequiredFile {
  label: string;
  satisfied: boolean;
  source: 'stageRule' | 'checklist';
}

const ALLOWED_EXTS = '.pdf,.jpg,.jpeg,.png,.webp,.ppt,.pptx,.doc,.docx,.xls,.xlsx';

function isPdfFile(file: File): boolean {
  return file.type === 'application/pdf' && file.name.toLowerCase().endsWith('.pdf');
}

function fmtDate(iso: string) {
  return new Date(iso).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: '2-digit' });
}

function fileIcon(fileName: string) {
  const ext = fileName.split('.').pop()?.toLowerCase() ?? '';
  if (['jpg', 'jpeg', 'png', 'webp'].includes(ext)) return '🖼';
  if (ext === 'pdf') return '📄';
  if (['ppt', 'pptx'].includes(ext)) return '📊';
  if (['doc', 'docx'].includes(ext)) return '📝';
  if (['xls', 'xlsx'].includes(ext)) return '📈';
  return '📎';
}

interface StageFolder {
  stage: string;
  files: LeadFile[];
  requiredGroups: RequiredFile[];
  hasRequired: boolean;
}

export default function FilesTab({ leadId, currentStage, isLocked, onFilesChanged }: Props) {
  const [files, setFiles] = useState<LeadFile[]>([]);
  const [docTypes, setDocTypes] = useState<DocumentType[]>([]);
  const [requirements, setRequirements] = useState<Record<string, RequiredFile[]>>({});
  const [loading, setLoading] = useState(true);
  const [openFolders, setOpenFolders] = useState<Record<string, boolean>>({});
  const [uploadState, setUploadState] = useState<Record<string, boolean>>({});
  const [showUploadForm, setShowUploadForm] = useState<string | null>(null);
  const [uploadFileType, setUploadFileType] = useState('');
  const [selectedFile, setSelectedFile] = useState<File | null>(null);
  const fileInputRefs = useRef<Record<string, HTMLInputElement | null>>({});

  const currentIdx = STAGE_ORDER.indexOf(currentStage);

  const loadFiles = useCallback(async () => {
    setLoading(true);
    try {
      const [{ files: raw }, { folders }] = await Promise.all([
        api.get<{ files: LeadFile[] }>(`/leads/${leadId}/files`),
        api.get<{ folders: Record<string, RequiredFile[]> }>(`/leads/${leadId}/files/requirements`),
      ]);
      setFiles(raw);
      setRequirements(folders);
    } catch {
      toast.error('Could not load files');
    } finally {
      setLoading(false);
    }
  }, [leadId]);

  useEffect(() => {
    loadFiles();
  }, [loadFiles]);

  useEffect(() => {
    api.get<{ types: DocumentType[] }>('/config/document-types')
      .then((d) => setDocTypes(d.types))
      .catch(() => toast.error('Could not load document types'));
  }, []);

  const docTypeLabel = (key: string) => docTypes.find((t) => t.key === key)?.label ?? key;
  const isPdfOnly = (key: string) => !!docTypes.find((t) => t.key === key)?.pdfOnly;

  // Auto-open the current stage folder and any with files
  useEffect(() => {
    if (!files.length && !currentStage) return;
    const initial: Record<string, boolean> = {};
    initial[currentStage] = true;
    for (const f of files) initial[f.stage] = true;
    setOpenFolders((prev) => ({ ...initial, ...prev }));
  }, [currentStage, files]);

  const handleUpload = async (stage: string) => {
    if (!selectedFile || !uploadFileType) {
      toast.error('Select a file type and a file');
      return;
    }
    if (isPdfOnly(uploadFileType) && !isPdfFile(selectedFile)) {
      toast.error(`${docTypeLabel(uploadFileType)} must be uploaded as a PDF file`);
      return;
    }
    setUploadState((s) => ({ ...s, [stage]: true }));
    try {
      const fd = new FormData();
      fd.append('file', selectedFile);
      fd.append('stage', stage);
      fd.append('fileType', uploadFileType);

      await uploadFile(`/leads/${leadId}/files`, fd);
      toast.success('File uploaded');
      setShowUploadForm(null);
      setSelectedFile(null);
      setUploadFileType('');
      await loadFiles();
      await onFilesChanged?.();
    } catch (e: any) {
      toast.error(e.message ?? 'Upload failed');
    } finally {
      setUploadState((s) => ({ ...s, [stage]: false }));
    }
  };

  // Stage skips are gated by files in folders the lead has not technically
  // entered yet. A DQL→PP skip needs the PP folder only; it must never require
  // duplicate documents in the skipped PR folder.
  const skipUploadTarget: Record<string, string> = {
    MQL: 'PROPOSAL_PRESENTED',
    DQL: 'PROPOSAL_PRESENTED',
  };
  const currentOrSkipTargetIdx = Math.max(
    currentIdx,
    STAGE_ORDER.indexOf(skipUploadTarget[currentStage] ?? currentStage),
  );

  // Build stage folders through the current stage (or reachable skip target),
  // plus any with files.
  const stagesWithContent = new Set<string>([currentStage, ...files.map((f) => f.stage)]);

  const folders: StageFolder[] = STAGE_ORDER.filter((stage) => {
    const idx = STAGE_ORDER.indexOf(stage);
    return stagesWithContent.has(stage) || idx <= currentOrSkipTargetIdx;
  }).map((stage) => {
    const stageFiles = files.filter((f) => f.stage === stage);
    // Badges come from the server's stage-rules engine (the move out of this
    // stage), so they always match what the stage change will actually ask for.
    const requiredGroups = requirements[stage] ?? [];
    const hasRequired = requiredGroups.every((g) => g.satisfied);
    return { stage, files: stageFiles, requiredGroups, hasRequired };
  });

  if (loading) {
    return (
      <div className="flex items-center justify-center py-12">
        <Loader2 size={20} strokeWidth={2} className="animate-spin text-brand-400" />
      </div>
    );
  }

  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between mb-3">
        <p className="text-xs text-gray-400">Files are organised by stage. Required files are marked with a badge.</p>
      </div>

      {folders.map(({ stage, files: stageFiles, requiredGroups }) => {
        const isOpen = openFolders[stage] ?? false;
        const isActive = stage === currentStage;
        const isUploadOpen = showUploadForm === stage;
        const isUploading = uploadState[stage];

        return (
          <div
            key={stage}
            className={`rounded-xl border transition-all ${isActive ? 'border-brand-300 bg-brand-50/30' : 'border-gray-100 bg-white'}`}
          >
            {/* Folder header */}
            <button
              onClick={() => setOpenFolders((p) => ({ ...p, [stage]: !isOpen }))}
              className="w-full flex items-center gap-2 px-4 py-3 text-left"
            >
              {isOpen ? <ChevronDown size={14} strokeWidth={2.5} className="text-gray-400" /> : <ChevronRight size={14} strokeWidth={2.5} className="text-gray-400" />}
              <span className={`text-sm font-medium ${isActive ? 'text-brand-700' : 'text-gray-700'}`}>
                {STAGE_LABELS[stage] ?? stage}
              </span>
              {isActive && (
                <span className="text-[10px] font-bold bg-brand-100 text-brand-600 px-2 py-0.5 rounded-full ml-1">Current</span>
              )}
              {requiredGroups.length > 0 && (
                <span className="ml-auto flex flex-wrap justify-end gap-1">
                  {requiredGroups.map((g, i) => (
                    <span
                      key={i}
                      className={`text-[10px] px-2 py-0.5 rounded-full font-medium ${g.satisfied ? 'bg-green-100 text-green-600' : 'bg-amber-100 text-amber-700'}`}
                    >
                      {g.satisfied ? `✓ ${g.label}` : `⚠ ${g.label} required`}
                    </span>
                  ))}
                </span>
              )}
              {requiredGroups.length === 0 && stageFiles.length > 0 && (
                <span className="ml-auto text-[10px] text-gray-400">{stageFiles.length} file{stageFiles.length !== 1 ? 's' : ''}</span>
              )}
            </button>

            {isOpen && (
              <div className="px-4 pb-3 space-y-2">
                {/* File list */}
                {stageFiles.length === 0 && (
                  <p className="text-xs text-gray-400 py-1">No files uploaded for this stage yet.</p>
                )}
                {stageFiles.map((file) => (
                  <div key={file.id} className="flex items-center gap-3 py-2 border-t border-gray-50">
                    <span className="text-lg leading-none">{fileIcon(file.fileName)}</span>
                    <div className="flex-1 min-w-0">
                      <p className="text-xs font-medium text-gray-700 truncate">{file.fileName}</p>
                      <p className="text-[10px] text-gray-400">
                        {docTypeLabel(file.fileType)} · {fmtDate(file.createdAt)} · {file.uploadedBy.name}
                      </p>
                    </div>
                    {file.signedUrl ? (
                      <a
                        href={file.signedUrl}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="flex items-center gap-1 text-xs text-brand-600 hover:text-brand-700 shrink-0"
                      >
                        <Download size={12} strokeWidth={2} />
                        View
                      </a>
                    ) : (
                      <span className="text-xs text-gray-300">URL expired</span>
                    )}
                  </div>
                ))}

                {/* Upload form toggle */}
                {!isUploadOpen && !isLocked && (
                  <button
                    onClick={() => {
                      setShowUploadForm(stage);
                      setUploadFileType('');
                      setSelectedFile(null);
                    }}
                    className="flex items-center gap-1.5 text-xs text-brand-600 hover:text-brand-700 font-medium mt-1 pt-1 border-t border-gray-50"
                  >
                    <Upload size={11} strokeWidth={2.5} />
                    Upload file
                  </button>
                )}
                {!isUploadOpen && isLocked && (
                  <p className="text-[10px] text-amber-600 mt-1 pt-1 border-t border-gray-50">
                    Lead is Inactive — reactivate to upload files.
                  </p>
                )}

                {/* Upload form */}
                {isUploadOpen && !isLocked && (
                  <div className="border-t border-gray-100 pt-3 space-y-2">
                    <div>
                      <label className="block text-xs font-medium text-gray-600 mb-1">File type</label>
                      <select
                        value={uploadFileType}
                        onChange={(e) => setUploadFileType(e.target.value)}
                        className="w-full border border-gray-200 rounded-lg px-3 py-1.5 text-xs focus:outline-none focus:ring-2 focus:ring-brand-300"
                      >
                        <option value="">Select type…</option>
                        {docTypes.filter((t) => t.active).map((t) => (
                          <option key={t.key} value={t.key}>{t.label}</option>
                        ))}
                      </select>
                    </div>
                    <div>
                      <label className="block text-xs font-medium text-gray-600 mb-1">File</label>
                      <label className="flex items-center gap-2 cursor-pointer border border-dashed border-gray-300 rounded-lg px-3 py-2 text-xs text-gray-500 hover:border-brand-400 transition-colors">
                        <Paperclip size={12} strokeWidth={2} />
                        {selectedFile ? selectedFile.name : isPdfOnly(uploadFileType) ? 'Choose PDF file' : 'Choose file (PDF, image, Word, PPT)'}
                        <input
                          ref={(el) => { fileInputRefs.current[stage] = el; }}
                          type="file"
                          accept={isPdfOnly(uploadFileType) ? '.pdf,application/pdf' : ALLOWED_EXTS}
                          className="hidden"
                          onChange={(e) => setSelectedFile(e.target.files?.[0] ?? null)}
                        />
                      </label>
                    </div>
                    <div className="flex gap-2 pt-1">
                      <button
                        onClick={() => handleUpload(stage)}
                        disabled={isUploading || !selectedFile || !uploadFileType}
                        className="flex-1 bg-brand-500 text-white py-1.5 rounded-lg text-xs font-medium hover:bg-brand-600 disabled:opacity-50 transition-colors"
                      >
                        {isUploading ? 'Uploading…' : 'Upload'}
                      </button>
                      <button
                        onClick={() => { setShowUploadForm(null); setSelectedFile(null); }}
                        className="flex-1 border border-gray-200 text-gray-600 py-1.5 rounded-lg text-xs hover:bg-gray-50 transition-colors"
                      >
                        Cancel
                      </button>
                    </div>
                  </div>
                )}
              </div>
            )}
          </div>
        );
      })}

      {folders.length === 0 && (
        <div className="text-center py-8 text-gray-400">
          <FileText size={24} strokeWidth={1.5} className="mx-auto mb-2 opacity-50" />
          <p className="text-sm">No file folders yet</p>
        </div>
      )}
    </div>
  );
}
