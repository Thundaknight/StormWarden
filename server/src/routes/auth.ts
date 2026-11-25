import { Router } from 'express';
import { hashPassword, requireAuth, signToken, verifyPassword } from '../auth';
import { config } from '../config';
import { countUsers, createUser, getUserByUsername } from '../db';

const router = Router();

router.get('/status', (_req, res) => {
  res.json({ needsSetup: countUsers() === 0, version: config.version });
});

/** First run only: the very first account becomes the owner/admin. */
router.post('/setup', (req, res) => {
  if (countUsers() > 0) return void res.status(403).json({ error: 'Setup has already been completed' });
  const { username, password } = req.body || {};
  if (!username || !password || String(password).length < 8) {
    return void res.status(400).json({ error: 'Username and a password of at least 8 characters are required' });
  }
  const user = createUser(String(username).trim(), hashPassword(String(password)));
  res.json({ token: signToken(user), user: { id: user.id, username: user.username, role: user.role } });
});

router.post('/login', (req, res) => {
  const { username, password } = req.body || {};
  const user = username ? getUserByUsername(String(username)) : undefined;
  if (!user || !verifyPassword(String(password || ''), user.password_hash)) {
    return void res.status(401).json({ error: 'Invalid username or password' });
  }
  res.json({ token: signToken(user), user: { id: user.id, username: user.username, role: user.role } });
});

router.get('/me', requireAuth, (req, res) => {
  res.json({ user: req.user });
});

export default router;
