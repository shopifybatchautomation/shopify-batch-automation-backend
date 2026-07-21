import express from 'express';
import {
  createBatch,
  getBatchStats,
  exportUnmappedPdf,
  exportUnfulfilledCsv,
  exportUnfulfilledPdf,
  exportCancelledPdf,
} from '../controller/createBatch.controller.js';

const router = express.Router();

// Route for creating a batch (selects confirmed orders on the OMS). Accepts an optional
// ?socketId= query param for real-time progress via the 'batch-progress' socket.io event.
router.get('/batch', createBatch);

// Latest batch run counters (total confirmed / selected / remaining / unmapped / unfulfilled /
// cancelled) + download URLs, for re-hydrating the dashboard without re-running the batch.
router.get('/batch/stats', getBatchStats);

// Export buttons for the most recent batch run
router.get('/batch/export/unmapped', exportUnmappedPdf);
router.get('/batch/export/unfulfilled/csv', exportUnfulfilledCsv);
router.get('/batch/export/unfulfilled/pdf', exportUnfulfilledPdf);
router.get('/batch/export/cancelled', exportCancelledPdf);

export default router;
