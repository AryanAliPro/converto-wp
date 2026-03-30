const fs = require('fs');
const path = require('path');
const puppeteer = require('puppeteer');
const http = require('http');

/**
 * Very basic static server for the SPA. 
 * Resolves everything to index.html to support React Router history mode.
 */
function startStaticServer(distPath, port) {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      // Basic static file serving
      const filePath = path.join(distPath, req.url === '/' ? 'index.html' : req.url);
      
      fs.stat(filePath, (err, stats) => {
        if (!err && stats.isFile()) {
           const ext = path.extname(filePath);
           const mimicTypes = {
             '.html': 'text/html',
             '.js': 'text/javascript',
             '.css': 'text/css',
             '.png': 'image/png',
             '.jpg': 'image/jpeg',
             '.jpeg': 'image/jpeg',
             '.webp': 'image/webp',
             '.gif': 'image/gif',
             '.avif': 'image/avif',
             '.svg': 'image/svg+xml',
             '.ico': 'image/x-icon',
           };
           res.writeHead(200, { 'Content-Type': mimicTypes[ext] || 'text/plain' });
           fs.createReadStream(filePath).pipe(res);
           return;
        }
        
        // SPA Fallback: send index.html
        res.writeHead(200, { 'Content-Type': 'text/html' });
        fs.createReadStream(path.join(distPath, 'index.html')).pipe(res);
      });
    });

    server.listen(port, () => resolve(server));
  });
}

/**
 * Attempts to parse App.tsx to find routes. Returns a list of paths.
 * (A basic implementation: in a real robust system, this needs an AST parser)
 */
function detectRoutes(projectPath) {
  const routes = ['/'];
  const appTsxPath = path.join(projectPath, 'src', 'App.tsx');
  
  if (fs.existsSync(appTsxPath)) {
    const content = fs.readFileSync(appTsxPath, 'utf8');
    // Simple regex to find <Route path="/something" ... />
    const routeRegex = /path=["'](\/[^"']*)["']/g;
    let match;
    while ((match = routeRegex.exec(content)) !== null) {
      if (match[1] !== '/' && match[1] !== '*') {
         routes.push(match[1]);
      }
    }
  }
  return [...new Set(routes)];
}

/**
 * Launches Puppeteer, visits the SPA, and extracts rendered body HTML.
 */
async function renderPages(distPath, projectPath, logDetail = () => {}) {
  logDetail(`Detecting SPA routes...`);
  const routes = detectRoutes(projectPath);
  logDetail(`Found routes: ${routes.join(', ')}`);

  logDetail(`Starting local server for SPA rendering...`);
  const PORT = 34567;
  const server = await startStaticServer(distPath, PORT);

  const browser = await puppeteer.launch({
    headless: 'new',
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'],
  });
  const pagesData = [];

  try {
    for (const route of routes) {
      logDetail(`Rendering route: ${route}`);
      const page = await browser.newPage();
      
      // Navigate and wait for network idle to ensure React hydrates and renders
      await page.goto(`http://localhost:${PORT}${route}`, { waitUntil: 'networkidle0' });
      
      // Wait a tiny bit extra for Framer Motion / animations to settle into final state
      await new Promise(r => setTimeout(r, 1000));

      // We only need the visible page markup; skipping the full document
      // avoids resending head metadata and build boilerplate on every route.
      const html = await page.evaluate(() => (
        (() => {
          if (!document.body) {
            return document.documentElement.outerHTML;
          }

          const onlyChild = document.body.children.length === 1
            ? document.body.firstElementChild
            : null;

          if (onlyChild && onlyChild.id === 'root' && onlyChild.innerHTML.trim()) {
            return onlyChild.innerHTML;
          }

          return document.body.outerHTML;
        })()
      ));
      pagesData.push({ route, html });
      await page.close();
    }
  } finally {
    await browser.close();
    server.close();
  }

  return pagesData;
}

module.exports = { renderPages };
