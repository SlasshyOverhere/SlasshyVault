import { readFileSync, writeFileSync, unlinkSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');

const baseConfig = JSON.parse(readFileSync(path.join(root, 'src-tauri', 'tauri.conf.json'), 'utf8'));
const nightlyConfig = JSON.parse(readFileSync(path.join(root, 'src-tauri', 'tauri.conf.nightly.json'), 'utf8'));

function deepMerge(target, source) {
  for (const key of Object.keys(source)) {
    if (source[key] && typeof source[key] === 'object' && !Array.isArray(source[key])) {
      if (!target[key] || typeof target[key] !== 'object') target[key] = {};
      deepMerge(target[key], source[key]);
    } else {
      target[key] = source[key];
    }
  }
  return target;
}

const merged = deepMerge(baseConfig, nightlyConfig);
merged.build.devPath = 'http://localhost:3001';
merged.build.beforeDevCommand = 'npm run dev -- --port 3001';

const mergedPath = path.join(root, 'src-tauri', 'tauri.conf.nightly-merged.json');
writeFileSync(mergedPath, JSON.stringify(merged, null, 2));

const child = spawn('npm', ['run', 'tauri', '--', 'dev', '--config', 'src-tauri/tauri.conf.nightly-merged.json'], {
  cwd: root,
  stdio: 'inherit',
  shell: true,
  env: { ...process.env, VITE_IS_NIGHTLY: 'true' },
});

const cleanup = () => {
  try { unlinkSync(mergedPath); } catch {}
};

child.on('exit', (code) => {
  cleanup();
  process.exit(code ?? 1);
});

process.on('SIGINT', () => {
  child.kill('SIGINT');
  cleanup();
  process.exit(0);
});

process.on('SIGTERM', () => {
  child.kill('SIGTERM');
  cleanup();
  process.exit(0);
});
