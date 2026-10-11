import { existsSync } from 'node:fs';

const CHROME_PATHS = [
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Chromium.app/Contents/MacOS/Chromium',
  '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
  '/usr/bin/google-chrome',
  '/usr/bin/google-chrome-stable',
  '/usr/bin/chromium',
  '/usr/bin/chromium-browser',
];

/** A Chrome, Chromium or Edge on this machine: the one asked for, the one in CHROME_PATH, or one in the usual places. */
export function findChrome(wanted?: string, env: NodeJS.ProcessEnv = process.env): string | undefined {
  return [wanted, env.CHROME_PATH, ...CHROME_PATHS].find((path): path is string => Boolean(path) && existsSync(path!));
}
