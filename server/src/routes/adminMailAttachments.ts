import { Router, type Request, type Response } from 'express';
import multer from 'multer';
import { uploadMasterMailAttachment } from '../lib/mailTemplateAttachments.js';

// Mounted behind the existing Branch Head authentication in admin.ts.
export const adminMailAttachmentsRouter = Router();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 4 * 1024 * 1024, files: 1 } });
// Multer and Express currently resolve different Express major-version types
// in this workspace; their runtime request/response interfaces are the same.
const uploadFile = upload.single('file') as unknown as (req: Request, res: Response, cb: (error?: any) => void) => void;
adminMailAttachmentsRouter.post('/:code/attachments/upload', (req, res, next) => {
  if (req.params.code !== 'OB_OBM_WELCOME') {
    res.status(404).json({ error: 'Welcome-document uploads are available for the OB→OBM welcome email only' });
    return;
  }
  uploadFile(req, res, (error: any) => {
    if (error) { res.status(400).json({ error: error.message }); return; }
    next();
  });
}, async (req, res) => {
  try {
    if (!req.file) { res.status(400).json({ error: 'A document is required' }); return; }
    res.json({ attachment: await uploadMasterMailAttachment(req.file) });
  } catch (error: any) {
    res.status(400).json({ error: error.message });
  }
});
