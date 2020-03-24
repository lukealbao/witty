'use strict';

type userId = string;

const STORE: Row[] = [];
const BatchSize = 24;

interface Row {
  term: string;
  slug: string;
  user: userId;
  urls: string[];
  cursor: number;
  ts: number;
}

// set stores a row and returns the slug used for that row.
export function set(user: userId, term: string, urls: string[]): string {
  let slugReady = false;
  let slug = '';
  const sigma = 'ABCDEFGHJKLMNPQRSTUVWYZ';
  while (!slugReady) {
    for (slug = ''; slug.length < 3; ) {
      const i = Math.floor(Math.random() * sigma.length);
      slug += sigma[i];
    }
    const existingRow = STORE.find(row => row.slug === slug);
    slugReady = !existingRow;
  }

  const row: Row = {
    cursor: 0,
    slug,
    term,
    ts: Date.now(),
    urls,
    user,
  };

  STORE.push(row);
  gc(STORE);

  return slug;
}

// Returns [ok, urls, cursor]. ok helpse differentiate between a term that is unknown
// (!ok) and one that has just been drained (ok). -1 for cursor means drained.
export function get(user: string, term: string): [boolean, string[], number] {
  const row = STORE.find(row => row.user === user && row.term === term);
  if (!row) {
    gc(STORE);
    return [false, [], 0];
  }
  if (row.cursor >= row.urls.length) {
    gc(STORE);
    return [true, [], -1];
  }

  // Image builder uses this cursor as an index for labeling thumbnails.
  const cursor = row.cursor;
  const next = row.urls.slice(cursor, cursor + BatchSize);
  row.cursor += BatchSize;

  gc(STORE);
  return [true, next, cursor];
}

export function slugFor(user: userId, term: string): string {
  const row = STORE.find(r => r.user === user && r.term === term);
  if (!row) {
    return '';
  } else {
    return row.slug;
  }
}

export function getImage(user: userId, imageRef: string): string | undefined {
  const match = imageRef.match(/^([a-zA-Z]{3})x(\d{2})$/);
  if (!match) {
    return;
  }

  const [_, slug, idx] = match; // eslint-disable-line @typescript-eslint/no-unused-vars
  const row = STORE.find(row => row.user === user && row.slug === slug.toUpperCase());
  if (!row) {
    gc(STORE);
    return;
  }

  gc(STORE);
  return row.urls[parseInt(idx, 10)];
}

// Garbage collect anything older than 5 minutes. Runs asynchronously so as not
// to block the user's request.
function gc(map: Row[]) {
  setTimeout(() => {
    const minute = 1000 * 60;
    const interval = 5 * minute;
    const now = Date.now();

    for (let i = 0; i < map.length; i++) {
      const row = map[i];
      if (row.ts + interval < now) {
        map.splice(i, 1);
      }
    }
  }, 5);
}
