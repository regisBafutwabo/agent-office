import { readFileSync } from 'node:fs';

// The office's scripts as one text, in the order web/index.html loads them, for tests that run pieces of it.
const web = new URL('../web/', import.meta.url);
const page = readFileSync(new URL('index.html', web), 'utf8');
export const officeSource = [...page.matchAll(/<script src="\/(js\/[\w-]+\.js)"><\/script>/g)]
  .map(m => readFileSync(new URL(m[1], web), 'utf8')).join('\n');
