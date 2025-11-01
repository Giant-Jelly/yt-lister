import { appendFile, readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import 'dotenv/config';
import * as path from 'node:path';

type SearchListResponse = {
  items?: Array<{
    id?: { channelId?: string };
  }>;
  nextPageToken?: string;
};

type ChannelListResponse = {
  items?: Array<ChannelDetail>;
};

type ChannelDetail = {
  id?: string;
  snippet?: {
    title?: string;
    customUrl?: string;
    country?: string;
    description?: string;
  };
  statistics?: {
    subscriberCount?: string;
    hiddenSubscriberCount?: boolean;
  };
  topicDetails?: {
    topicCategories?: string[];
  };
};

type CsvRow = {
  channelId: string;
  channelName: string;
  channelUrl: string;
  subscriberCount: number;
  country?: string | undefined;
  regionCode: string;
  niche?: string | undefined;
  topicCategories?: string | undefined;
  description?: string | undefined;
};

const rawApiKey = process.env.YOUTUBE_API_KEY;

if (!rawApiKey) {
  throw new Error('Missing YOUTUBE_API_KEY in environment.');
}

const API_KEY = rawApiKey;

const DEFAULT_TARGET = 10;
const TARGET_NEW_CHANNELS = normalizeNumber(
  process.env.CHANNEL_TARGET ?? process.argv[2],
  DEFAULT_TARGET,
);

const SUBSCRIBER_TARGET = normalizeNumber(
  process.env.SUBSCRIBER_TARGET,
  20_000,
);

const SUBSCRIBER_TOLERANCE = normalizeNumber(
  process.env.SUBSCRIBER_TOLERANCE,
  5_000,
);

const MIN_SUBSCRIBERS = normalizeNumber(
  process.env.MIN_SUBSCRIBERS,
  SUBSCRIBER_TARGET - SUBSCRIBER_TOLERANCE,
);

const MAX_SUBSCRIBERS = normalizeNumber(
  process.env.MAX_SUBSCRIBERS,
  SUBSCRIBER_TARGET + SUBSCRIBER_TOLERANCE,
);

if (MIN_SUBSCRIBERS > MAX_SUBSCRIBERS) {
  throw new Error('MIN_SUBSCRIBERS cannot be greater than MAX_SUBSCRIBERS.');
}

const REGIONS = sanitizeList(process.env.REGIONS ?? 'GB,US');
const SEARCH_TERMS = sanitizeList(
  process.env.SEARCH_TERMS ?? 'the,club,studio,life,tech,food',
);

const OUTPUT_FILE = path.resolve(process.cwd(), 'data', 'channels.csv');
const CSV_HEADERS: Array<keyof CsvRow> = [
  'channelId',
  'channelName',
  'channelUrl',
  'subscriberCount',
  'country',
  'regionCode',
  'niche',
  'topicCategories',
  'description',
];

async function main(): Promise<void> {
  await ensureCsvFile();
  const existingIds = await loadExistingChannelIds();

  if (TARGET_NEW_CHANNELS <= 0) {
    console.warn('CHANNEL_TARGET must be greater than 0 to pull new data.');
    return;
  }

  console.info(
    `Hunting for up to ${TARGET_NEW_CHANNELS} new channels between ${MIN_SUBSCRIBERS.toLocaleString()} and ${MAX_SUBSCRIBERS.toLocaleString()} subscribers across regions [${REGIONS.join(', ')}].`,
  );

  const newRows: CsvRow[] = [];

  for (const term of SEARCH_TERMS) {
    console.info(`\nSearching term: "${term}"`);
    for (const region of REGIONS) {
      console.info(`  Region: ${region}`);
      let pageToken: string | undefined;
      let attempts = 0;

      do {
        attempts += 1;
        const searchResponse = await searchChannels({
          query: term,
          regionCode: region,
          ...(pageToken ? { pageToken } : {}),
        });

        const channelIds = (searchResponse.items ?? [])
          .map((item) => item.id?.channelId)
          .filter((id): id is string => Boolean(id));

        if (channelIds.length === 0) {
          console.info('    No channel IDs found in this page, moving on.');
          pageToken = searchResponse.nextPageToken;
          continue;
        }

        const details = await fetchChannelDetails(channelIds);

        for (const detail of details) {
          const row = transformToRow(detail, region);
          if (!row) {
            continue;
          }

          if (existingIds.has(row.channelId)) {
            continue;
          }

          existingIds.add(row.channelId);
          newRows.push(row);
          console.info(
            `Queued ${row.channelName} (${row.subscriberCount.toLocaleString()} subs, ${row.regionCode})`,
          );

          if (newRows.length >= TARGET_NEW_CHANNELS) {
            console.info('    Target reached, stopping early.');
            break;
          }
        }

        if (newRows.length >= TARGET_NEW_CHANNELS) {
          break;
        }

        pageToken = searchResponse.nextPageToken;
        if (pageToken) {
          console.info('    Fetching next page...');
        }
        await sleep(150);
      } while (pageToken && newRows.length < TARGET_NEW_CHANNELS && attempts < 10);

      if (newRows.length >= TARGET_NEW_CHANNELS) {
        break;
      }
    }

    if (newRows.length >= TARGET_NEW_CHANNELS) {
      break;
    }
  }

  if (newRows.length === 0) {
    console.warn('No new channels found that match the current filters.');
    return;
  }

  await appendRows(newRows);
  console.info(`
Added ${newRows.length} channel${newRows.length === 1 ? '' : 's'} to ${path.relative(process.cwd(), OUTPUT_FILE)}.`);
}

function sanitizeList(raw: string): string[] {
  return raw
    .split(',')
    .map((value) => value.trim())
    .filter((value) => value.length > 0);
}

function normalizeNumber(value: string | undefined, fallback: number): number {
  if (!value) {
    return fallback;
  }

  const parsed = Number.parseInt(value, 10);

  return Number.isFinite(parsed) ? parsed : fallback;
}

async function ensureCsvFile(): Promise<void> {
  const headerPrefix = CSV_HEADERS.join(',');
  const headerLine = `${headerPrefix}\n`;

  if (!existsSync(OUTPUT_FILE)) {
    await writeFile(OUTPUT_FILE, headerLine, 'utf8');
    return;
  }

  const existingHeader = await readFile(OUTPUT_FILE, 'utf8');
  if (!existingHeader.startsWith(headerPrefix)) {
    await writeFile(OUTPUT_FILE, `${headerLine}${existingHeader}`);
  }
}

async function loadExistingChannelIds(): Promise<Set<string>> {
  if (!existsSync(OUTPUT_FILE)) {
    return new Set();
  }

  const contents = await readFile(OUTPUT_FILE, 'utf8');
  const [, ...rows] = contents.split(/\r?\n/);
  const ids = rows
    .map((row) => row.split(',')[0] ?? '')
    .filter((value) => value.length > 0 && !value.startsWith('#'));

  return new Set(ids);
}

async function searchChannels({
  query,
  regionCode,
  pageToken,
}: {
  query: string;
  regionCode: string;
  pageToken?: string;
}): Promise<SearchListResponse> {
  return youtubeFetch<SearchListResponse>('search', {
    part: 'snippet',
    type: 'channel',
    maxResults: '50',
    order: 'viewCount',
    q: query,
    regionCode,
    relevanceLanguage: 'en',
    pageToken,
  });
}

async function fetchChannelDetails(channelIds: string[]): Promise<ChannelDetail[]> {
  const batchedIds = chunk(channelIds, 50);
  const collected: ChannelDetail[] = [];

  for (const batch of batchedIds) {
    const response = await youtubeFetch<ChannelListResponse>('channels', {
      part: 'snippet,statistics,topicDetails',
      id: batch.join(','),
    });

    collected.push(...(response.items ?? []));
    await sleep(150);
  }

  return collected;
}

function transformToRow(detail: ChannelDetail, regionCode: string): CsvRow | null {
  const channelId = detail.id;
  if (!channelId) {
    return null;
  }

  const subscriberCount = detail.statistics?.subscriberCount
    ? Number.parseInt(detail.statistics.subscriberCount, 10)
    : NaN;

  if (!Number.isFinite(subscriberCount)) {
    return null;
  }

  if (detail.statistics?.hiddenSubscriberCount) {
    return null;
  }

  if (subscriberCount < MIN_SUBSCRIBERS || subscriberCount > MAX_SUBSCRIBERS) {
    return null;
  }

  const channelName = detail.snippet?.title ?? 'Unknown';
  const customUrl = detail.snippet?.customUrl;
  const channelUrl = customUrl
    ? `https://www.youtube.com/${customUrl}`
    : `https://www.youtube.com/channel/${channelId}`;

  const topicCategories = detail.topicDetails?.topicCategories ?? [];
  const niche = deriveNiche(topicCategories);

  return {
    channelId,
    channelName,
    channelUrl,
    subscriberCount,
    country: detail.snippet?.country,
    regionCode,
    niche,
    topicCategories: formatTopicCategories(topicCategories),
    description: sanitizeDescription(detail.snippet?.description),
  };
}

async function appendRows(rows: CsvRow[]): Promise<void> {
  const csv = rows.map((row) => CSV_HEADERS.map((header) => toCsvValue(row[header])).join(',')).join('\n');
  await appendFile(OUTPUT_FILE, `${csv}\n`, 'utf8');
}

function toCsvValue(value: string | number | undefined): string {
  if (value === undefined) {
    return '';
  }

  const str = typeof value === 'number' ? value.toString() : value;
  const escaped = str.replace(/"/g, '""');
  return /[",\n]/.test(escaped) ? `"${escaped}"` : escaped;
}

function deriveNiche(topicCategories: string[]): string | undefined {
  if (topicCategories.length === 0) {
    return undefined;
  }

  const formatted = topicCategories
    .map((category) => {
      const tail = category.split('/').pop();
      if (!tail) {
        return undefined;
      }
      return decodeURIComponent(tail.replace(/_/g, ' '));
    })
    .filter((value): value is string => Boolean(value));

  return formatted.length > 0 ? formatted[0] : undefined;
}

function formatTopicCategories(topicCategories: string[]): string | undefined {
  if (topicCategories.length === 0) {
    return undefined;
  }

  return topicCategories
    .map((category) => category.replace('https://en.wikipedia.org/wiki/', ''))
    .join(' | ');
}

function sanitizeDescription(description?: string): string | undefined {
  if (!description) {
    return undefined;
  }

  const singleLine = description.replace(/\r?\n+/g, ' ').trim();
  return singleLine.length > 280 ? `${singleLine.slice(0, 277)}...` : singleLine;
}

function chunk<T>(values: T[], size: number): T[][] {
  if (values.length <= size) {
    return [values];
  }

  const chunks: T[][] = [];
  for (let i = 0; i < values.length; i += size) {
    chunks.push(values.slice(i, i + size));
  }
  return chunks;
}

async function youtubeFetch<T>(endpoint: string, params: Record<string, string | undefined>): Promise<T> {
  const url = new URL(`https://youtube.googleapis.com/youtube/v3/${endpoint}`);
  const searchParams = new URLSearchParams({ key: API_KEY });

  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined) {
      searchParams.set(key, value);
    }
  }

  url.search = searchParams.toString();

  const response = await fetch(url);

  if (!response.ok) {
    const errorBody = await response.text();
    throw new Error(`YouTube API request failed (${response.status} ${response.statusText}): ${errorBody}`);
  }

  return (await response.json()) as T;
}

function sleep(durationMs: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, durationMs);
  });
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
