import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..');

const args = new Set(process.argv.slice(2));
const modeArg = process.argv.find(item => item.startsWith('--mode='));
const mode = modeArg ? modeArg.split('=')[1] : args.has('--desktop') ? 'desktop' : 'web';

const backendPort = Number(process.env.MOTION_BACKEND_PORT || 4174);
const vitePort = Number(process.env.MOTION_VITE_PORT || 5173);
const backendOrigin = `http://127.0.0.1:${backendPort}`;
const viteOrigin = `http://127.0.0.1:${vitePort}`;

const children = new Set();
let shuttingDown = false;

function spawnService(command, commandArgs, options = {}) {
  const child = spawn(command, commandArgs, {
    cwd: options.cwd || repoRoot,
    env: { ...process.env, ...options.env },
    stdio: 'inherit',
    shell: process.platform === 'win32' && command.endsWith('.cmd'),
  });
  children.add(child);
  child.on('exit', code => {
    children.delete(child);
    if (!shuttingDown && options.critical !== false && code !== 0) {
      console.error(`[dev-unified] ${options.name || command} exited with code ${code}`);
      shutdown(code || 1);
    }
  });
  return child;
}

async function waitForUrl(url, timeoutMs = 45_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (shuttingDown) return;
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(2_000) });
      if (res.ok || res.status < 500) return;
    } catch {
      // Wait for service startup.
    }
    await new Promise(resolve => setTimeout(resolve, 250));
  }
  throw new Error(`Timed out waiting for ${url}`);
}

function shutdown(exitCode = 0) {
  if (shuttingDown) return;
  shuttingDown = true;
  for (const child of children) {
    try {
      child.kill('SIGTERM');
    } catch {
      // Ignore already exited child.
    }
  }
  setTimeout(() => process.exit(exitCode), 400);
}

process.on('SIGINT', () => shutdown(0));
process.on('SIGTERM', () => shutdown(0));

async function main() {
  console.log(`[dev-unified] Starting OpenMotion in "${mode}" mode…`);

  // 1. Start OpenMotion Node backend (Studio serves via Vite HMR on 5173)
  spawnService(process.execPath, ['--experimental-strip-types', 'server.ts'], {
    name: 'backend',
    env: {
      PORT: String(backendPort),
      HOST: '127.0.0.1',
      MOTION_HEADLESS: '1',
      MOTION_OPEN_BROWSER: '0',
      HYPERFRAMES_HEADLESS: '1',
      MOTION_DEV_BACKEND_PROXY: backendOrigin,
    },
  });
  await waitForUrl(`${backendOrigin}/motion-api/health`);
  console.log(`[dev-unified] Backend ready at ${backendOrigin}`);

  // 2. Start unified Vite dev server for Studio
  const viteBin = path.join(
    repoRoot,
    'node_modules',
    '.bin',
    process.platform === 'win32' ? 'vite.cmd' : 'vite',
  );
  spawnService(
    viteBin,
    ['--config', 'studio/vite.dev.config.ts', '--port', String(vitePort)],
    {
      name: 'vite-studio',
      env: {
        MOTION_DEV_BACKEND_PROXY: backendOrigin,
        VITE_BACKEND_PROXY: backendOrigin,
      },
    },
  );
  await waitForUrl(viteOrigin);
  console.log(`[dev-unified] Studio dev server ready at ${viteOrigin}`);

  if (mode === 'desktop') {
    console.log('[dev-unified] Building desktop shell and launching Electron…');
    const buildRes = await new Promise((resolve, reject) => {
      const builder = spawn(process.execPath, ['desktop/scripts/build.mjs'], {
        cwd: repoRoot,
        stdio: 'inherit',
      });
      builder.on('error', reject);
      builder.on('exit', resolve);
    });
    if (buildRes !== 0) {
      throw new Error(`Desktop build failed with code ${buildRes}`);
    }

    const electronBin = path.join(
      repoRoot,
      'desktop',
      'node_modules',
      '.bin',
      process.platform === 'win32' ? 'electron.cmd' : 'electron',
    );
    if (!existsSync(electronBin)) {
      throw new Error(
        `Electron binary not found at ${electronBin}. Install desktop dependencies with \`npm --prefix desktop install\`.`,
      );
    }

    const desktopChild = spawnService(electronBin, ['desktop'], {
      name: 'electron-desktop',
      env: {
        MOTION_DESKTOP_DEV_URL: viteOrigin,
        MOTION_DESKTOP_API_URL: backendOrigin,
      },
    });
    desktopChild.on('exit', code => shutdown(code ?? 0));
  }
}

main().catch(err => {
  console.error('[dev-unified]', err);
  shutdown(1);
});
