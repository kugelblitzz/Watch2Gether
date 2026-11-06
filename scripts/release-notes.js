'use strict';

/**
 * Release notes for a version, used by the release workflow:
 *   node scripts/release-notes.js <version> [mpv build name]
 * Takes that version's section from CHANGELOG.md. If there is none, lists the commits
 * since the previous release tag, so a release never goes out with empty notes.
 */

const { execFileSync } = require('child_process');
const { sectionFor } = require('../src/main/changelog');

const version = process.argv[2];
const mpvBuild = process.argv[3];
if (!version) {
  console.error('usage: node scripts/release-notes.js <version> [mpv build]');
  process.exit(2);
}

function commitsSincePreviousTag() {
  try {
    const tags = execFileSync('git', ['tag', '--list', 'v*', '--sort=-v:refname'], { encoding: 'utf8' })
      .split('\n').map((t) => t.trim()).filter((t) => t && t !== `v${version}`);
    const range = tags[0] ? `${tags[0]}..HEAD` : 'HEAD';
    return execFileSync('git', ['log', range, '--no-merges', '--format=- %s'], { encoding: 'utf8' }).trim();
  } catch {
    return '';
  }
}

const body = sectionFor(version) || commitsSincePreviousTag() || '- Maintenance release.';
const repo = process.env.GITHUB_REPOSITORY || 'kugelblitzz/Watch2Gether';
const out = [
  body,
  '',
  '---',
  '',
  `**Install:** download **Watch2Gether-Setup-${version}.exe** below and run it (see the [README](https://github.com/${repo}#setup-everyone) for setup). Already installed? The app updates itself; click the version number at the top to check now.`,
];
if (mpvBuild) out.push('', `Bundles mpv (\`${mpvBuild}\`, GPL, source at https://mpv.io).`);
process.stdout.write(out.join('\n') + '\n');
