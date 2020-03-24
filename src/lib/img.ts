'use strict';

import Jimp = require('jimp');

// ----- Style Globals -----
const FONT = Jimp.FONT_SANS_12_BLACK;
const NROWS = 4,
  NCOLUMNS = 6;
const WHITE = 0xffffffff;
const TS = 50; // Thumbnail side in pixels
const padx = 5;
const border = 5;
const pady = 20;

// ----- Public Types -----
interface Candidate {
  id?: string; // Delegated to client, not created at instantiation
  src: string;
  img: Jimp;
}

export async function optionsGrid(urls: string[], slug: string, startidx: number): Promise<Buffer> {
  const thumbs = await loadThumbnails(urls);
  const grid = await buildGrid(thumbs, slug, startidx);
  const buffer = await grid.getBufferAsync(grid.getMIME());

  return buffer;
}

// loadCandidate downloads an image from the SRC url and resizes as a TS-sized
// square.
async function loadCandidate(src: string): Promise<Candidate> {
  const img = await Jimp.read(src);
  // TODO: DELETE?? const buf = await img.getBufferAsync(img.getMIME());

  if (img.getWidth() > TS) {
    img.resize(TS, Jimp.AUTO);
  }

  if (img.getHeight() > TS) {
    img.resize(Jimp.AUTO, TS);
  }

  return {
    src,
    img,
  };
}

// loadThumbnails is the public interface for fetching an array of unique
// thumbnails for a list of urls.
export async function loadThumbnails(urls: string[]): Promise<Candidate[]> {
  let thumbs = await Promise.all(urls.map(loadCandidate));
  return thumbs;
}

// buildGrid is the public interface for building a single jpg image containing
// a grid of thumbnails along with their captions.  This is made public because
// the client is responsible for maintaining the state of the index number.
export async function buildGrid(thumbs: Candidate[], slug: string, startidx: number): Promise<Jimp> {
  const [rows, columns] = [NROWS, NCOLUMNS];

  const W = (TS + padx) * columns + border * 2;
  const H = (TS + pady) * rows + border * 2;

  const grid = await new Jimp(W, H, WHITE);
  const font = await Jimp.loadFont(FONT);

  thumbs.forEach((thumb, i) => {
    const row = Math.floor(i / columns);
    const column = i % columns;
    thumb.id = ` ${slug}x${pad(`${i + startidx}`, 2)}`;

    const xpos = column === 0 ? border : (TS + padx) * column + border;
    const ypos = row === 0 ? border : (TS + pady) * row + border;

    // lay thumbnail
    grid.composite(thumb.img, xpos, ypos);

    // lay caption
    grid.print(
      font,
      xpos,
      ypos + TS, // Additional pad for image height
      thumb.id,
    );
  });

  return grid;
}

// ----- Helpers -----
function pad(s: string, n: number) {
  while (s.length < n) {
    s = '0' + s;
  }

  return s;
}
