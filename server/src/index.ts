import express from 'express';
import http from 'http';
import fs from 'fs';
import path from 'path';
import { config } from './config';
import { initDb } from './db';
import { discordBot } from './discord/bot';
import auditRoutes from './routes/audit';
import authRoutes from './routes/auth';
import containerRoutes from './routes/containers';
import requestRoutes from './routes/requests';
import scriptRoutes from './routes/scripts';
import settingsRoutes from './routes/settings';
import userRoutes from './routes/users';

initDb();

const app = express();
app.disable('x-powered-by');
app.use(express.json({ limit: '1mb' }));

app.use('/api/auth', authRoutes);
app.use('/api/users', userRoutes);
app.use('/api/containers', containerRoutes);
app.use('/api/scripts', scriptRoutes);
app.use('/api/requests', requestRoutes);
app.use('/api/settings', settingsRoutes);
app.use('/api/audit', auditRoutes);
app.use('/api', (_req, res) => res.status(404).json({ error: 'Not found' }));

const webDist = path.resolve(__dirname, '../../web/dist');
if (fs.existsSync(webDist)) {
  app.use(express.static(webDist));
  app.get('*', (_req, res) => res.sendFile(path.join(webDist, 'index.html')));
}

const httpServer = http.createServer(app);
discordBot.start().catch((err) => console.error('[discord] startup error:', err));

httpServer.listen(config.port, () => {
  console.log(`StormWarden v${config.version} listening on port ${config.port}`);
  console.log(`Data directory: ${config.dataDir}`);
  console.log(`Docker: ${config.dockerHost || config.dockerSocket}`);
});

process.on('SIGTERM', async () => {
  await discordBot.stop();
  httpServer.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 3000).unref();
});
