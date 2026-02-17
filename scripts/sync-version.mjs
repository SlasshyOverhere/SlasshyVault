import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const ROOT = process.cwd();
const changed = [];

function readText(relativePath) {
  return readFileSync(path.join(ROOT, relativePath), 'utf8');
}

function writeText(relativePath, nextContent) {
  const absolutePath = path.join(ROOT, relativePath);
  const currentContent = readFileSync(absolutePath, 'utf8');
  if (currentContent === nextContent) return;
  writeFileSync(absolutePath, nextContent, 'utf8');
  changed.push(relativePath);
}

function readJson(relativePath) {
  return JSON.parse(readText(relativePath));
}

function writeJson(relativePath, value) {
  writeText(relativePath, `${JSON.stringify(value, null, 2)}\n`);
}

const packageJson = readJson('package.json');
const version = `${packageJson.version ?? ''}`.trim();
const SEMVER_PATTERN = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;

if (!SEMVER_PATTERN.test(version)) {
  throw new Error(`Invalid package.json version "${version}"`);
}

const tauriConf = readJson('src-tauri/tauri.conf.json');
if (!tauriConf.package || typeof tauriConf.package !== 'object') {
  throw new Error('src-tauri/tauri.conf.json is missing package metadata');
}
tauriConf.package.version = version;
writeJson('src-tauri/tauri.conf.json', tauriConf);

const packageLock = readJson('package-lock.json');
packageLock.version = version;
if (packageLock.packages && packageLock.packages['']) {
  packageLock.packages[''].version = version;
}
writeJson('package-lock.json', packageLock);

const cargoToml = readText('src-tauri/Cargo.toml');
const cargoTomlPattern = /(^\[package\][\s\S]*?^version = ")[^"]+(")/m;
if (!cargoTomlPattern.test(cargoToml)) {
  throw new Error('Failed to find package version in src-tauri/Cargo.toml');
}
const cargoTomlNext = cargoToml.replace(
  cargoTomlPattern,
  `$1${version}$2`
);
writeText('src-tauri/Cargo.toml', cargoTomlNext);

const cargoLock = readText('src-tauri/Cargo.lock');
const cargoLockPattern = /(name = "streamvault"\r?\nversion = ")[^"]+(")/;
if (!cargoLockPattern.test(cargoLock)) {
  throw new Error('Failed to find streamvault package entry in src-tauri/Cargo.lock');
}
const cargoLockNext = cargoLock.replace(
  cargoLockPattern,
  `$1${version}$2`
);
writeText('src-tauri/Cargo.lock', cargoLockNext);

const updateNotes = readText('src/components/UpdateNotesModal.tsx');
const updateNotesPattern = /(const CURRENT_VERSION = ')[^']+(')/;
if (!updateNotesPattern.test(updateNotes)) {
  throw new Error('Failed to find CURRENT_VERSION in src/components/UpdateNotesModal.tsx');
}
const updateNotesNext = updateNotes.replace(
  updateNotesPattern,
  `$1${version}$2`
);
writeText('src/components/UpdateNotesModal.tsx', updateNotesNext);

if (changed.length === 0) {
  console.log(`Version already synchronized at ${version}`);
} else {
  console.log(`Synchronized version ${version} in:`);
  for (const filePath of changed) {
    console.log(`- ${filePath}`);
  }
}
