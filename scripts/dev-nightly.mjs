import { readFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');
const configPath = path.join(root, 'src-tauri', 'tauri.conf.nightly.json');
const config = readFileSync(configPath, 'utf8');

const child = spawn('npm', ['run', 'tauri:dev'], {
  cwd: root,
  stdio: 'inherit',
  shell: true,
  env: { ...process.env, TAURI_CONFIG: config },
});

child.on('exit', (code) => process.exit(code ?? 1));
