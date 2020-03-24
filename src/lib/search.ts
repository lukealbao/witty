'use strict';

import axios from 'axios';
import cheerio from 'cheerio';
import { encode } from 'querystring';
import * as Cache from './cache';

export const DONE = 'CACHEDONE';

export async function find(user: string, term: string): Promise<[string[], number, string]> {
  const results = await searchGoogle(term);
  const slug = Cache.set(user, term, results);
  const [ok, urls, startidx] = Cache.get(user, term);
  if (!ok) {
    throw new Error('TypeInvariant: Cache should be hot after search.');
  }
  return [urls, startidx, slug];
}

export async function next(user: string, term: string): Promise<[string[], number, string]> {
  let [ok, urls, startidx] = Cache.get(user, term);

  if (!ok || startidx === -1) {
    return [[], -1, DONE];
  }

  const slug = Cache.slugFor(user, term);
  return [urls, startidx, slug];
}

export function urlFor(user: string, imageId: string): string | undefined {
  const url = Cache.getImage(user, imageId);
  return url;
}

// fetchImages returns at most `count' number of links to images matching
// the `q' keyword query. Only square images are returned.
async function fetchImages(q: string, opts: object | null, count: number = 100): Promise<string[]> {
  const params = Object.assign({ q, source: 'lnms', tbm: 'isch', tbs: ['iar:s'] }, opts);
  const query = encode(params);
  const res = await axios(`https://google.com/search?${query}`);
  const html = res.data;
  const $ = cheerio.load(html);
  const re = /gstatic\.com/;

  const urls = $('img')
    .map((i, e) => $(e).attr('src'))
    .get() // cheerio API: convert to plain array of strings
    .filter(src => re.test(src));

  return urls.slice(0, count);
}

// searchGoogle returns links to images matching the search term. Results are
// added by extending the search with the following terms: square; animated; icon.
export async function searchGoogle(term: string, count: number = 100): Promise<string[]> {
  term = term.replace(/\s+/g, '');
  const results: string[] = (await Promise.all([
    fetchImages(term, { tbs: ['iar:s'] }, count),
    fetchImages(term, null, count),
    fetchImages(term, { tbs: ['itp:animated'] }, count),
    fetchImages(term, { tbs: ['isz:i'] }, count),
  ])).flat();

  const deduped: string[] = [...new Set(results)];

  return deduped;
}
