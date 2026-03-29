require('dotenv').config();
const path = require('path');
const fs = require('fs');

// Core Agent Modules
const { extractLovableZip } = require('./lib/extract');
const { buildViteProject } = require('./lib/build');
const { renderPages } = require('./lib/render');
const { convertHtmlToPhp } = require('./lib/llm');
const { packageTheme } = require('./lib/package');

async function main() {
  const zipPath = process.argv[2];
  
  if (!zipPath) {
    console.error('Usage: node index.js <path-to-lovable-export.zip>');
    process.exit(1);
  }

  try {
    console.log(`[1/5] Extracting ${path.basename(zipPath)}...`);
    const projectPath = await extractLovableZip(zipPath);

    console.log(`[2/5] Building Vite project in ${projectPath}...`);
    const buildPath = await buildViteProject(projectPath);

    console.log(`[3/5] Capturing rendered HTML from routes...`);
    const pages = await renderPages(buildPath, projectPath);

    console.log(`[4/5] Converting rendered HTML into WordPress templates...`);
    const themeFiles = await convertHtmlToPhp(pages);

    console.log(`[5/5] Packaging WordPress Theme...`);
    const themeZipPath = await packageTheme(themeFiles, buildPath, zipPath);

    console.log(`\nSuccess! WordPress theme generated at: ${themeZipPath}`);
    
    // Cleanup temp extracted dir
    fs.rmSync(projectPath, { recursive: true, force: true });
    
  } catch (err) {
    console.error('\nAgent Pipeline Failed:', err.message);
    process.exit(1);
  }
}

main();
