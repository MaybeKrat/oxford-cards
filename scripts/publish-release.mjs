// Publishes the GitHub release for the version in package.json and attaches release\Oxford Cards.exe as Oxford-Cards.exe.
// Usage: node scripts/publish-release.mjs <notes.md>
// The version must already be committed and tagged (v<version>) and the tag pushed.
import { spawnSync } from 'node:child_process';
import { readFile, stat } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = 'MaybeKrat/oxford-cards';
const ASSET = 'Oxford-Cards.exe';
const root = resolve(fileURLToPath(import.meta.url), '../..');

/** The same GitHub token git uses for push, from the Windows credential manager; it is never printed. */
function githubToken() {
  const result = spawnSync('git', ['credential', 'fill'], {
    input: 'protocol=https\nhost=github.com\n\n',
    encoding: 'utf8',
    env: { ...process.env, GCM_INTERACTIVE: 'Never', GIT_TERMINAL_PROMPT: '0' },
  });
  const token = /^password=(.+)$/m.exec(result.stdout ?? '')?.[1];
  if (!token) throw new Error('git не вернул токен GitHub: сначала выполните git push, чтобы git запомнил вход.');
  return token;
}

async function github(token, url, init = {}) {
  const response = await fetch(url, {
    ...init,
    headers: { authorization: `Bearer ${token}`, accept: 'application/vnd.github+json', ...init.headers },
  });
  if (response.status === 404 && init.allow404) return null;
  if (!response.ok) throw new Error(`${init.method ?? 'GET'} ${url}: ${response.status} ${await response.text()}`);
  return response.json();
}

const notesPath = process.argv[2];
if (!notesPath) throw new Error('Укажите файл с описанием релиза: node scripts/publish-release.mjs <notes.md>');
const { version } = JSON.parse(await readFile(resolve(root, 'package.json'), 'utf8'));
const tag = `v${version}`;
const exe = resolve(root, 'release', 'Oxford Cards.exe');
const body = await readFile(resolve(notesPath), 'utf8');
const size = (await stat(exe)).size;

const token = githubToken();
const api = `https://api.github.com/repos/${REPO}`;
const release =
  (await github(token, `${api}/releases/tags/${tag}`, { allow404: true })) ??
  (await github(token, `${api}/releases`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ tag_name: tag, name: `Oxford Cards ${version}`, body }),
  }));
const existing = release.assets.find((asset) => asset.name === ASSET);
if (existing) {
  console.log(`${ASSET} уже приложен к ${tag} (${existing.size} байт), загрузка пропущена.`);
} else {
  const asset = await github(token, `https://uploads.github.com/repos/${REPO}/releases/${release.id}/assets?name=${ASSET}`, {
    method: 'POST',
    headers: { 'content-type': 'application/octet-stream', 'content-length': String(size) },
    body: await readFile(exe),
  });
  console.log(`Загружен ${asset.name}: ${asset.size} байт.`);
}
console.log(release.html_url);
