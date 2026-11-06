'use strict';

/**
 * CHANGELOG.md helpers, shared by the app ("What's new" after an update) and the
 * release workflow (GitHub release notes): scripts/release-notes.js.
 */

const fs = require('fs');
const path = require('path');

const CHANGELOG = path.join(__dirname, '..', '..', 'CHANGELOG.md');

/** The markdown body of the "## <version>" section, or null if there is none. */
function sectionFor(version, text = readChangelog()) {
  if (!text) return null;
  const lines = text.split(/\r?\n/);
  const start = lines.findIndex((l) => l.trim() === `## ${version}` || l.trim() === `## v${version}`);
  if (start < 0) return null;
  let end = lines.findIndex((l, i) => i > start && /^## /.test(l));
  if (end < 0) end = lines.length;
  const body = lines.slice(start + 1, end).join('\n').trim();
  return body || null;
}

function readChangelog() {
  try {
    return fs.readFileSync(CHANGELOG, 'utf8');
  } catch {
    return null;
  }
}

module.exports = { sectionFor };
