const AdmZip = require('adm-zip');
const fs = require('fs');
const path = require('path');
const os = require('os');

const MAX_ARCHIVE_ENTRIES = 5000;
const MAX_ARCHIVE_UNCOMPRESSED_BYTES = 500 * 1024 * 1024;

function ensurePathWithinRoot(rootPath, targetPath) {
  const normalizedRoot = path.resolve(rootPath);
  const normalizedTarget = path.resolve(targetPath);
  return normalizedTarget === normalizedRoot || normalizedTarget.startsWith(`${normalizedRoot}${path.sep}`);
}

function safeExtractZip(zipPath, destinationPath) {
  const zip = new AdmZip(zipPath);
  const entries = zip.getEntries();

  if (entries.length === 0) {
    throw new Error('Invalid Lovable export: ZIP archive is empty.');
  }

  if (entries.length > MAX_ARCHIVE_ENTRIES) {
    throw new Error('Invalid Lovable export: ZIP archive contains too many files.');
  }

  let totalUncompressedBytes = 0;

  for (const entry of entries) {
    const normalizedEntryName = String(entry.entryName || '').replace(/\\/g, '/');
    if (!normalizedEntryName || normalizedEntryName.startsWith('/') || /^[A-Za-z]:/.test(normalizedEntryName)) {
      throw new Error(`Invalid Lovable export: Unsafe archive entry '${entry.entryName}'.`);
    }

    const targetPath = path.resolve(destinationPath, normalizedEntryName);
    if (!ensurePathWithinRoot(destinationPath, targetPath)) {
      throw new Error(`Invalid Lovable export: Archive entry escapes extraction directory ('${entry.entryName}').`);
    }

    if (entry.isDirectory) {
      fs.mkdirSync(targetPath, { recursive: true });
      continue;
    }

    const entryData = entry.getData();
    totalUncompressedBytes += entryData.length;
    if (totalUncompressedBytes > MAX_ARCHIVE_UNCOMPRESSED_BYTES) {
      throw new Error('Invalid Lovable export: ZIP archive expands beyond the allowed size limit.');
    }

    fs.mkdirSync(path.dirname(targetPath), { recursive: true });
    fs.writeFileSync(targetPath, entryData);
  }
}

/**
 * Extracts a zip file to a temporary directory
 * @param {string} zipPath Path to the Lovable export zip
 * @returns {Promise<string>} Path to the extracted project directory
 */
async function extractLovableZip(zipPath) {
  if (!fs.existsSync(zipPath)) {
    throw new Error(`Zip file not found: ${zipPath}`);
  }

  // Create a unique temp directory
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lovable-wp-'));

  try {
    safeExtractZip(zipPath, tempDir);

    // Lovable exports sometimes have a root folder inside the zip, sometimes they don't.
    // Let's check if the root has a package.json, or if it's one level deep.
    const files = fs.readdirSync(tempDir);
    let projectRoot = tempDir;
    
    if (files.length === 1 && fs.statSync(path.join(tempDir, files[0])).isDirectory()) {
      projectRoot = path.join(tempDir, files[0]);
    }

    // Validate it's a Node/Vite project
    if (!fs.existsSync(path.join(projectRoot, 'package.json'))) {
      throw new Error('Invalid Lovable export: No package.json found in the root.');
    }

    return projectRoot;
  } catch (error) {
    fs.rmSync(tempDir, { recursive: true, force: true });
    throw error;
  }
}

module.exports = { extractLovableZip };
