// apps/server/src/ops/runner.ts
//
// The single orchestration engine for server-side operations:
// gather → one constrained LLM completion → (checkpoint) → validate →
// apply via executors → append to logs/<date>.md → emit SSE events.
import { appendFile, mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { applyActions } from './executors';
import { completeJson, OpLlmError, type LlmCtx } from './llm';
import {
  gatherProjectCore, gatherResearchPages, gatherSourceStats, gatherUnbuiltSources, listResearchSlugs,
  type ResearchPage, type SourceStat,
} from './gather';
import { appendDailyEntry } from '../lib/daily-entry';
import { contributePrompt, contributePlanSchema, type RelatedPage } from './recipes/contribute';
import { buildPrompt, buildSchema } from './recipes/build';
import { lintPrompt, lintSchema, type Finding } from './recipes/lint';
import { researchPrompt, researchSchema, type ResearchSource } from './recipes/research';
import { braveSearchSources } from './web-search';
import type { Action } from './types';

export interface VerifiedEvidence {
  page: string;
  quote: string;
  /** True when the quote was found verbatim (after normalization) in `page`. */
  verified: boolean;
}

export interface StoredFinding extends Omit<Finding, 'evidence'> {
  id: string;
  dismissed: boolean;
  evidence?: VerifiedEvidence[];
}

export type OpEvent =
  | { kind: 'phase'; phase: string }
  | {
    kind: 'plan';
    planId: string;
    takeaways: string[];
    plan: Action[];
    /** Human-readable reasons for actions the guard removed. Present only when non-empty. */
    notes?: string[];
  }
  | { kind: 'applied'; applied: string[]; failed: Array<{ action: string; error: string }>; note?: string }
  | { kind: 'findings'; date: string; findings: StoredFinding[] }
  | { kind: 'done' }
  | { kind: 'error'; error: string };

export interface OpsCtx extends LlmCtx {
  projectRoot: string;
  projectId: string;
  /** Attributed author — owns `sources/contributors/<user>/`. */
  user: string;
  /** Hybrid search over the wiki; empty array on failure is acceptable. */
  findRelated?: (text: string, k: number) => Promise<RelatedPage[]>;
  /** Optional Brave Search key — enables web mode for the research op. */
  braveApiKey?: string;
}

// --- pending contribute plans (checkpoint state) ---
interface PendingPlan {
  actions: Action[];
  projectRoot: string;
  projectId: string;
  expiresAt: number;
  /** Normalized research slugs this plan will create; held until the plan is consumed or expires. */
  reserved: string[];
}
const pendingPlans = new Map<string, PendingPlan>();
const PLAN_TTL_MS = 10 * 60 * 1000;

/**
 * Slugs that pending (not yet applied) plans intend to create, per project,
 * so two concurrent contributes cannot both propose the same new page.
 * projectId → normalized slug → expiresAt.
 */
const reservedSlugs = new Map<string, Map<string, number>>();

/** Case/separator-insensitive slug identity: `Deep_Work` ≡ `deep--work` ≡ `deep-work`. */
export const normalizeSlug = (s: string): string => s.toLowerCase().replace(/[-_\s]+/g, '-').replace(/^-+|-+$/g, '');

function reservationsFor(projectId: string): Map<string, number> {
  let m = reservedSlugs.get(projectId);
  if (!m) {
    m = new Map();
    reservedSlugs.set(projectId, m);
  }
  return m;
}

function releaseReservations(projectId: string, slugs: string[]): void {
  const m = reservedSlugs.get(projectId);
  if (!m) return;
  for (const s of slugs) m.delete(s);
  if (m.size === 0) reservedSlugs.delete(projectId);
}

function prunePlans(): void {
  const now = Date.now();
  for (const [id, p] of pendingPlans) if (p.expiresAt < now) pendingPlans.delete(id);
  for (const [projectId, m] of reservedSlugs) {
    for (const [slug, expiresAt] of m) if (expiresAt < now) m.delete(slug);
    if (m.size === 0) reservedSlugs.delete(projectId);
  }
}

/**
 * Drop `create_research_page` actions whose slug collides (after
 * normalization) with a page already on disk or one another pending plan
 * is about to create. Returns the surviving actions, a note per removal,
 * and the normalized slugs the surviving creates should reserve.
 */
function guardDuplicatePages(
  actions: Action[],
  existingSlugs: string[],
  pending: Map<string, number>,
): { actions: Action[]; notes: string[]; reserve: string[] } {
  const existing = new Map(existingSlugs.map((s) => [normalizeSlug(s), s]));
  const notes: string[] = [];
  const reserve: string[] = [];
  const kept = actions.filter((a) => {
    if (a.kind !== 'create_research_page') return true;
    const key = normalizeSlug(a.slug);
    const onDisk = existing.get(key);
    if (onDisk !== undefined) {
      notes.push(`Skipped creating "${a.slug}" — a page for this already exists (sources/research/${onDisk}.md). Update it instead.`);
      return false;
    }
    if (pending.has(key)) {
      notes.push(`Skipped creating "${a.slug}" — another pending plan is already creating it.`);
      return false;
    }
    reserve.push(key);
    return true;
  });
  return { actions: kept, notes, reserve };
}

// --- per-project build locks ---
const buildLocks = new Set<string>();

async function appendOpLog(root: string, op: string, summary: string): Promise<void> {
  const now = new Date();
  const date = now.toISOString().slice(0, 10);
  const hhmm = now.toISOString().slice(11, 16);
  await mkdir(join(root, 'logs'), { recursive: true });
  await appendFile(join(root, 'logs', `${date}.md`), `## [${date} ${hhmm}] ${op} | ${summary}\n`, 'utf-8');
}

function errText(e: unknown): string {
  if (e instanceof OpLlmError) return `${e.message}\n\nModel output:\n${e.raw.slice(0, 800)}`;
  return (e as Error).message;
}

/**
 * Plan a contribution. Free text (no `sourcePath`) is first appended to the
 * user's daily contributor file so it exists as a citable source before the
 * wiki is touched; an existing project-relative `sourcePath` (an open note,
 * a raw import) is cited as-is.
 */
export async function runContributePlan(
  ctx: OpsCtx,
  text: string,
  emit: (e: OpEvent) => void,
  opts: { sourcePath?: string } = {},
): Promise<void> {
  try {
    let sourcePath = opts.sourcePath;
    if (!sourcePath) {
      emit({ kind: 'phase', phase: "saving to today's log" });
      sourcePath = (await appendDailyEntry(ctx.projectRoot, ctx.user, text)).file;
    }
    emit({ kind: 'phase', phase: 'reading project' });
    const [core, existingSlugs] = await Promise.all([gatherProjectCore(ctx.projectRoot), listResearchSlugs(ctx.projectRoot)]);
    emit({ kind: 'phase', phase: 'finding related pages' });
    const related = (await ctx.findRelated?.(text, 5).catch(() => [])) ?? [];
    emit({ kind: 'phase', phase: `asking ${ctx.config.model}` });
    prunePlans();
    const pendingSlugs = [...reservationsFor(ctx.projectId).keys()];
    const { system, user } = contributePrompt({ text, core, related, sourcePath, existingSlugs, pendingSlugs });
    const out = await completeJson(ctx, { system, user, schema: contributePlanSchema });

    // Re-check against disk + reservations AFTER the (slow) completion: the
    // world may have moved while the model was thinking.
    prunePlans();
    const guarded = guardDuplicatePages(out.plan, await listResearchSlugs(ctx.projectRoot), reservationsFor(ctx.projectId));
    const planId = randomUUID();
    const expiresAt = Date.now() + PLAN_TTL_MS;
    const reservations = reservationsFor(ctx.projectId);
    for (const slug of guarded.reserve) reservations.set(slug, expiresAt);
    pendingPlans.set(planId, {
      actions: guarded.actions,
      projectRoot: ctx.projectRoot,
      projectId: ctx.projectId,
      expiresAt,
      reserved: guarded.reserve,
    });
    emit({
      kind: 'plan',
      planId,
      takeaways: out.takeaways,
      plan: guarded.actions,
      ...(guarded.notes.length ? { notes: guarded.notes } : {}),
    });
    emit({ kind: 'done' });
  } catch (e) {
    emit({ kind: 'error', error: errText(e) });
  }
}

export async function applyContributePlan(planId: string, selected: number[], emit: (e: OpEvent) => void): Promise<void> {
  try {
    prunePlans();
    const pending = pendingPlans.get(planId);
    if (!pending) {
      emit({ kind: 'error', error: 'This plan expired (plans are held for 10 minutes). Run the contribute again.' });
      return;
    }
    // The plan is consumed either way, so its reservations are released
    // even if the user deselected the page it reserved.
    pendingPlans.delete(planId);
    releaseReservations(pending.projectId, pending.reserved);
    const actions = pending.actions.filter((_, i) => selected.includes(i));
    if (actions.length === 0) {
      emit({ kind: 'error', error: 'No actions selected.' });
      return;
    }
    emit({ kind: 'phase', phase: 'applying' });
    const result = await applyActions(pending.projectRoot, actions);
    await appendOpLog(pending.projectRoot, 'contribute', `applied ${result.applied.length}, failed ${result.failed.length} (ui)`);
    emit({ kind: 'applied', applied: result.applied, failed: result.failed });
    emit({ kind: 'done' });
  } catch (e) {
    emit({ kind: 'error', error: errText(e) });
  }
}

// --- research: synthesize a new research page (wiki-only or wiki+web) ---

const WIKI_SOURCE_CHAR_CAP = 4_000;

export async function runResearch(ctx: OpsCtx, topic: string, emit: (e: OpEvent) => void): Promise<void> {
  try {
    emit({ kind: 'phase', phase: 'searching your wiki' });
    const core = await gatherProjectCore(ctx.projectRoot);
    const related = (await ctx.findRelated?.(topic, 6).catch(() => [])) ?? [];
    const sources: ResearchSource[] = (
      await Promise.all(
        related.map(async (r) => {
          const body = await readFile(join(ctx.projectRoot, r.path), 'utf-8').catch(() => '');
          return body.trim() ? [{ label: r.path, body: body.slice(0, WIKI_SOURCE_CHAR_CAP) }] : [];
        }),
      )
    ).flat();

    let mode: 'wiki-only' | 'web' = 'wiki-only';
    let degraded = '';
    if (ctx.braveApiKey) {
      emit({ kind: 'phase', phase: 'searching the web (Brave)' });
      try {
        sources.push(...(await braveSearchSources(ctx.braveApiKey, topic)));
        mode = 'web';
      } catch (e) {
        degraded = ` Web search failed (${(e as Error).message}); answered from your wiki only.`;
      }
    }

    emit({ kind: 'phase', phase: `synthesizing with ${ctx.config.model} (${sources.length} sources)` });
    const { system, user } = researchPrompt({ topic, core, sources, mode });
    const out = await completeJson(ctx, { system, user, schema: researchSchema, maxTokens: 8192 });

    emit({ kind: 'phase', phase: 'writing' });
    const result = await applyActions(ctx.projectRoot, out.actions);
    await appendOpLog(ctx.projectRoot, 'research', `"${topic.slice(0, 60)}" mode=${mode} applied ${result.applied.length} (ui)`);
    const note = mode === 'web'
      ? `Synthesized from your wiki + ${sources.length} sources including web results.${degraded}`
      : `Synthesized from your wiki only — add a Brave Search key in Settings for web research.${degraded}`;
    emit({ kind: 'applied', applied: result.applied, failed: result.failed, note });
    emit({ kind: 'done' });
  } catch (e) {
    emit({ kind: 'error', error: errText(e) });
  }
}

// --- lint: emits findings, never writes to the wiki ---

interface LintArtifact {
  date: string;
  findings: StoredFinding[];
  /** Model findings discarded because their evidence quotes did not verify. Absent on pre-evidence artifacts. */
  dropped?: number;
}

const normalizeContextPath = (p: string): string => (/^\.?\/?context\.md$/i.test(p.trim()) ? 'context.md' : p.trim());

/**
 * Resolve a model-supplied page label to a project-relative file that exists:
 * exact relative path → context.md (any casing, optional ./) → bare slug or
 * `sources/research/<slug>` → `sources/research/<slug>.md`.
 */
async function resolvePageFile(root: string, page: string): Promise<string | null> {
  const label = normalizeContextPath(page);
  const exists = (rel: string) => stat(join(root, rel)).then((s) => s.isFile()).catch(() => false);
  if (await exists(label)) return label;
  const slug = label.replace(/^sources\/research\//, '').replace(/\.md$/, '');
  if (slug && !slug.includes('/')) {
    const rel = `sources/research/${slug}.md`;
    if (await exists(rel)) return rel;
  }
  return null;
}

/** Lowercase, strip emphasis/backticks, collapse whitespace — so a quote survives light markdown drift. */
const normalizeQuote = (s: string): string => s.toLowerCase().replace(/[*_`]/g, '').replace(/\s+/g, ' ').trim();

const MIN_VERIFIED: Partial<Record<Finding['kind'], number>> = { contradiction: 2, stale: 1 };

/**
 * Check every evidence quote against the page it claims to come from.
 * Contradictions need ≥2 verified quotes and stale claims ≥1, otherwise the
 * finding is dropped — the model must not be allowed to invent conflicts.
 * Other kinds are kept with per-item `verified` flags attached.
 */
export async function verifyEvidence(
  root: string,
  findings: Array<Omit<StoredFinding, 'evidence'> & { evidence?: Array<{ page: string; quote: string }> }>,
): Promise<{ kept: StoredFinding[]; dropped: number }> {
  const bodyCache = new Map<string, Promise<string | null>>();
  const bodyOf = (page: string): Promise<string | null> => {
    const key = normalizeContextPath(page);
    let hit = bodyCache.get(key);
    if (!hit) {
      hit = resolvePageFile(root, key).then((rel) =>
        rel ? readFile(join(root, rel), 'utf-8').then(normalizeQuote).catch(() => null) : null,
      );
      bodyCache.set(key, hit);
    }
    return hit;
  };

  const kept: StoredFinding[] = [];
  let dropped = 0;
  for (const f of findings) {
    const evidence = f.evidence
      ? await Promise.all(
        f.evidence.map(async (e) => {
          const haystack = await bodyOf(e.page);
          return { page: e.page, quote: e.quote, verified: haystack !== null && haystack.includes(normalizeQuote(e.quote)) };
        }),
      )
      : undefined;
    const need = MIN_VERIFIED[f.kind];
    const verifiedCount = evidence?.filter((e) => e.verified).length ?? 0;
    if (need !== undefined && verifiedCount < need) {
      dropped += 1;
      continue;
    }
    const { evidence: _raw, ...rest } = f;
    kept.push(evidence ? { ...rest, evidence } : rest);
  }
  return { kept, dropped };
}

const MAX_DETERMINISTIC_PER_KIND = 8;

/**
 * Findings computed from citation data without the model: research pages
 * that cite nothing, and sources that were built over (older than
 * context.md) yet never cited anywhere. Skips `uncited_source` entirely when
 * there is no context.md to compare against.
 */
function deterministicFindings(pages: ResearchPage[], sources: SourceStat[], contextMtimeMs: number | null): StoredFinding[] {
  const unsourced = pages
    .filter((p) => p.cites.length === 0)
    .slice(0, MAX_DETERMINISTIC_PER_KIND)
    .map<StoredFinding>((p) => ({
      kind: 'unsourced_page',
      pages: [p.path],
      detail: 'This research page cites no source (no [@path] citations). Add the sources it was synthesized from.',
      id: randomUUID(),
      dismissed: false,
    }));
  const uncited = contextMtimeMs === null
    ? []
    : sources
      .filter((s) => s.citedBy === 0 && s.mtimeMs < contextMtimeMs)
      .sort((a, b) => b.mtimeMs - a.mtimeMs)
      .slice(0, MAX_DETERMINISTIC_PER_KIND)
      .map<StoredFinding>((s) => ({
        kind: 'uncited_source',
        pages: [s.path],
        detail: 'Built over but never cited by any research page or context.md.',
        id: randomUUID(),
        dismissed: false,
      }));
  return [...unsourced, ...uncited];
}

const lintDir = (root: string) => join(root, 'artifacts', 'lint');

/** Most recent artifacts/lint/<date>.json, or null when none exist. */
export async function latestLintArtifact(root: string): Promise<LintArtifact | null> {
  const files = (await readdir(lintDir(root)).catch(() => [] as string[]))
    .filter((f) => /^\d{4}-\d{2}-\d{2}\.json$/.test(f))
    .sort();
  const last = files[files.length - 1];
  if (!last) return null;
  try {
    return JSON.parse(await readFile(join(lintDir(root), last), 'utf-8')) as LintArtifact;
  } catch {
    return null;
  }
}

export async function dismissLintFinding(root: string, id: string): Promise<boolean> {
  const artifact = await latestLintArtifact(root);
  if (!artifact) return false;
  const hit = artifact.findings.find((f) => f.id === id);
  if (!hit) return false;
  hit.dismissed = true;
  await writeFile(join(lintDir(root), `${artifact.date}.json`), JSON.stringify(artifact, null, 2), 'utf-8');
  return true;
}

export async function runLint(ctx: OpsCtx, emit: (e: OpEvent) => void): Promise<void> {
  try {
    emit({ kind: 'phase', phase: 'reading project' });
    const [core, pages, contextMtimeMs] = await Promise.all([
      gatherProjectCore(ctx.projectRoot),
      gatherResearchPages(ctx.projectRoot),
      stat(join(ctx.projectRoot, 'context.md')).then((s) => s.mtimeMs).catch(() => null),
    ]);
    if (!core.context.trim() && pages.length === 0) {
      emit({ kind: 'error', error: 'Nothing to lint yet — contribute a thought or two first.' });
      return;
    }
    const sources = await gatherSourceStats(ctx.projectRoot, pages);
    emit({ kind: 'phase', phase: `checking ${pages.length} pages with ${ctx.config.model}` });
    const { system, user } = lintPrompt({ core, pages, sources });
    const out = await completeJson(ctx, { system, user, schema: lintSchema, maxTokens: 4096 });

    const date = new Date().toISOString().slice(0, 10);
    // The model is told not to emit deterministic kinds; drop any it sends
    // so they never bypass the code-computed versions below.
    const modelFindings = out.findings
      .filter((f) => f.kind !== 'unsourced_page' && f.kind !== 'uncited_source')
      .map((f) => ({
        ...f,
        // Models sometimes echo path labels with different casing/prefixes;
        // normalize so the UI's page links resolve.
        pages: f.pages.map(normalizeContextPath),
        id: randomUUID(),
        dismissed: false,
      }));
    emit({ kind: 'phase', phase: 'verifying evidence' });
    const { kept, dropped } = await verifyEvidence(ctx.projectRoot, modelFindings);
    const findings: StoredFinding[] = [...kept, ...deterministicFindings(pages, sources, contextMtimeMs)];
    const artifact: LintArtifact = { date, findings, dropped };
    await mkdir(lintDir(ctx.projectRoot), { recursive: true });
    await writeFile(join(lintDir(ctx.projectRoot), `${date}.json`), JSON.stringify(artifact, null, 2), 'utf-8');
    await appendOpLog(
      ctx.projectRoot,
      'lint',
      `${findings.length} findings, pages=${pages.length} (ui)${dropped > 0 ? `, dropped=${dropped}` : ''}`,
    );
    emit({ kind: 'findings', date, findings });
    emit({ kind: 'done' });
  } catch (e) {
    emit({ kind: 'error', error: errText(e) });
  }
}

export async function runBuild(ctx: OpsCtx, emit: (e: OpEvent) => void): Promise<void> {
  if (buildLocks.has(ctx.projectId)) {
    emit({ kind: 'error', error: 'A build is already running for this project.' });
    return;
  }
  buildLocks.add(ctx.projectId);
  try {
    emit({ kind: 'phase', phase: 'gathering unbuilt sources' });
    const [core, sources] = await Promise.all([
      gatherProjectCore(ctx.projectRoot),
      gatherUnbuiltSources(ctx.projectRoot),
    ]);
    emit({ kind: 'phase', phase: `synthesizing with ${ctx.config.model} (${sources.length} sources)` });
    const { system, user } = buildPrompt({ core, sources, today: new Date().toISOString().slice(0, 10) });
    const out = await completeJson(ctx, { system, user, schema: buildSchema, maxTokens: 8192 });

    emit({ kind: 'phase', phase: 'writing' });
    const result = await applyActions(ctx.projectRoot, out.actions);
    await appendOpLog(ctx.projectRoot, 'build', `applied ${result.applied.length}, failed ${result.failed.length}, sources=${sources.length} (ui)`);
    emit({ kind: 'applied', applied: result.applied, failed: result.failed });
    emit({ kind: 'done' });
  } catch (e) {
    emit({ kind: 'error', error: errText(e) });
  } finally {
    buildLocks.delete(ctx.projectId);
  }
}
