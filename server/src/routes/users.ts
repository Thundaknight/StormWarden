import { Router } from 'express';
import { hashPassword, requireAuth, verifyPassword } from '../auth';
import { audit, createUser, deleteUser, getUserById, getUserByUsername, listUsers, setUserPassword } from '../db';

const router = Router();
router.use(requireAuth);

router.get('/', (_req, res) => {
  res.json({ users: listUsers() });
});

router.post('/', (req, res) => {
  const { username, password } = req.body || {};
  const name = String(username || '').trim();
  if (!name || String(password || '').length < 8) {
    return void res.status(400).json({ error: 'Username and a password of at least 8 characters are required' });
  }
  if (getUserByUsername(name)) return void res.status(409).json({ error: 'That username is taken' });
  const u = createUser(name, hashPassword(String(password)));
  audit(req.user!.username, 'web', 'user.create', u.username);
  res.json({ user: { id: u.id, username: u.username, role: u.role, created_at: u.created_at } });
});

router.post('/:id/password', (req, res) => {
  const id = parseInt(req.params.id, 10);
  const target = getUserById(id);
  if (!target) return void res.status(404).json({ error: 'User not found' });
  const { password, currentPassword } = req.body || {};
  if (String(password || '').length < 8) return void res.status(400).json({ error: 'Password must be at least 8 characters' });
  if (id === req.user!.userId && !verifyPassword(String(currentPassword || ''), target.password_hash)) {
    return void res.status(400).json({ error: 'Current password is incorrect' });
  }
  setUserPassword(id, hashPassword(String(password)));
  audit(req.user!.username, 'web', 'user.password', target.username);
  res.json({ ok: true });
});

router.delete('/:id', (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (id === req.user!.userId) return void res.status(400).json({ error: 'You cannot delete your own account' });
  const target = getUserById(id);
  if (!target) return void res.status(404).json({ error: 'User not found' });
  deleteUser(id);
  audit(req.user!.username, 'web', 'user.delete', target.username);
  res.json({ ok: true });
});

export default router;
