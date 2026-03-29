const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const INSTALL_TIMEOUT_MS = Number.parseInt(process.env.BUILD_INSTALL_TIMEOUT_MS || '', 10) || (10 * 60 * 1000);
const VITE_BUILD_TIMEOUT_MS = Number.parseInt(process.env.VITE_BUILD_TIMEOUT_MS || '', 10) || (5 * 60 * 1000);
const MAX_PROCESS_OUTPUT_BYTES = Number.parseInt(process.env.MAX_PROCESS_OUTPUT_BYTES || '', 10) || (10 * 1024 * 1024);
const DISALLOWED_ROOT_SCRIPTS = [
  'preinstall',
  'install',
  'postinstall',
  'prepare',
  'prepublish',
  'prepublishOnly',
  'prepack',
  'postpack',
  'prebuild',
  'postbuild',
];

function getNpmExecutable() {
  return process.platform === 'win32' ? 'npm.cmd' : 'npm';
}

function readProjectPackageJson(projectPath) {
  const packageJsonPath = path.join(projectPath, 'package.json');
  if (!fs.existsSync(packageJsonPath)) {
    throw new Error(`package.json not found in project root: ${projectPath}`);
  }

  return {
    packageJsonPath,
    packageJson: JSON.parse(fs.readFileSync(packageJsonPath, 'utf8')),
  };
}

function assertSafeRootScripts(projectPath) {
  const { packageJson } = readProjectPackageJson(projectPath);
  const scripts = packageJson.scripts && typeof packageJson.scripts === 'object'
    ? packageJson.scripts
    : {};
  const disallowedScripts = DISALLOWED_ROOT_SCRIPTS.filter((scriptName) => {
    return typeof scripts[scriptName] === 'string' && scripts[scriptName].trim() !== '';
  });

  if (disallowedScripts.length > 0) {
    throw new Error(`Unsupported package.json lifecycle scripts detected: ${disallowedScripts.join(', ')}. Remove those scripts or build this export inside an isolated sandbox.`);
  }

  return packageJson;
}

async function runCommand(command, args, { cwd, timeoutMs }) {
  return await new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd,
      windowsHide: true,
      shell: process.platform === 'win32' && /\.cmd$/i.test(command),
      env: {
        ...process.env,
        CI: '1',
      },
    });

    let stdout = '';
    let stderr = '';
    let settled = false;

    const appendOutput = (current, chunk) => {
      const next = current + chunk.toString();
      if (Buffer.byteLength(next, 'utf8') > MAX_PROCESS_OUTPUT_BYTES) {
        if (!settled) {
          settled = true;
          child.kill('SIGKILL');
          reject(new Error('Command exceeded the maximum captured output size.'));
        }
        return current;
      }

      return next;
    };

    const timer = setTimeout(() => {
      if (settled) {
        return;
      }

      settled = true;
      child.kill('SIGTERM');
      setTimeout(() => child.kill('SIGKILL'), 5000);
      reject(new Error(`Command timed out after ${timeoutMs}ms.`));
    }, timeoutMs);

    if (typeof timer.unref === 'function') {
      timer.unref();
    }

    child.stdout.on('data', (chunk) => {
      stdout = appendOutput(stdout, chunk);
    });

    child.stderr.on('data', (chunk) => {
      stderr = appendOutput(stderr, chunk);
    });

    child.on('error', (error) => {
      if (settled) {
        return;
      }

      settled = true;
      clearTimeout(timer);
      reject(new Error(error.message || `Command failed to start: ${command}`));
    });

    child.on('close', (code, signal) => {
      if (settled) {
        return;
      }

      settled = true;
      clearTimeout(timer);

      if (code === 0) {
        resolve({ stdout, stderr });
        return;
      }

      reject(new Error(stderr.trim() || stdout.trim() || `Command failed with exit code ${code}${signal ? ` (${signal})` : ''}.`));
    });
  });
}

function parseMajorVersion(versionRange = '') {
  const match = versionRange.match(/(\d+)/);
  return match ? Number.parseInt(match[1], 10) : null;
}

function isNodeVersionLessThan(target) {
  const currentParts = process.versions.node.split('.').map((part) => Number.parseInt(part, 10) || 0);
  const targetParts = target.split('.').map((part) => Number.parseInt(part, 10) || 0);
  const maxLength = Math.max(currentParts.length, targetParts.length);

  for (let i = 0; i < maxLength; i += 1) {
    const current = currentParts[i] || 0;
    const required = targetParts[i] || 0;

    if (current < required) return true;
    if (current > required) return false;
  }

  return false;
}

function applyCompatibilityPatches(projectPath, logDetail = () => {}) {
  const { packageJsonPath, packageJson } = readProjectPackageJson(projectPath);
  const devDependencies = packageJson.devDependencies || {};
  const dependencies = packageJson.dependencies || {};
  const viteRange = devDependencies.vite || dependencies.vite || '';
  const viteMajor = parseMajorVersion(viteRange);
  const hasLovableTagger = Boolean(devDependencies['lovable-tagger'] || dependencies['lovable-tagger']);
  const needsCompatibilityVite = viteMajor >= 8 && (hasLovableTagger || isNodeVersionLessThan('20.19.0'));

  if (!needsCompatibilityVite) {
    return false;
  }

  if (devDependencies.vite) {
    devDependencies.vite = '^6.4.1';
  } else if (dependencies.vite) {
    dependencies.vite = '^6.4.1';
  }

  if (devDependencies['@vitejs/plugin-react']) {
    devDependencies['@vitejs/plugin-react'] = '^4.4.1';
  }

  packageJson.devDependencies = devDependencies;
  packageJson.dependencies = dependencies;
  fs.writeFileSync(packageJsonPath, `${JSON.stringify(packageJson, null, 2)}\n`, 'utf8');

  const packageLockPath = path.join(projectPath, 'package-lock.json');
  if (fs.existsSync(packageLockPath)) {
    fs.rmSync(packageLockPath, { force: true });
  }

  const nodeModulesPath = path.join(projectPath, 'node_modules');
  if (fs.existsSync(nodeModulesPath)) {
    fs.rmSync(nodeModulesPath, { recursive: true, force: true });
  }

  logDetail(`Detected an incompatible Vite 8/Lovable setup for this environment. Rewriting the extracted project to Vite 6.4.1 and @vitejs/plugin-react 4.4.1 before install.`);
  return true;
}

function patchMainEntryForHydration(projectPath, logDetail = () => {}) {
  const candidates = ['main.tsx', 'main.jsx', 'main.ts', 'main.js']
    .map((filename) => path.join(projectPath, 'src', filename));
  const mainEntryPath = candidates.find((candidate) => fs.existsSync(candidate));

  if (!mainEntryPath) {
    return false;
  }

  const original = fs.readFileSync(mainEntryPath, 'utf8');
  let updated = original;

  updated = updated.replace(
    /import\s*\{\s*([^}]+)\s*\}\s*from\s*["']react-dom\/client["'];?/,
    () => `import { createRoot } from "react-dom/client";`
  );

  updated = updated.replace(
    /const\s+rootElement\s*=\s*document\.getElementById\("root"\);[\s\S]*$/m,
    `const rootElement = document.getElementById("root");

if (rootElement) {
  createRoot(rootElement).render(<App />);
}`
  );

  updated = updated.replace(
    /createRoot\s*\(\s*document\.getElementById\((['"])root\1\)\s*!?\s*\)\s*\.render\(\s*<App\s*\/>\s*\);\s*$/m,
    `const rootElement = document.getElementById("root");

if (rootElement) {
  createRoot(rootElement).render(<App />);
}`
  );

  if (updated === original) {
    return false;
  }

  fs.writeFileSync(mainEntryPath, updated, 'utf8');
  logDetail(`Patched ${path.basename(mainEntryPath)} to mount the original app over the WordPress-rendered snapshot.`);
  return true;
}

function patchBrowserRouterBasename(projectPath, logDetail = () => {}) {
  const candidates = ['App.tsx', 'App.jsx', 'App.ts', 'App.js']
    .map((filename) => path.join(projectPath, 'src', filename));
  const appPath = candidates.find((candidate) => fs.existsSync(candidate));

  if (!appPath) {
    return false;
  }

  const original = fs.readFileSync(appPath, 'utf8');
  if (!/<BrowserRouter\b/.test(original) || /\bbasename=/.test(original)) {
    return false;
  }

  const updated = original.replace(
    /<BrowserRouter(\s[^>]*)?>/,
    `<BrowserRouter$1 basename={(window.__LOVABLE_WP_THEME__ && window.__LOVABLE_WP_THEME__.basename) || undefined}>`
  );

  if (updated === original) {
    return false;
  }

  fs.writeFileSync(appPath, updated, 'utf8');
  logDetail(`Patched ${path.basename(appPath)} so BrowserRouter respects the WordPress site base path during client-side mounting.`);
  return true;
}

function applyWordPressHydrationPatches(projectPath, logDetail = () => {}) {
  const entryPatched = patchMainEntryForHydration(projectPath, logDetail);
  const routerPatched = patchBrowserRouterBasename(projectPath, logDetail);
  return entryPatched || routerPatched;
}

async function runInstall(projectPath, logDetail = () => {}) {
  try {
    logDetail(`Running npm install (this may take a minute)...`);
    await runCommand(getNpmExecutable(), ['install', '--no-audit', '--no-fund'], {
      cwd: projectPath,
      timeoutMs: INSTALL_TIMEOUT_MS,
    });
  } catch (error) {
    if (!/ERESOLVE/i.test(error.message || '')) {
      throw error;
    }

    logDetail(`npm install hit a peer dependency conflict. Retrying with --legacy-peer-deps...`);
    await runCommand(getNpmExecutable(), ['install', '--legacy-peer-deps', '--no-audit', '--no-fund'], {
      cwd: projectPath,
      timeoutMs: INSTALL_TIMEOUT_MS,
    });
  }
}

function resolveLocalViteCli(projectPath) {
  const vitePackagePath = path.join(projectPath, 'node_modules', 'vite', 'package.json');
  if (!fs.existsSync(vitePackagePath)) {
    throw new Error('Vite CLI not found after dependency install.');
  }

  const vitePackage = JSON.parse(fs.readFileSync(vitePackagePath, 'utf8'));
  const viteBin = typeof vitePackage.bin === 'string'
    ? vitePackage.bin
    : (vitePackage.bin && typeof vitePackage.bin.vite === 'string' ? vitePackage.bin.vite : 'bin/vite.js');
  const viteCliPath = path.join(path.dirname(vitePackagePath), viteBin);

  if (!fs.existsSync(viteCliPath)) {
    throw new Error('Resolved Vite CLI path does not exist after install.');
  }

  return viteCliPath;
}

/**
 * Runs npm install and npm build in the project directory
 * @param {string} projectPath Path to the extracted Lovable project
 * @param {function} logDetail Callback to emit logs to UI
 * @returns {Promise<string>} Path to the built 'dist' directory
 */
async function buildViteProject(projectPath, logDetail = () => {}) {
  try {
    assertSafeRootScripts(projectPath);
    applyCompatibilityPatches(projectPath, logDetail);
    applyWordPressHydrationPatches(projectPath, logDetail);

    // Stage 1: Install dependencies
    await runInstall(projectPath, logDetail);

    // Stage 2: Build the project
    const viteCliPath = resolveLocalViteCli(projectPath);
    logDetail(`Running Vite build...`);
    await runCommand(process.execPath, [viteCliPath, 'build'], {
      cwd: projectPath,
      timeoutMs: VITE_BUILD_TIMEOUT_MS,
    });

    const distPath = path.join(projectPath, 'dist');
    if (!fs.existsSync(distPath)) {
      throw new Error("Build succeeded but 'dist' directory not found.");
    }

    return distPath;
  } catch (error) {
    throw new Error(`Failed to build project: ${error.message}`);
  }
}

module.exports = { buildViteProject };
