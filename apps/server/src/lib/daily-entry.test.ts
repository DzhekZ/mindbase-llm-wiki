import { describe, it, expect, beforeEach } from 'vitest';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { appendDailyEntry } from './daily-entry';

let root: string;
const today = () => new Date().toISOString().slice(0, 10);

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'mb-daily-'));
});

describe('appendDailyEntry', () => {
  it('creates the daily file with a header once, appends subsequent entries, and logs each', async () => {
    const first = await appendDailyEntry(root, 'alice', '  first thought  ');
    expect(first).toEqual({ file: `sources/contributors/alice/${today()}.md` });

    const afterFirst = await readFile(join(root, first.file), 'utf-8');
    expect(afterFirst.startsWith(`# ${today()} — alice\n`)).toBe(true);
    expect(afterFirst).toMatch(/\n## \d{2}:\d{2}\n\nfirst thought\n$/);

    const second = await appendDailyEntry(root, 'alice', 'second thought');
    expect(second.file).toBe(first.file);
    const afterSecond = await readFile(join(root, first.file), 'utf-8');
    // Header appears exactly once; both entries present in order.
    expect(afterSecond.match(/^# /gm)).toHaveLength(1);
    expect(afterSecond.indexOf('first thought')).toBeLessThan(afterSecond.indexOf('second thought'));

    const log = await readFile(join(root, 'logs', `${today()}.md`), 'utf-8');
    const lines = log.trim().split('\n');
    expect(lines).toHaveLength(2);
    expect(lines[0]).toMatch(new RegExp(`^## \\[${today()} \\d{2}:\\d{2}\\] contribute \\| user=alice bytes=${'  first thought  '.length}$`));
    expect(lines[1]).toMatch(/contribute \| user=alice bytes=14$/);
  });
});
