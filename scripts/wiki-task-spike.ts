#!/usr/bin/env tsx
/**
 * Spike: compare a single task between tarkov.dev and the wiki.
 *
 * Goal: validate wiki extraction feasibility for tasks.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import JSON5 from 'json5';

import {
  fetchTasks,
  findTaskById,
  printHeader,
  printProgress,
  printSuccess,
  printError,
  bold,
  dim,
  icons,
} from '../src/lib/index.js';

import type { TaskData } from '../src/lib/types.js';

/** Extended task data with rewards for comparison */
type ExtendedTaskData = TaskData & {
  experience?: number;
  finishRewards?: {
    traderStanding?: Array<{ trader: { name: string }; standing: number }>;
    items?: Array<{ item: { name: string }; count: number }>;
  };
  gameModes?: ('regular' | 'pve')[];
};

type WikiObjective = {
  text: string;
  count?: number;
  pveCount?: number;  // PvE-specific count when wiki shows different values
};

type TraderReputation = {
  trader: string;
  value: number;
};

type WikiRewards = {
  xp?: number;
  reputations: TraderReputation[];
  money?: number;
  items: Array<{ name: string; count: number }>;
  raw: string[];
};

type WikiTaskData = {
  pageTitle: string;
  requirements: string[];
  objectives: WikiObjective[];
  rewards: WikiRewards;
  minPlayerLevel?: number;
  previousTasks: string[];
  lastRevision?: {
    timestamp: string;
    user: string;
    comment: string;
  };
};

type GroupBy = 'priority' | 'category';

type CliOptions = {
  id?: string;
  name?: string;
  wiki?: string;
  all?: boolean;
  useCache?: boolean;
  refresh?: boolean;
  output?: string;
  gameMode?: 'regular' | 'pve' | 'both';
  groupBy?: GroupBy;
};

type Priority = 'high' | 'medium' | 'low';

type Discrepancy = {
  taskId: string;
  taskName: string;
  field: string;
  apiValue: string | number | undefined;
  wikiValue: string | number | undefined;
  priority: Priority;
  trustsWiki: boolean;
  wikiLastEdit?: string;
  wikiEditDaysAgo?: number;
  wikiEditedPost1_0?: boolean;
};

/**
 * Get priority for a discrepancy based on field type
 * - Level/Task requirements: High (blocks progression)
 * - Reputation: Medium-High (affects loyalty levels)
 * - Objectives: Medium
 * - XP/Money: Low (not strictly required for tracking)
 */
function getPriority(field: string): Priority {
  // Handle trader-specific reputation fields like "reputation.Prapor"
  if (field.startsWith('reputation.')) {
    return 'medium';
  }

  switch (field) {
    case 'minPlayerLevel':
    case 'taskRequirements':
      return 'high';
    case 'reputation':
    case 'objectives.count':
      return 'medium';
    case 'experience':
    case 'money':
    default:
      return 'low';
  }
}

const DEFAULT_TASK_NAME = 'Grenadier';
const WIKI_API = 'https://escapefromtarkov.fandom.com/api.php';
const TARKOV_API = 'https://api.tarkov.dev/graphql';
const RATE_LIMIT_MS = 500;

// Tarkov 1.0 launch date - wiki edits after this are more trustworthy
const TARKOV_1_0_LAUNCH = new Date('2025-11-15T00:00:00Z');

// Cache directories
const CACHE_DIR = path.join(process.cwd(), 'data', 'cache');
const WIKI_CACHE_DIR = path.join(CACHE_DIR, 'wiki');
const RESULTS_DIR = path.join(process.cwd(), 'data', 'results');
const API_CACHE_FILE = path.join(CACHE_DIR, 'tarkov-api-tasks.json');

// Overlay file for filtering already-addressed discrepancies
const TASKS_OVERLAY_FILE = path.join(process.cwd(), 'src', 'overrides', 'tasks.json5');

// Suppressions file for discrepancies where wiki is wrong and API is correct
const WIKI_INCORRECT_FILE = path.join(process.cwd(), 'src', 'suppressions', 'wiki-incorrect.json5');

const EXTENDED_TASKS_QUERY = `
  query($gameMode: GameMode) {
    tasks(lang: en, gameMode: $gameMode) {
      id
      name
      minPlayerLevel
      wikiLink
      experience
      taskRequirements {
        task { id name }
        status
      }
      objectives {
        id
        ... on TaskObjectiveShoot { count }
        ... on TaskObjectiveItem { count }
        ... on TaskObjectiveQuestItem { count }
        ... on TaskObjectiveUseItem { count }
      }
      finishRewards {
        traderStanding { trader { name } standing }
        items { item { name } count }
      }
    }
  }
`;

type GameMode = 'regular' | 'pve';

async function fetchTasksForMode(mode: GameMode): Promise<ExtendedTaskData[]> {
  const response = await fetch(TARKOV_API, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      query: EXTENDED_TASKS_QUERY,
      variables: { gameMode: mode },
    }),
  });

  if (!response.ok) {
    throw new Error(`API request failed: ${response.status}`);
  }

  const result = await response.json() as {
    data?: { tasks: ExtendedTaskData[] };
    errors?: Array<{ message: string }>;
  };

  if (result.errors) {
    throw new Error(`GraphQL errors: ${result.errors.map(e => e.message).join(', ')}`);
  }

  const tasks = result.data?.tasks ?? [];
  // Tag each task with its game mode
  return tasks.map(t => ({ ...t, gameModes: [mode] }));
}

/**
 * Fetch tasks from both game modes and deduplicate by wikiLink.
 * Tasks with the same wikiLink are merged, tracking which modes they belong to.
 */
async function fetchExtendedTasks(
  gameMode: 'regular' | 'pve' | 'both' = 'both'
): Promise<ExtendedTaskData[]> {
  if (gameMode !== 'both') {
    return fetchTasksForMode(gameMode);
  }

  // Fetch both modes
  const [regularTasks, pveTasks] = await Promise.all([
    fetchTasksForMode('regular'),
    fetchTasksForMode('pve'),
  ]);

  // Deduplicate by wikiLink, merging game modes
  const byWikiLink = new Map<string, ExtendedTaskData>();

  for (const task of regularTasks) {
    if (task.wikiLink) {
      byWikiLink.set(task.wikiLink, task);
    } else {
      // Tasks without wikiLink - use ID as key
      byWikiLink.set(`id:${task.id}`, task);
    }
  }

  for (const task of pveTasks) {
    const key = task.wikiLink || `id:${task.id}`;
    const existing = byWikiLink.get(key);
    if (existing) {
      // Merge game modes
      existing.gameModes = [...(existing.gameModes || []), 'pve'];
    } else {
      byWikiLink.set(key, task);
    }
  }

  return Array.from(byWikiLink.values());
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function ensureDir(dir: string): void {
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

function getTimestamp(): string {
  const now = new Date();
  return now.toISOString().replace(/[:.]/g, '-').slice(0, 19);
}

type CacheMetadata = {
  fetchedAt: string;
  taskCount: number;
  gameMode: 'regular' | 'pve' | 'both';
};

type ApiCache = {
  meta: CacheMetadata;
  tasks: ExtendedTaskData[];
};

function loadApiCache(): ApiCache | null {
  if (!fs.existsSync(API_CACHE_FILE)) return null;
  try {
    const data = JSON.parse(fs.readFileSync(API_CACHE_FILE, 'utf-8'));
    return data as ApiCache;
  } catch {
    return null;
  }
}

function saveApiCache(tasks: ExtendedTaskData[], gameMode: 'regular' | 'pve' | 'both'): void {
  ensureDir(CACHE_DIR);
  const cache: ApiCache = {
    meta: {
      fetchedAt: new Date().toISOString(),
      taskCount: tasks.length,
      gameMode,
    },
    tasks,
  };
  fs.writeFileSync(API_CACHE_FILE, JSON.stringify(cache, null, 2));
}

type WikiCache = {
  fetchedAt: string;
  title: string;
  wikitext: string;
  lastRevision?: {
    timestamp: string;
    user: string;
    comment: string;
  };
};

function getWikiCachePath(taskId: string): string {
  return path.join(WIKI_CACHE_DIR, `${taskId}.json`);
}

function loadWikiCache(taskId: string): WikiCache | null {
  const cachePath = getWikiCachePath(taskId);
  if (!fs.existsSync(cachePath)) return null;
  try {
    return JSON.parse(fs.readFileSync(cachePath, 'utf-8')) as WikiCache;
  } catch {
    return null;
  }
}

function saveWikiCache(
  taskId: string,
  title: string,
  wikitext: string,
  lastRevision?: WikiCache['lastRevision']
): void {
  ensureDir(WIKI_CACHE_DIR);
  const cache: WikiCache = {
    fetchedAt: new Date().toISOString(),
    title,
    wikitext,
    lastRevision,
  };
  fs.writeFileSync(getWikiCachePath(taskId), JSON.stringify(cache, null, 2));
}

/**
 * Load suppressed fields from both:
 * 1. Tasks overlay (API was wrong, we corrected it)
 * 2. Wiki-incorrect suppressions (API is correct, wiki is wrong)
 *
 * Returns a Set of "taskId:field" keys to exclude from results
 */
function loadSuppressedFields(): { suppressed: Set<string>; overlayCount: number; wikiIncorrectCount: number } {
  const suppressed = new Set<string>();
  let overlayCount = 0;
  let wikiIncorrectCount = 0;

  // Load overlay file (corrections where API was wrong)
  if (fs.existsSync(TASKS_OVERLAY_FILE)) {
    try {
      const content = fs.readFileSync(TASKS_OVERLAY_FILE, 'utf-8');
      const overlay = JSON5.parse(content) as Record<string, Record<string, unknown>>;

      for (const [taskId, fields] of Object.entries(overlay)) {
        for (const field of Object.keys(fields)) {
          // Map overlay field names to discrepancy field names
          if (field === 'objectives') {
            suppressed.add(`${taskId}:objectives.count`);
            overlayCount++;
          } else if (field === 'experience' || field === 'minPlayerLevel' ||
                     field === 'taskRequirements' || field === 'reputation' || field === 'money' ||
                     field === 'finishRewards') {
            suppressed.add(`${taskId}:${field}`);
            overlayCount++;
          }
          // Also add the raw field name for flexibility
          suppressed.add(`${taskId}:${field}`);
        }
      }
    } catch (error) {
      console.warn('Warning: Could not load overlay file:', error);
    }
  }

  // Load wiki-incorrect suppressions (where API is correct, wiki is wrong)
  if (fs.existsSync(WIKI_INCORRECT_FILE)) {
    try {
      const content = fs.readFileSync(WIKI_INCORRECT_FILE, 'utf-8');
      const suppressions = JSON5.parse(content) as Record<string, string[]>;

      for (const [taskId, fields] of Object.entries(suppressions)) {
        for (const field of fields) {
          suppressed.add(`${taskId}:${field}`);
          wikiIncorrectCount++;
        }
      }
    } catch (error) {
      console.warn('Warning: Could not load wiki-incorrect file:', error);
    }
  }

  return { suppressed, overlayCount, wikiIncorrectCount };
}

function parseArgs(argv: string[]): CliOptions & { help?: boolean } {
  const options: CliOptions & { help?: boolean } = {};

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];

    if (!arg) continue;
    if (arg === '--help' || arg === '-h') {
      options.help = true;
      continue;
    }

    if (arg === '--all' || arg === '-a') {
      options.all = true;
      continue;
    }

    if (arg.startsWith('--id=')) {
      options.id = arg.slice('--id='.length);
      continue;
    }
    if (arg === '--id') {
      options.id = argv[i + 1];
      i += 1;
      continue;
    }

    if (arg.startsWith('--name=')) {
      options.name = arg.slice('--name='.length);
      continue;
    }
    if (arg === '--name') {
      options.name = argv[i + 1];
      i += 1;
      continue;
    }

    if (arg.startsWith('--wiki=')) {
      options.wiki = arg.slice('--wiki='.length);
      continue;
    }
    if (arg === '--wiki') {
      options.wiki = argv[i + 1];
      i += 1;
      continue;
    }

    if (arg === '--cache' || arg === '-c') {
      options.useCache = true;
      continue;
    }

    if (arg === '--refresh' || arg === '-r') {
      options.refresh = true;
      continue;
    }

    if (arg.startsWith('--gameMode=')) {
      const mode = arg.slice('--gameMode='.length);
      if (mode === 'regular' || mode === 'pve' || mode === 'both') {
        options.gameMode = mode;
      }
      continue;
    }
    if (arg === '--gameMode' || arg === '-g') {
      const mode = argv[i + 1];
      if (mode === 'regular' || mode === 'pve' || mode === 'both') {
        options.gameMode = mode;
        i += 1;
      }
      continue;
    }

    if (arg.startsWith('--output=')) {
      options.output = arg.slice('--output='.length);
      continue;
    }
    if (arg === '--output' || arg === '-o') {
      // Check if next arg exists and isn't a flag
      const nextArg = argv[i + 1];
      if (nextArg && !nextArg.startsWith('-')) {
        options.output = nextArg;
        i += 1;
      } else {
        options.output = ''; // Empty string means auto-generate filename
      }
      continue;
    }

    if (arg.startsWith('--group-by=')) {
      const groupBy = arg.slice('--group-by='.length);
      if (groupBy === 'priority' || groupBy === 'category') {
        options.groupBy = groupBy;
      }
      continue;
    }
    if (arg === '--group-by') {
      const groupBy = argv[i + 1];
      if (groupBy === 'priority' || groupBy === 'category') {
        options.groupBy = groupBy;
        i += 1;
      }
      continue;
    }

    if (!options.name) {
      options.name = arg;
    }
  }

  return options;
}

function printUsage(): void {
  console.log('Usage:');
  console.log('  tsx scripts/wiki-task-spike.ts [options] [taskName]');
  console.log();
  console.log('Options:');
  console.log('  --all, -a          Compare all tasks (bulk mode)');
  console.log('  --cache, -c        Use cached data if available');
  console.log('  --refresh, -r      Force refresh cache (fetch new data)');
  console.log('  --output, -o       Save results to file (auto-generates timestamp name)');
  console.log('  --group-by <type>  Group output by: priority or category (default: category)');
  console.log('  --gameMode, -g     Game mode: regular (PVP), pve, or both (default: both)');
  console.log('  --id <taskId>      Find task by ID');
  console.log('  --name <taskName>  Find task by name');
  console.log('  --wiki <pageTitle> Override wiki page title');
  console.log('  --help, -h         Show this help');
  console.log();
  console.log('Examples:');
  console.log('  tsx scripts/wiki-task-spike.ts Grenadier');
  console.log('  tsx scripts/wiki-task-spike.ts --all --cache');
  console.log('  tsx scripts/wiki-task-spike.ts --all --cache --group-by=priority');
  console.log('  tsx scripts/wiki-task-spike.ts --all --refresh --output');
  console.log('  tsx scripts/wiki-task-spike.ts --all --gameMode=pve --cache');
  console.log();
}

function normalizeName(value: string): string {
  return value.trim().toLowerCase();
}

/**
 * Normalize task name for comparison by removing common suffixes and variations
 */
function normalizeTaskName(value: string): string {
  return value
    .trim()
    .toLowerCase()
    // Remove [PVP ZONE] suffix
    .replace(/\s*\[pvp zone\]\s*$/i, '')
    // Remove (quest) disambiguation suffix
    .replace(/\s*\(quest\)\s*$/i, '')
    // Normalize hyphens to spaces for comparison
    .replace(/-/g, ' ')
    // Collapse multiple spaces
    .replace(/\s+/g, ' ')
    .trim();
}

function resolveTask(tasks: TaskData[], options: CliOptions): TaskData | undefined {
  if (options.id) {
    return findTaskById(tasks, options.id);
  }

  const name = options.name ?? DEFAULT_TASK_NAME;
  const normalized = normalizeName(name);
  return tasks.find(task => normalizeName(task.name) === normalized);
}

function resolveWikiTitle(task: TaskData, wikiOverride?: string): string {
  if (wikiOverride && wikiOverride.trim().length > 0) {
    return wikiOverride.trim();
  }

  if (task.wikiLink) {
    const match = task.wikiLink.match(/\/wiki\/(.+)$/);
    if (match && match[1]) {
      return decodeURIComponent(match[1]);
    }
  }

  return task.name;
}

type WikiFetchResult = {
  title: string;
  wikitext: string;
  lastRevision?: {
    timestamp: string;
    user: string;
    comment: string;
  };
};

async function fetchWikiWikitext(pageTitle: string): Promise<WikiFetchResult> {
  // Fetch wikitext
  const parseParams = new URLSearchParams({
    action: 'parse',
    page: pageTitle,
    prop: 'wikitext',
    format: 'json',
  });

  const parseResponse = await fetch(`${WIKI_API}?${parseParams.toString()}`);
  if (!parseResponse.ok) {
    throw new Error(`Wiki request failed: ${parseResponse.status} ${parseResponse.statusText}`);
  }

  const parseData = await parseResponse.json() as {
    parse?: {
      title?: string;
      wikitext?: { '*': string };
    };
    error?: { info?: string };
  };

  if (parseData.error?.info) {
    throw new Error(`Wiki error: ${parseData.error.info}`);
  }

  const wikitext = parseData.parse?.wikitext?.['*'];
  if (!wikitext) {
    throw new Error('Wiki response missing wikitext');
  }

  const title = parseData.parse?.title ?? pageTitle;

  // Fetch last revision info
  const revParams = new URLSearchParams({
    action: 'query',
    titles: title,
    prop: 'revisions',
    rvprop: 'timestamp|user|comment',
    rvlimit: '1',
    format: 'json',
  });

  let lastRevision: WikiFetchResult['lastRevision'];
  try {
    const revResponse = await fetch(`${WIKI_API}?${revParams.toString()}`);
    if (revResponse.ok) {
      const revData = await revResponse.json() as {
        query?: {
          pages?: Record<string, {
            revisions?: Array<{
              timestamp?: string;
              user?: string;
              comment?: string;
            }>;
          }>;
        };
      };

      const pages = revData.query?.pages;
      if (pages) {
        const page = Object.values(pages)[0];
        const rev = page?.revisions?.[0];
        if (rev?.timestamp) {
          lastRevision = {
            timestamp: rev.timestamp,
            user: rev.user ?? 'unknown',
            comment: rev.comment ?? '',
          };
        }
      }
    }
  } catch {
    // Revision fetch failed, continue without it
  }

  return { title, wikitext, lastRevision };
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function extractSectionLines(wikitext: string, heading: string): string[] {
  const lines = wikitext.split('\n');
  const headingRegex = new RegExp(`^==\\s*${escapeRegExp(heading)}\\s*==\\s*$`, 'i');
  const startIndex = lines.findIndex(line => headingRegex.test(line.trim()));
  if (startIndex === -1) return [];

  const items: string[] = [];
  for (let i = startIndex + 1; i < lines.length; i += 1) {
    const raw = lines[i].trim();
    if (raw.startsWith('==')) break;
    // Capture bullet points
    if (raw.startsWith('*')) {
      items.push(raw.replace(/^\*+\s*/, ''));
      continue;
    }
    // Also capture Note lines (for PvE/PvP differences)
    if (raw.startsWith("'''Note:") || raw.startsWith("''Note:")) {
      items.push(raw);
    }
  }

  return items;
}

function stripWikiMarkup(value: string): string {
  return value
    .replace(/<[^>]+>/g, '')
    .replace(/''+/g, '')
    .replace(/\[\[(?:[^|\]]*\|)?([^\]]+)\]\]/g, '$1')
    .replace(/\s+/g, ' ')
    .trim();
}

function parseMinLevel(requirements: string[]): number | undefined {
  for (const line of requirements) {
    const match = stripWikiMarkup(line).match(/level\s+(\d+)/i);
    if (match && match[1]) {
      return Number(match[1]);
    }
  }
  return undefined;
}

function extractCount(text: string): number | undefined {
  // Skip numbers that are likely NOT counts:
  // - Numbers followed by "meter(s)" (distance requirements)
  // - 4-digit numbers starting with 0 (item IDs like "0052")
  // - Numbers in item names (e.g., "Folder 0052", "M700", "TAC30")

  // First, remove distance patterns like "75 meters"
  const withoutDistances = text.replace(/\b\d+\s*meters?\b/gi, '');
  // Remove item model numbers (letters followed by numbers or vice versa)
  const withoutModelNumbers = withoutDistances.replace(/\b[A-Za-z]+\d+\b/g, '').replace(/\b\d+[A-Za-z]+\b/g, '');
  // Remove 4-digit numbers starting with 0 (item IDs)
  const withoutItemIds = withoutModelNumbers.replace(/\b0\d{3,}\b/g, '');

  // Now extract count - look for standalone numbers
  const match = withoutItemIds.match(/\b([\d,]+)\b/);
  return match ? Number(match[1].replace(/,/g, '')) : undefined;
}

function parseObjectives(lines: string[]): WikiObjective[] {
  const objectives: WikiObjective[] = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const clean = stripWikiMarkup(line);

    // Check if this is a PvE note line (not a main objective)
    // Pattern: "Note: The objective in the PvE mode is to ... X targets"
    const isPveNote = /PvE\s*mode/i.test(line) || /PVE/i.test(line);
    if (isPveNote && objectives.length > 0) {
      // Extract PvE count and attach to previous objective
      const pveCount = extractCount(clean);
      if (pveCount !== undefined) {
        objectives[objectives.length - 1].pveCount = pveCount;
      }
      continue;
    }

    // Skip Note lines that aren't PvE-specific
    if (/^'''?Note:?'''?/i.test(line.trim())) {
      continue;
    }

    // Regular objective line
    objectives.push({
      text: clean,
      count: extractCount(clean),
    });
  }

  return objectives;
}

function parseRewards(lines: string[]): WikiRewards {
  let xp: number | undefined;
  const reputations: TraderReputation[] = [];
  let money: number | undefined;
  const items: Array<{ name: string; count: number }> = [];

  for (const line of lines) {
    const clean = stripWikiMarkup(line);

    const xpMatch = clean.match(/\+?([\d,]+)\s*EXP/i);
    if (xpMatch && xpMatch[1]) {
      xp = Number(xpMatch[1].replace(/,/g, ''));
      continue;
    }

    // Extract trader name and reputation value
    // Wiki format: "[[Prapor]] Rep +0.02" or "Prapor Rep +0.02"
    const repMatch = clean.match(/(\w+)\s+Rep\s*\+?([0-9.]+)/i);
    if (repMatch && repMatch[1] && repMatch[2]) {
      reputations.push({
        trader: repMatch[1],
        value: Number(repMatch[2]),
      });
      continue;
    }

    // Only take first rouble value (base amount, not IC bonuses)
    if (money === undefined) {
      const moneyMatch = clean.match(/([\d,]+)\s*Roubles/i);
      if (moneyMatch && moneyMatch[1]) {
        money = Number(moneyMatch[1].replace(/,/g, ''));
        continue;
      }
    }

    const itemMatch = clean.match(new RegExp(`^(\\d+)\\s*(?:x|\\u00d7)\\s*(.+)$`, 'i'));
    if (itemMatch && itemMatch[1] && itemMatch[2]) {
      items.push({ count: Number(itemMatch[1]), name: itemMatch[2].trim() });
    }
  }

  return {
    xp,
    reputations,
    money,
    items,
    raw: lines.map(stripWikiMarkup),
  };
}

function parseInfoboxLinks(wikitext: string, field: string): string[] {
  // Use [ \t]* instead of \s* to avoid matching newlines
  const regex = new RegExp(`^\\|\\s*${escapeRegExp(field)}\\s*=[ \\t]*(.+)$`, 'mi');
  const match = wikitext.match(regex);
  if (!match || !match[1]) return [];
  const value = match[1].trim();
  const results: string[] = [];

  const linkRegex = /\[\[([^|\]]+)/g;
  let linkMatch: RegExpExecArray | null = linkRegex.exec(value);
  while (linkMatch) {
    if (linkMatch[1]) {
      results.push(stripWikiMarkup(linkMatch[1]));
    }
    linkMatch = linkRegex.exec(value);
  }

  return results;
}

function parseWikiTask(
  pageTitle: string,
  wikitext: string,
  lastRevision?: WikiTaskData['lastRevision']
): WikiTaskData {
  const requirements = extractSectionLines(wikitext, 'Requirements');
  const objectivesLines = extractSectionLines(wikitext, 'Objectives');
  const rewardsLines = extractSectionLines(wikitext, 'Rewards');

  return {
    pageTitle,
    requirements,
    objectives: parseObjectives(objectivesLines),
    rewards: parseRewards(rewardsLines),
    minPlayerLevel: parseMinLevel(requirements),
    previousTasks: parseInfoboxLinks(wikitext, 'previous'),
    lastRevision,
  };
}

function printWikiData(wiki: WikiTaskData): void {
  printHeader('WIKI EXTRACTION');
  console.log(`${bold('Page')}: ${wiki.pageTitle}`);

  // Show last revision info
  if (wiki.lastRevision) {
    const revDate = new Date(wiki.lastRevision.timestamp);
    const daysAgo = Math.floor((Date.now() - revDate.getTime()) / (1000 * 60 * 60 * 24));
    const dateStr = revDate.toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric' });
    const isPost1_0 = revDate >= TARKOV_1_0_LAUNCH;
    const freshness = isPost1_0 ? '🟢 Post-1.0' : '🔴 Pre-1.0';
    console.log(`${bold('Last Edit')}: ${dateStr} (${daysAgo} days ago) ${freshness}`);
    console.log(`  ${dim(`by ${wiki.lastRevision.user}`)}`);
  }

  console.log(`${bold('Requirements')}: ${wiki.requirements.length}`);
  for (const line of wiki.requirements) {
    console.log(`  - ${stripWikiMarkup(line)}`);
  }
  if (wiki.minPlayerLevel !== undefined) {
    console.log(`  ${dim(`Detected level requirement: ${wiki.minPlayerLevel}`)}`);
  }

  console.log();
  console.log(`${bold('Objectives')}: ${wiki.objectives.length}`);
  for (const obj of wiki.objectives) {
    const count = obj.count !== undefined ? ` (count: ${obj.count})` : '';
    console.log(`  - ${obj.text}${count}`);
  }

  console.log();
  console.log(`${bold('Rewards')}: ${wiki.rewards.raw.length}`);
  for (const reward of wiki.rewards.raw) {
    console.log(`  - ${reward}`);
  }
  if (wiki.rewards.items.length > 0) {
    console.log(`  ${dim(`Parsed ${wiki.rewards.items.length} reward item(s)`)}`);
  }

  console.log();
  if (wiki.previousTasks.length > 0) {
    console.log(`${bold('Previous Tasks')}: ${wiki.previousTasks.join(', ')}`);
  }
  console.log();
}

function compareTasks(apiTask: ExtendedTaskData, wiki: WikiTaskData, verbose = true): Discrepancy[] {
  const discrepancies: Discrepancy[] = [];
  const taskId = apiTask.id;
  const taskName = apiTask.name;

  // Calculate wiki edit age for discrepancy context
  let wikiLastEdit: string | undefined;
  let wikiEditDaysAgo: number | undefined;
  let wikiEditedPost1_0: boolean | undefined;
  if (wiki.lastRevision?.timestamp) {
    const revDate = new Date(wiki.lastRevision.timestamp);
    wikiLastEdit = revDate.toISOString().split('T')[0];
    wikiEditDaysAgo = Math.floor((Date.now() - revDate.getTime()) / (1000 * 60 * 60 * 24));
    wikiEditedPost1_0 = revDate >= TARKOV_1_0_LAUNCH;
  }

  if (verbose) printHeader('COMPARISON');

  // minPlayerLevel
  if (wiki.minPlayerLevel !== undefined) {
    if (apiTask.minPlayerLevel !== wiki.minPlayerLevel) {
      discrepancies.push({
        taskId, taskName, field: 'minPlayerLevel',
        apiValue: apiTask.minPlayerLevel, wikiValue: wiki.minPlayerLevel,
        priority: getPriority('minPlayerLevel'), trustsWiki: true,
        wikiLastEdit, wikiEditDaysAgo, wikiEditedPost1_0,
      });
      if (verbose) console.log(`${icons.warning} minPlayerLevel: API=${apiTask.minPlayerLevel}, Wiki=${wiki.minPlayerLevel}`);
    } else if (verbose) {
      console.log(`${icons.success} minPlayerLevel matches (${apiTask.minPlayerLevel})`);
    }
  }

  // Objective counts - handle PvE vs PvP differences
  const apiCounts = (apiTask.objectives ?? [])
    .map(obj => obj.count).filter((c): c is number => typeof c === 'number');

  // Get wiki counts, considering PvE-specific values if API task is PvE-only
  const isPveTask = apiTask.gameModes?.length === 1 && apiTask.gameModes[0] === 'pve';
  const wikiCounts = wiki.objectives.map(obj => {
    // If task is PvE-only and wiki has PvE-specific count, use that
    if (isPveTask && obj.pveCount !== undefined) {
      return obj.pveCount;
    }
    return obj.count;
  }).filter((c): c is number => typeof c === 'number');

  // Also track if wiki has mode-specific data for this objective
  const hasPveDifference = wiki.objectives.some(obj => obj.pveCount !== undefined);

  if (apiCounts.length === 1 && wikiCounts.length === 1) {
    if (apiCounts[0] !== wikiCounts[0]) {
      // Check if this might be a PvE/PvP mismatch we should skip
      const wikiPvpCount = wiki.objectives[0]?.count;
      const wikiPveCount = wiki.objectives[0]?.pveCount;

      // If wiki has both values and API matches one of them, it's not a real discrepancy
      if (hasPveDifference && (apiCounts[0] === wikiPvpCount || apiCounts[0] === wikiPveCount)) {
        if (verbose) {
          console.log(`${icons.info} objective count: API=${apiCounts[0]} matches wiki ${apiCounts[0] === wikiPveCount ? 'PvE' : 'PvP'} value (PvP=${wikiPvpCount}, PvE=${wikiPveCount})`);
        }
      } else {
        discrepancies.push({
          taskId, taskName, field: 'objectives.count',
          apiValue: apiCounts[0], wikiValue: wikiCounts[0],
          priority: getPriority('objectives.count'), trustsWiki: true,
          wikiLastEdit, wikiEditDaysAgo, wikiEditedPost1_0,
        });
        if (verbose) console.log(`${icons.warning} objective count: API=${apiCounts[0]}, Wiki=${wikiCounts[0]}`);
      }
    } else if (verbose) {
      console.log(`${icons.success} objective count matches (${apiCounts[0]})`);
    }
  } else if (verbose) {
    console.log(`${icons.info} objective counts: API=${apiCounts.join(', ') || 'none'}, Wiki=${wikiCounts.join(', ') || 'none'}`);
  }

  // Prerequisites
  if (wiki.previousTasks.length > 0) {
    const apiReqNames = (apiTask.taskRequirements ?? [])
      .map(req => req.task?.name).filter((n): n is string => Boolean(n));
    const normalizedApi = new Set(apiReqNames.map(normalizeTaskName));
    const missing = wiki.previousTasks.filter(t => !normalizedApi.has(normalizeTaskName(t)));

    if (missing.length > 0) {
      discrepancies.push({
        taskId, taskName, field: 'taskRequirements',
        apiValue: apiReqNames.join(', ') || 'none', wikiValue: wiki.previousTasks.join(', '),
        priority: getPriority('taskRequirements'), trustsWiki: true,
        wikiLastEdit, wikiEditDaysAgo, wikiEditedPost1_0,
      });
      if (verbose) console.log(`${icons.warning} prerequisites missing in API: ${missing.join(', ')}`);
    } else if (verbose) {
      console.log(`${icons.success} prerequisites present in API`);
    }
  }

  // Experience (XP)
  if (wiki.rewards.xp !== undefined && apiTask.experience !== undefined) {
    if (apiTask.experience !== wiki.rewards.xp) {
      discrepancies.push({
        taskId, taskName, field: 'experience',
        apiValue: apiTask.experience, wikiValue: wiki.rewards.xp,
        priority: getPriority('experience'), trustsWiki: true,
        wikiLastEdit, wikiEditDaysAgo, wikiEditedPost1_0,
      });
      if (verbose) console.log(`${icons.warning} experience: API=${apiTask.experience}, Wiki=${wiki.rewards.xp}`);
    } else if (verbose) {
      console.log(`${icons.success} experience matches (${apiTask.experience})`);
    }
  }

  // Reputation (per trader)
  if (wiki.rewards.reputations.length > 0 && apiTask.finishRewards?.traderStanding) {
    for (const wikiRep of wiki.rewards.reputations) {
      // Find matching trader in API data (case-insensitive)
      const apiTraderRep = apiTask.finishRewards.traderStanding.find(
        t => t.trader.name.toLowerCase() === wikiRep.trader.toLowerCase()
      );

      if (apiTraderRep) {
        if (Math.abs(apiTraderRep.standing - wikiRep.value) > 0.001) {
          discrepancies.push({
            taskId, taskName, field: `reputation.${wikiRep.trader}`,
            apiValue: apiTraderRep.standing, wikiValue: wikiRep.value,
            priority: getPriority('reputation'), trustsWiki: true,
            wikiLastEdit, wikiEditDaysAgo, wikiEditedPost1_0,
          });
          if (verbose) {
            console.log(`${icons.warning} ${wikiRep.trader} rep: API=${apiTraderRep.standing}, Wiki=${wikiRep.value}`);
          }
        } else if (verbose) {
          console.log(`${icons.success} ${wikiRep.trader} rep matches (${apiTraderRep.standing})`);
        }
      } else if (verbose) {
        console.log(`${icons.info} ${wikiRep.trader} rep: Wiki=${wikiRep.value}, not found in API`);
      }
    }
  }

  // Money (Roubles)
  if (wiki.rewards.money !== undefined && apiTask.finishRewards?.items) {
    const apiMoney = apiTask.finishRewards.items.find(i => i.item.name === 'Roubles')?.count;
    if (apiMoney !== undefined && apiMoney !== wiki.rewards.money) {
      discrepancies.push({
        taskId, taskName, field: 'money',
        apiValue: apiMoney, wikiValue: wiki.rewards.money,
        priority: getPriority('money'), trustsWiki: true,
        wikiLastEdit, wikiEditDaysAgo, wikiEditedPost1_0,
      });
      if (verbose) console.log(`${icons.warning} money: API=${apiMoney}, Wiki=${wiki.rewards.money}`);
    } else if (verbose && apiMoney !== undefined) {
      console.log(`${icons.success} money matches (${apiMoney})`);
    }
  }

  if (verbose) {
    console.log();
    if (discrepancies.length === 0) {
      printSuccess('No discrepancies detected.');
    } else {
      printSuccess(`Detected ${discrepancies.length} discrepancy(ies).`);
    }
  }

  return discrepancies;
}

async function runSingleTask(tasks: ExtendedTaskData[], options: CliOptions): Promise<void> {
  const task = resolveTask(tasks, options);
  if (!task) {
    printError(`Task not found (id=${options.id ?? 'n/a'}, name=${options.name ?? DEFAULT_TASK_NAME})`);
    printUsage();
    process.exit(1);
  }

  const wikiTitle = resolveWikiTitle(task, options.wiki);
  printProgress(`Fetching wiki wikitext for "${wikiTitle}"...`);
  const wikiResponse = await fetchWikiWikitext(wikiTitle);
  printSuccess(`Fetched wiki page "${wikiResponse.title}"`);

  const wikiData = parseWikiTask(wikiResponse.title, wikiResponse.wikitext, wikiResponse.lastRevision);
  printWikiData(wikiData);
  compareTasks(task, wikiData);
}

async function runBulkMode(tasks: ExtendedTaskData[], options: CliOptions): Promise<void> {
  const tasksWithWiki = tasks.filter(t => t.wikiLink);
  printProgress(`Found ${tasksWithWiki.length}/${tasks.length} tasks with wiki links`);

  // Load suppressed fields (overlay corrections + wiki-incorrect suppressions)
  const { suppressed, overlayCount, wikiIncorrectCount } = loadSuppressedFields();
  if (overlayCount > 0 || wikiIncorrectCount > 0) {
    printProgress(`Loaded ${overlayCount} overlay correction(s), ${wikiIncorrectCount} wiki-incorrect suppression(s)`);
  }

  const allDiscrepancies: Discrepancy[] = [];
  let checked = 0;
  let errors = 0;
  let cacheHits = 0;

  for (const task of tasksWithWiki) {
    checked += 1;
    const wikiTitle = resolveWikiTitle(task);
    process.stdout.write(`\r[${checked}/${tasksWithWiki.length}] ${task.name.padEnd(40)}`);

    try {
      let wikiResponse: WikiFetchResult;
      const wikiCache = options.useCache && !options.refresh ? loadWikiCache(task.id) : null;

      if (wikiCache) {
        wikiResponse = {
          title: wikiCache.title,
          wikitext: wikiCache.wikitext,
          lastRevision: wikiCache.lastRevision,
        };
        cacheHits += 1;
      } else {
        wikiResponse = await fetchWikiWikitext(wikiTitle);
        saveWikiCache(task.id, wikiResponse.title, wikiResponse.wikitext, wikiResponse.lastRevision);
        await sleep(RATE_LIMIT_MS);
      }

      const wikiData = parseWikiTask(wikiResponse.title, wikiResponse.wikitext, wikiResponse.lastRevision);
      const discrepancies = compareTasks(task, wikiData, false);
      allDiscrepancies.push(...discrepancies);
    } catch {
      errors += 1;
    }
  }

  console.log('\n');
  printHeader('BULK RESULTS');
  console.log(`Tasks checked: ${checked}`);
  console.log(`Wiki cache hits: ${cacheHits}`);
  console.log(`Wiki errors: ${errors}`);
  console.log(`Total discrepancies found: ${allDiscrepancies.length}`);

  // Filter out suppressed discrepancies (overlay corrections + wiki-incorrect)
  const newDiscrepancies = allDiscrepancies.filter(d => {
    const key = `${d.taskId}:${d.field}`;
    return !suppressed.has(key);
  });
  const filteredCount = allDiscrepancies.length - newDiscrepancies.length;

  if (filteredCount > 0) {
    console.log(`${dim(`Suppressed (overlay + wiki-incorrect): ${filteredCount}`)}`);
  }
  console.log(`${bold(`New discrepancies to review: ${newDiscrepancies.length}`)}`);

  // Post-1.0 wiki edit summary
  const post1_0Count = newDiscrepancies.filter(d => d.wikiEditedPost1_0 === true).length;
  const pre1_0Count = newDiscrepancies.filter(d => d.wikiEditedPost1_0 === false).length;
  const unknownCount = newDiscrepancies.filter(d => d.wikiEditedPost1_0 === undefined).length;

  if (post1_0Count > 0 || pre1_0Count > 0) {
    console.log();
    printHeader('WIKI DATA FRESHNESS (1.0 = Nov 15, 2025)');
    console.log(`  🟢 Post-1.0 wiki edits: ${post1_0Count} ${dim('(high confidence)')}`);
    console.log(`  🔴 Pre-1.0 wiki edits: ${pre1_0Count} ${dim('(may be outdated)')}`);
    if (unknownCount > 0) {
      console.log(`  ⚪ Unknown: ${unknownCount} ${dim('(no revision data)')}`);
    }
  }
  console.log();

  if (newDiscrepancies.length > 0) {
    const groupBy = options.groupBy ?? 'category';

    // Priority order and labels
    const priorityOrder: Priority[] = ['high', 'medium', 'low'];
    const priorityLabels: Record<Priority, string> = {
      high: '🔴 HIGH',
      medium: '🟡 MEDIUM',
      low: '🟢 LOW',
    };

    const priorityIcons: Record<Priority, string> = {
      high: '🔴',
      medium: '🟡',
      low: '🟢',
    };

    const categoryLabels: Record<string, string> = {
      'minPlayerLevel': 'Level Requirements',
      'taskRequirements': 'Task Prerequisites',
      'experience': 'Reward: Experience (XP)',
      'money': 'Reward: Money (Roubles)',
      'objectives.count': 'Objective Counts',
    };

    // Define category display order (most important first)
    const categoryOrder = [
      'minPlayerLevel',
      'taskRequirements',
      'objectives.count',
      'experience',
      'money',
      // Reputation fields will be sorted alphabetically after these
    ];

    // Helper to get category label (handles dynamic reputation.TraderName fields)
    const getCategoryLabel = (field: string): string => {
      if (field.startsWith('reputation.')) {
        const trader = field.replace('reputation.', '');
        return `Reward: Reputation (${trader})`;
      }
      return categoryLabels[field] ?? field;
    };

    // Helper to print a single discrepancy
    const printDiscrepancy = (d: Discrepancy, showPriority: boolean, showCategory: boolean): void => {
      const freshness = d.wikiEditedPost1_0 === true ? '🟢' :
                        d.wikiEditedPost1_0 === false ? '🔴' : '⚪';
      const editInfo = d.wikiEditDaysAgo !== undefined ? `${d.wikiEditDaysAgo}d ago` : '';
      const priorityPrefix = showPriority ? `${priorityIcons[d.priority]} ` : '  ';
      const categoryInfo = showCategory ? ` ${dim(`[${getCategoryLabel(d.field)}]`)}` : '';

      console.log(`\n${priorityPrefix}${d.taskName}${categoryInfo}`);
      console.log(`    ${dim(`ID: ${d.taskId}`)}`);
      console.log(`    API:  ${d.apiValue}`);
      console.log(`    Wiki: ${d.wikiValue} ${d.trustsWiki ? dim('← likely correct') : ''}`);
      if (editInfo) {
        console.log(`    ${dim(`Wiki edit: ${freshness} ${editInfo}`)}`);
      }
    };

    // Group by priority
    const byPriority = new Map<Priority, Discrepancy[]>();
    for (const p of priorityOrder) {
      byPriority.set(p, []);
    }
    for (const d of newDiscrepancies) {
      byPriority.get(d.priority)!.push(d);
    }

    // Group by category
    const byCategory = new Map<string, Discrepancy[]>();
    for (const d of newDiscrepancies) {
      const field = d.field;
      if (!byCategory.has(field)) byCategory.set(field, []);
      byCategory.get(field)!.push(d);
    }

    const sortedCategories = Array.from(byCategory.keys()).sort((a, b) => {
      const aIdx = categoryOrder.indexOf(a);
      const bIdx = categoryOrder.indexOf(b);
      if (aIdx !== -1 && bIdx !== -1) return aIdx - bIdx;
      if (aIdx !== -1) return -1;
      if (bIdx !== -1) return 1;
      return a.localeCompare(b);
    });

    // Print summary
    printHeader('SUMMARY');
    console.log(`  Grouping by: ${bold(groupBy.toUpperCase())}`);
    console.log();
    console.log('  By Priority:');
    for (const p of priorityOrder) {
      const count = byPriority.get(p)!.length;
      if (count > 0) {
        console.log(`    ${priorityLabels[p]}: ${count}`);
      }
    }
    console.log();
    console.log('  By Category:');
    for (const field of sortedCategories) {
      const discs = byCategory.get(field)!;
      const label = getCategoryLabel(field);
      console.log(`    ${label}: ${discs.length}`);
    }
    console.log();

    // Print details based on groupBy mode
    if (groupBy === 'category') {
      printHeader('DISCREPANCIES BY CATEGORY');

      for (const field of sortedCategories) {
        const discs = byCategory.get(field)!;
        const label = getCategoryLabel(field);

        // Sort by priority within category (high first)
        discs.sort((a, b) => {
          const order = { high: 0, medium: 1, low: 2 };
          return order[a.priority] - order[b.priority];
        });

        console.log(`\n${'─'.repeat(60)}`);
        console.log(`${bold(label)} (${discs.length})`);
        console.log(`${'─'.repeat(60)}`);

        for (const d of discs) {
          printDiscrepancy(d, true, false);
        }
      }
    } else {
      // groupBy === 'priority'
      printHeader('DISCREPANCIES BY PRIORITY');

      for (const p of priorityOrder) {
        const discs = byPriority.get(p)!;
        if (discs.length === 0) continue;

        // Sort by category within priority
        discs.sort((a, b) => {
          const aIdx = categoryOrder.indexOf(a.field);
          const bIdx = categoryOrder.indexOf(b.field);
          if (aIdx !== -1 && bIdx !== -1) return aIdx - bIdx;
          if (aIdx !== -1) return -1;
          if (bIdx !== -1) return 1;
          return a.field.localeCompare(b.field);
        });

        console.log(`\n${'─'.repeat(60)}`);
        console.log(`${bold(priorityLabels[p])} (${discs.length})`);
        console.log(`${'─'.repeat(60)}`);

        for (const d of discs) {
          printDiscrepancy(d, false, true);
        }
      }
    }
    console.log();
  }

  // Save results to file if requested
  if (options.output !== undefined) {
    ensureDir(RESULTS_DIR);
    const groupBy = options.groupBy ?? 'category';
    const timestamp = getTimestamp();
    const outputFile = path.join(RESULTS_DIR, `comparison-${timestamp}.json`);

    // Group by priority
    const byPriority: Record<string, Discrepancy[]> = { high: [], medium: [], low: [] };
    for (const d of newDiscrepancies) {
      byPriority[d.priority].push(d);
    }

    // Group by category
    const byCategory: Record<string, Discrepancy[]> = {};
    for (const d of newDiscrepancies) {
      if (!byCategory[d.field]) byCategory[d.field] = [];
      byCategory[d.field].push(d);
    }

    const results = {
      meta: {
        generatedAt: new Date().toISOString(),
        tasksChecked: checked,
        cacheHits,
        errors,
        totalDiscrepancies: allDiscrepancies.length,
        alreadyAddressed: filteredCount,
        newDiscrepancies: newDiscrepancies.length,
        groupBy,
      },
      wikiDataFreshness: {
        post1_0: post1_0Count,
        pre1_0: pre1_0Count,
        unknown: unknownCount,
        note: 'Tarkov 1.0 launched Nov 15, 2025. Post-1.0 wiki edits are high confidence.',
      },
      summary: {
        byPriority: {
          high: byPriority.high.length,
          medium: byPriority.medium.length,
          low: byPriority.low.length,
        },
        byCategory: Object.fromEntries(
          Object.entries(byCategory).map(([k, v]) => [k, v.length])
        ),
      },
      // Primary grouping based on --group-by flag
      discrepancies: groupBy === 'category' ? byCategory : byPriority,
    };
    fs.writeFileSync(outputFile, JSON.stringify(results, null, 2));
    printSuccess(`Results saved to ${outputFile}`);
  }
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));

  if (options.help) {
    printUsage();
    return;
  }

  printHeader('WIKI TASK SPIKE');

  const gameMode = options.gameMode ?? 'both';
  const modeLabel = gameMode === 'both' ? 'PVP + PVE (deduplicated)' :
                    gameMode === 'regular' ? 'PVP only' : 'PVE only';

  // Load or fetch API data
  let tasks: ExtendedTaskData[];
  const apiCache = options.useCache && !options.refresh ? loadApiCache() : null;

  // Only use cache if it matches the requested game mode
  const cacheMatchesMode = apiCache?.meta.gameMode === gameMode;

  if (apiCache && cacheMatchesMode) {
    tasks = apiCache.tasks;
    printSuccess(`Loaded ${tasks.length} tasks from cache [${modeLabel}] (${apiCache.meta.fetchedAt})`);
  } else {
    printProgress(`Fetching tasks from tarkov.dev API [${modeLabel}]...`);
    tasks = await fetchExtendedTasks(gameMode);
    saveApiCache(tasks, gameMode);
    printSuccess(`Fetched ${tasks.length} unique tasks [${modeLabel}]`);
  }

  if (options.all) {
    await runBulkMode(tasks, options);
  } else {
    await runSingleTask(tasks, options);
  }
}

main().catch(error => {
  printError('Wiki spike failed:', error as Error);
  process.exit(1);
});
