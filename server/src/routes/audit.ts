import { Router } from 'express';
import { requireAuth } from '../auth';
import { listAudit } from '../db';

const router = Router();
router.use(requireAuth);

router.get('/', (req, res) => {
  const before = req.query.before ? parseInt(String(req.query.before), 10) : undefined;
  res.json({ entries: listAudit({ before, limit: parseInt(String(req.query.limit || '100'), 10) }) });
});

export default router;
