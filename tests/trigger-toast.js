import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, '..');
const publicDir = path.join(projectRoot, 'public');
const triggerFilePath = path.join(publicDir, 'test-trigger.json');

const PORTS = [3000, 3001];

// Function to check if a port is open and serving Vite
function checkPort(port) {
  return new Promise((resolve) => {
    const req = http.get(`http://localhost:${port}/`, { timeout: 1000 }, (res) => {
      resolve(true);
    });
    req.on('error', () => {
      resolve(false);
    });
    req.on('timeout', () => {
      req.destroy();
      resolve(false);
    });
  });
}

async function run() {
  console.log('Searching for running SlasshyVault dev build...');
  
  let activePort = null;
  for (const port of PORTS) {
    const isRunning = await checkPort(port);
    if (isRunning) {
      activePort = port;
      break;
    }
  }

  if (!activePort) {
    console.error('❌ Error: No running dev build found on port 3000 or 3001.');
    console.error('Please start the dev build first using: npm run tauri:dev');
    process.exit(1);
  }

  console.log(`✅ Found running dev build on http://localhost:${activePort}`);

  // Create public directory if it doesn't exist
  if (!fs.existsSync(publicDir)) {
    fs.mkdirSync(publicDir, { recursive: true });
  }

  // Create the trigger file with the exact payload from the user's report
  const testPayload = {
    title: 'SlasshyVault',
    message: 'Marvels.Daredevil.S03.2160p.NF.WEBRip.DDP5.1.Atmos.x264-DEFLATE.zip (13 episode(s)) removed (deleted from Drive)',
    timestamp: Date.now(),
    type: 'info'
  };

  console.log('Sending toast notification payload...');
  fs.writeFileSync(triggerFilePath, JSON.stringify(testPayload, null, 2), 'utf8');
  console.log('✨ Notification triggered in the app!');

  console.log('Waiting 3 seconds for the app to display it, then cleaning up...');
  await new Promise((resolve) => setTimeout(resolve, 3000));

  // Clean up
  try {
    fs.unlinkSync(triggerFilePath);
    console.log('🧹 Cleanup complete.');
  } catch (error) {
    console.warn('⚠️ Could not remove test-trigger.json:', error.message);
  }

  console.log('Done!');
}

run().catch((err) => {
  console.error('Failed to run test:', err);
  process.exit(1);
});
