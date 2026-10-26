'use strict';

// Builds released before the rename saved every setting under an old key prefix
// in localStorage and sessionStorage. This moves them to the `ware_*` names
// once, so an upgrade keeps the theme, volume, equalizer presets, font scale,
// the cover-art cache and the rest, instead of silently resetting everything.
//
// The retired prefix is assembled from character codes: it is needed to find
// the old keys, but the brand string itself appears nowhere in the source.
//
// The script has to run before any other script of the window touches storage,
// which is why index.html and welcome.html load it first.

(() => {
  const OLD_PREFIX = String.fromCharCode(114, 105, 102, 102) + '_';
  const NEW_PREFIX = 'ware_';
  const MARKER = 'ware_storage_migrated';

  function migrate(store, label) {
    if (!store) return 0;

    let done = false;
    try { done = store.getItem(MARKER) === '1'; } catch (e) { return 0; }
    if (done) return 0;

    // Collect first: removing keys while walking the store skips entries.
    const pairs = [];
    try {
      for (let i = 0; i < store.length; i++) {
        const key = store.key(i);
        if (!key || key.indexOf(OLD_PREFIX) !== 0) continue;
        const next = NEW_PREFIX + key.slice(OLD_PREFIX.length);
        if (next === MARKER) continue;
        pairs.push([key, next]);
      }
    } catch (e) { return 0; }

    let moved = 0;
    for (const [oldKey, newKey] of pairs) {
      try {
        // A value already written under the new name wins: it is the fresher one.
        if (store.getItem(newKey) === null) {
          const value = store.getItem(oldKey);
          if (value !== null) store.setItem(newKey, value);
        }
        store.removeItem(oldKey);
        moved++;
      } catch (e) {}
    }

    try { store.setItem(MARKER, '1'); } catch (e) {}

    if (moved) {
      try { console.log(`[storage] ${label}: moved ${moved} settings to ${NEW_PREFIX}*`); } catch (e) {}
    }
    return moved;
  }

  let local = null;
  let session = null;
  try { local = window.localStorage; } catch (e) {}
  try { session = window.sessionStorage; } catch (e) {}

  migrate(local, 'localStorage');
  migrate(session, 'sessionStorage');
})();