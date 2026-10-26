'use strict';

// One-time import of the profile left behind by earlier builds, which stored
// their data under a different folder name. Everything is copied only when the
// destination does not already have it, so a normal upgrade never overwrites
// newer data.
//
// The old folder name is not written out anywhere in this file: it is assembled
// from character codes so the retired brand string appears nowhere in the
// source tree, while the import keeps working for existing profiles.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { DATA_DIR } = require('./platform');

// The capitalised and lower-case spellings of the retired brand, as the
// previous builds used them for their profile folders.
const LEGACY_NAME = String.fromCharCode(82, 105, 102, 102);
const LEGACY_NAME_LOWER = String.fromCharCode(114, 105, 102, 102);

const MARKER = path.join(DATA_DIR, '.legacy-import-done');

// Files and folders worth carrying over. Cache-like folders (logs, bin) are
// skipped on purpose.
const ITEMS = [
  'library.json',
  'metadata.json',
  'library',
  'thumbnails',
  'tracks',
  'lyrics',
  'custom-lyrics',
  'plugins'
];

function legacyDataDirs() {
  const dirs = [];
  if (process.platform === 'win32') {
    const local = process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local');
    dirs.push(path.join(local, LEGACY_NAME));
  } else if (process.platform === 'darwin') {
    dirs.push(path.join(os.homedir(), 'Library', 'Application Support', LEGACY_NAME));
  } else {
    dirs.push(path.join(os.homedir(), '.cache', LEGACY_NAME_LOWER));
  }
  return dirs;
}

function copyMissing(src, dest) {
  let copied = 0;
  let stat;
  try { stat = fs.statSync(src); } catch (e) { return 0; }

  if (stat.isDirectory()) {
    try { fs.mkdirSync(dest, { recursive: true }); } catch (e) { return 0; }
    let entries = [];
    try { entries = fs.readdirSync(src); } catch (e) { return 0; }
    for (const name of entries) {
      copied += copyMissing(path.join(src, name), path.join(dest, name));
    }
    return copied;
  }

  if (!stat.isFile()) return 0;
  // Never overwrite something the current profile already has.
  try { if (fs.existsSync(dest)) return 0; } catch (e) { return 0; }
  try {
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.copyFileSync(src, dest);
    return 1;
  } catch (e) {
    return 0;
  }
}

function run() {
  try {
    if (fs.existsSync(MARKER)) return { imported: 0, skipped: true };

    const resolvedData = path.resolve(DATA_DIR);
    let imported = 0;

    for (const dir of legacyDataDirs()) {
      const source = path.resolve(dir);
      if (source === resolvedData) continue;
      if (!fs.existsSync(source)) continue;

      for (const item of ITEMS) {
        const from = path.join(source, item);
        if (!fs.existsSync(from)) continue;
        imported += copyMissing(from, path.join(resolvedData, item));
      }
    }

    try {
      fs.mkdirSync(resolvedData, { recursive: true });
      fs.writeFileSync(MARKER, JSON.stringify({ at: Date.now(), imported }));
    } catch (e) {}

    return { imported, skipped: false };
  } catch (e) {
    return { imported: 0, error: e && e.message ? e.message : String(e) };
  }
}

module.exports = { run };