import { Router } from 'express';
import { mkdir, writeFile } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import type { ServerContext } from '../../context.js';
import { projectPaths } from '@mindbase/core';
import { projectRoot as makeProjectRoot, detectLayoutVersion } from '../../context.js';
import { resolveUser } from '../../lib/user-attribution.js';
import { appendDailyEntry } from '../../lib/daily-entry.js';

export function quickRoutes(ctx: ServerContext): Router {
  const router = Router();

  router.post('/contributors/daily', async (req, res) => {
    const projectId = ctx.currentProjectId;
    const root = makeProjectRoot(ctx.dataDir, projectId);
    const layout = await detectLayoutVersion(root);
    if (layout === 'v1') return res.status(409).json({ error: 'V1_LAYOUT_UNSUPPORTED' });
    const text = (req.body?.text as string | undefined) ?? '';
    if (!text) return res.status(400).json({ error: 'text required' });
    const { file } = await appendDailyEntry(root, resolveUser(req), text);
    return res.json({ file });
  });

  router.post('/research', async (req, res) => {
    const projectId = ctx.currentProjectId;
    const layout = await detectLayoutVersion(makeProjectRoot(ctx.dataDir, projectId));
    if (layout === 'v1') return res.status(409).json({ error: 'V1_LAYOUT_UNSUPPORTED' });
    const slug = req.body?.slug as string | undefined;
    const title = req.body?.title as string | undefined;
    const body = (req.body?.body as string | undefined) ?? '';
    if (!slug) return res.status(400).json({ error: 'slug required' });
    const p = projectPaths();
    const file = p.researchFile(slug);
    const abs = join(ctx.dataDir, 'projects', projectId, file);
    await mkdir(dirname(abs), { recursive: true });
    const finalBody = title ? `# ${title}\n\n${body}` : body;
    await writeFile(abs, finalBody, 'utf-8');
    return res.json({ file });
  });

  return router;
}
