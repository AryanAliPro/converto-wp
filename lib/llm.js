const cheerio = require('cheerio');

const DEFAULT_CONCURRENCY = 4;
const DEFAULT_RECOVERY_PASSES = 1;
const THEME_ASSET_PREFIX = `<?php echo get_template_directory_uri(); ?>/vite-assets`;

function stripNonContentNodes($) {
  $('script, noscript, style, link[rel="modulepreload"], link[as="script"], meta').remove();
  $('[role="region"][aria-label*="Notifications"], section[aria-label*="Notifications"]').remove();

  $('*').contents().each((_, node) => {
    if (node.type === 'comment') {
      $(node).remove();
    }
  });
}

function getConcurrencyLimit() {
  const configured = Number.parseInt(process.env.LLM_CONCURRENCY || '', 10);
  if (Number.isFinite(configured) && configured > 0) {
    return configured;
  }

  return DEFAULT_CONCURRENCY;
}

function getRecoveryPasses() {
  const configured = Number.parseInt(process.env.LLM_RECOVERY_PASSES || '', 10);
  if (Number.isFinite(configured) && configured >= 0) {
    return configured;
  }

  return DEFAULT_RECOVERY_PASSES;
}

function getTemplateInfo(route) {
  const slug = route === '/' ? 'front-page' : route.replace('/', '');
  const templateName = slug === 'front-page' ? 'front-page.php' : `page-${slug}.php`;
  const templateLabel = slug === 'front-page'
    ? 'Home Page'
    : `${slug.charAt(0).toUpperCase()}${slug.slice(1)} Template`;

  return { slug, templateName, templateLabel };
}

function normalizeRoutePath(route = '') {
  if (!route || route === '/') {
    return '/';
  }

  return route.endsWith('/') ? route : `${route}/`;
}

function formatErrorDetails(error) {
  const parts = [];

  if (error?.message) {
    parts.push(error.message);
  }

  if (error?.cause?.message && error.cause.message !== error.message) {
    parts.push(`cause: ${error.cause.message}`);
  }

  return parts.join(' | ') || 'Unknown conversion error';
}

function normalizeThemeAssetCandidate(rawPath) {
  if (!rawPath) return '';

  let normalized = rawPath.trim().replace(/^['"]|['"]$/g, '');
  if (!normalized || normalized.includes('get_template_directory_uri()')) return '';
  if (/^(data:|mailto:|tel:|#|javascript:)/i.test(normalized)) return '';

  if (/^https?:\/\//i.test(normalized)) {
    try {
      const parsed = new URL(normalized);
      if (!/^(localhost|127\.0\.0\.1)$/i.test(parsed.hostname)) {
        return '';
      }

      normalized = `${parsed.pathname || ''}${parsed.search || ''}`;
    } catch {
      return '';
    }
  } else if (/^\/\//.test(normalized)) {
    return '';
  }

  normalized = normalized.replace(/^(?:\.\.?\/)+/g, '');
  normalized = normalized.replace(/^\/+/, '');

  if (!normalized) return '';
  if (/^(assets|lovable-uploads)\//i.test(normalized)) return normalized;
  if (/^placeholder\.svg(\?.*)?$/i.test(normalized)) return normalized;
  if (/^[^/?#]+\.(png|jpe?g|gif|svg|webp|avif|ico|bmp|mp4|webm|ogg|mp3|wav|pdf|woff2?|ttf|eot)(\?.*)?$/i.test(normalized)) {
    return `assets/${normalized}`;
  }

  return '';
}

function looksLikeThemeAssetPath(rawPath, attributeName = '') {
  const normalized = normalizeThemeAssetCandidate(rawPath);
  if (!normalized) return false;

  if (attributeName.toLowerCase() === 'href') {
    return /\.(png|jpe?g|gif|svg|webp|avif|ico|bmp|mp4|webm|ogg|mp3|wav|pdf|woff2?|ttf|eot)(\?.*)?$/i.test(normalized);
  }

  return /\.(png|jpe?g|gif|svg|webp|avif|ico|bmp|mp4|webm|ogg|mp3|wav|woff2?|ttf|eot)(\?.*)?$/i.test(normalized);
}

function toThemeAssetPath(rawPath) {
  const normalized = normalizeThemeAssetCandidate(rawPath);
  return normalized ? `${THEME_ASSET_PREFIX}/${normalized}` : rawPath;
}

function rewriteSrcsetValue(value) {
  return value
    .split(',')
    .map((entry) => {
      const trimmed = entry.trim();
      if (!trimmed) return trimmed;

      const [url, ...descriptor] = trimmed.split(/\s+/);
      if (!looksLikeThemeAssetPath(url, 'srcset')) {
        return trimmed;
      }

      const rewrittenUrl = toThemeAssetPath(url);
      return descriptor.length ? `${rewrittenUrl} ${descriptor.join(' ')}` : rewrittenUrl;
    })
    .join(', ');
}

function rewriteCssUrls(value) {
  return value.replace(/url\((['"]?)([^'")]+)\1\)/gi, (match, quote, url) => {
    if (!looksLikeThemeAssetPath(url, 'style')) {
      return match;
    }

    return `url(${quote}${toThemeAssetPath(url)}${quote})`;
  });
}

function getClassTokens(className = '') {
  return String(className)
    .split(/\s+/)
    .map((token) => token.trim())
    .filter(Boolean);
}

function hasClassToken(className = '', token) {
  return getClassTokens(className).includes(token);
}

function scoreLikelyDesktopNav($, element) {
  const nav = $(element);
  const links = nav.find('a[href]').length;
  if (links < 2) return -1;

  const className = nav.attr('class') || '';
  let score = links;

  if (hasClassToken(className, 'hidden')) score += 2;
  if (getClassTokens(className).some((token) => /^md:flex$|^lg:flex$/.test(token))) score += 3;
  if (getClassTokens(className).some((token) => /^md:hidden$|^lg:hidden$/.test(token))) score -= 3;

  return score;
}

function isLikelyMenuToggleButton($, element) {
  const button = $(element);
  const ariaLabel = button.attr('aria-label') || '';
  if (/menu|toggle/i.test(ariaLabel)) {
    return true;
  }

  const buttonClasses = button.attr('class') || '';
  if (getClassTokens(buttonClasses).some((token) => /menu/i.test(token))) {
    return true;
  }

  return button.find('svg').toArray().some((svg) => {
    const svgClasses = $(svg).attr('class') || '';
    return /lucide-(menu|x)/i.test(svgClasses);
  });
}

function scoreLikelyActionGroup($, element) {
  const container = $(element);
  const navDescendants = container.find('nav').length;
  if (navDescendants > 0) return -1;

  const buttons = container.find('button').length;
  const links = container.find('a[href]').length;
  const phoneLinks = container.find('a[href^="tel:"]').length;
  const className = container.attr('class') || '';

  if (buttons === 0 && phoneLinks === 0) return -1;

  let score = buttons * 3 + phoneLinks * 2 + Math.min(links, 2);
  if (hasClassToken(className, 'hidden')) score += 1;
  if (getClassTokens(className).some((token) => /^md:flex$|^lg:flex$/.test(token))) score += 2;

  return score;
}

function annotateMobileMenuMarkup(markup) {
  if (!markup) return markup;

  const $ = cheerio.load(markup, { decodeEntities: false });
  const root = $('header, nav').first();
  if (!root.length) {
    return markup;
  }

  const toggleButton = root.find('button').toArray().find((element) => isLikelyMenuToggleButton($, element));
  const navCandidates = root.find('nav').toArray();
  const desktopNav = navCandidates
    .map((element) => ({ element, score: scoreLikelyDesktopNav($, element) }))
    .sort((a, b) => b.score - a.score)[0];

  const actionCandidates = root.find('div, section, aside').toArray();
  const actionGroup = actionCandidates
    .map((element) => ({ element, score: scoreLikelyActionGroup($, element) }))
    .sort((a, b) => b.score - a.score)[0];

  if (!toggleButton || !desktopNav || desktopNav.score < 0) {
    return markup;
  }

  root.attr('data-wp-mobile-header', 'true');
  $(toggleButton).attr('data-wp-mobile-toggle', 'true');
  $(toggleButton).attr('aria-expanded', 'false');

  $(desktopNav.element).attr('data-wp-mobile-source-nav', 'true');

  if (actionGroup && actionGroup.score >= 0) {
    $(actionGroup.element).attr('data-wp-mobile-source-actions', 'true');
  }

  const body = $('body');
  return body.length ? body.html() : $.root().html();
}

function truncateLabel(value = '', maxLength = 60) {
  const normalized = String(value).replace(/\s+/g, ' ').trim();
  if (normalized.length <= maxLength) {
    return normalized;
  }

  return `${normalized.slice(0, maxLength - 1).trimEnd()}...`;
}

function buildSelectorPath($, element, boundaryElement = null) {
  if (!element || element.type !== 'tag') {
    return '';
  }

  const segments = [];
  let current = element;

  while (current && current.type === 'tag') {
    if (boundaryElement && current === boundaryElement) {
      break;
    }

    const parent = current.parent;
    const tagName = current.tagName.toLowerCase();
    const index = $(current).prevAll(tagName).length + 1;
    segments.unshift(`${tagName}:nth-of-type(${index})`);

    if (!parent || parent.type === 'root' || (boundaryElement && parent === boundaryElement)) {
      break;
    }

    current = parent;
  }

  return segments.join(' > ');
}

function getFieldGroupLabel($, element) {
  if (!element || element.type !== 'tag') {
    return 'General';
  }

  const sectionLike = $(element).closest('section, article, form, aside');
  if (sectionLike.length) {
    const heading = sectionLike.find('h1, h2, h3, h4, h5, h6').first();
    const headingText = heading.text().replace(/\s+/g, ' ').trim();
    if (headingText) {
      return truncateLabel(headingText, 40);
    }

    const ariaLabel = (sectionLike.attr('aria-label') || '').trim();
    if (ariaLabel) {
      return truncateLabel(ariaLabel, 40);
    }
  }

  const nearestHeading = $(element).prevAll('h1, h2, h3, h4, h5, h6').first();
  const nearestHeadingText = nearestHeading.text().replace(/\s+/g, ' ').trim();
  if (nearestHeadingText) {
    return truncateLabel(nearestHeadingText, 40);
  }

  return 'General';
}

function getTextFieldLabel(tagName, text) {
  const prefixMap = {
    h1: 'Heading',
    h2: 'Heading',
    h3: 'Heading',
    h4: 'Heading',
    h5: 'Heading',
    h6: 'Heading',
    p: 'Paragraph',
    a: 'Link',
    button: 'Button',
    li: 'List Item',
    label: 'Form Label',
    option: 'Option',
  };

  const prefix = prefixMap[tagName] || 'Text';
  return `${prefix}: ${truncateLabel(text)}`;
}

function prepareEditableContentForPage(route, html) {
  if (!html) {
    return { fields: [], annotatedHtml: html || '' };
  }

  const $ = cheerio.load(`<div data-wp-schema-root="true">${html}</div>`, { decodeEntities: false });
  stripNonContentNodes($);

  const schemaRoot = $('[data-wp-schema-root="true"]').first();
  const preferredScope = schemaRoot.children('main').first().length
    ? schemaRoot.children('main').first()
    : schemaRoot.find('main').first();
  const editableScope = preferredScope.length ? preferredScope : schemaRoot;
  const selectorBoundary = editableScope.get(0);
  const scopeSelector = preferredScope.length ? 'main' : '';

  const fields = [];
  const usedSelectors = new Set();
  const skipTags = new Set(['script', 'style', 'noscript', 'svg', 'path', 'meta', 'link']);
  const allowedTextTags = new Set(['h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'p', 'a', 'button', 'li', 'label', 'option']);
  const normalizedRoute = normalizeRoutePath(route);
  let fieldIndex = 0;

  editableScope.find('img[src]').each((_, element) => {
    const src = ($(element).attr('src') || '').trim();
    if (!src || /^data:/i.test(src)) {
      return;
    }

    if ($(element).parents('header, footer, nav, [role="dialog"], dialog').length > 0) {
      return;
    }

    const selector = buildSelectorPath($, element, selectorBoundary);
    if (!selector || usedSelectors.has(`image:${selector}`)) {
      return;
    }

    const alt = ($(element).attr('alt') || '').trim();
    const filename = src.split('/').pop() || 'image';
    fieldIndex += 1;
    const field = {
      id: `${normalizedRoute === '/' ? 'home' : normalizedRoute.replace(/[^\w]+/g, '_').replace(/^_+|_+$/g, '')}_image_${fieldIndex}`,
      type: 'image',
      selector,
      scope: scopeSelector,
      attribute: 'src',
      defaultValue: src,
      label: alt ? `Image: ${truncateLabel(alt)}` : `Image: ${truncateLabel(filename)}`,
      group: getFieldGroupLabel($, element),
    };
    fields.push(field);
    $(element).attr('data-wp-field-id', field.id);
    usedSelectors.add(`image:${selector}`);
  });

  editableScope.find('*').each((_, element) => {
    const tagName = (element.tagName || '').toLowerCase();
    if (!tagName || skipTags.has(tagName) || !allowedTextTags.has(tagName)) {
      return;
    }

    const wrapped = $(element);
    if (wrapped.attr('aria-hidden') === 'true' || wrapped.parents('[aria-hidden="true"]').length > 0) {
      return;
    }

    if (wrapped.parents('header, footer, nav, [role="dialog"], dialog').length > 0) {
      return;
    }

    if (wrapped.children().length > 0) {
      return;
    }

    const text = wrapped.text().replace(/\s+/g, ' ').trim();
    if (text.length < 2) {
      return;
    }

    const selector = buildSelectorPath($, element, selectorBoundary);
    if (!selector || usedSelectors.has(`text:${selector}`)) {
      return;
    }

    fieldIndex += 1;
    const field = {
      id: `${normalizedRoute === '/' ? 'home' : normalizedRoute.replace(/[^\w]+/g, '_').replace(/^_+|_+$/g, '')}_text_${fieldIndex}`,
      type: 'text',
      selector,
      scope: scopeSelector,
      defaultValue: text,
      label: getTextFieldLabel(tagName, text),
      group: getFieldGroupLabel($, element),
    };
    fields.push(field);
    $(element).attr('data-wp-field-id', field.id);
    usedSelectors.add(`text:${selector}`);
  });

  return {
    fields,
    annotatedHtml: schemaRoot.html() || html,
  };
}

function buildContentSchema(pagesData) {
  return {
    routes: pagesData.map((page) => {
      const { templateLabel } = getTemplateInfo(page.route);
      return {
        route: normalizeRoutePath(page.route),
        label: templateLabel,
        fields: Array.isArray(page.editableFields) ? page.editableFields : [],
      };
    }),
  };
}

function buildDirectTemplate(page) {
  const { templateLabel } = getTemplateInfo(page.route);
  const routeMarkup = annotateMobileMenuMarkup(rewriteThemeAssetPaths((page.templateHtml || page.html || '').trim()));
  const routePath = normalizeRoutePath(page.route);

  return `<?php
/*
Template Name: ${templateLabel}
*/
get_header(); 
?>
<div id="root" data-wp-route="${routePath}">
${routeMarkup}
</div>
<?php get_footer(); ?>`;
}

function rewriteThemeAssetPaths(markup) {
  if (!markup) return markup;

  let rewritten = markup;

  rewritten = rewritten.replace(/\b(srcset|data-srcset|data-lazy-srcset)=("([^"]*)"|'([^']*)')/gi, (match, attrName, quotedValue, doubleQuoted, singleQuoted) => {
    const quote = quotedValue[0];
    const value = doubleQuoted ?? singleQuoted ?? '';
    return `${attrName}=${quote}${rewriteSrcsetValue(value)}${quote}`;
  });

  rewritten = rewritten.replace(/\b(src|href|poster|data-src|data-background|data-bg|data-image|data-thumb|data-thumb-src|data-lazy-src|data-poster|xlink:href)=("([^"]*)"|'([^']*)')/gi, (match, attrName, quotedValue, doubleQuoted, singleQuoted) => {
    const quote = quotedValue[0];
    const value = doubleQuoted ?? singleQuoted ?? '';

    if (!looksLikeThemeAssetPath(value, attrName)) {
      return match;
    }

    return `${attrName}=${quote}${toThemeAssetPath(value)}${quote}`;
  });

  rewritten = rewritten.replace(/\bstyle=("([^"]*)"|'([^']*)')/gi, (match, quotedValue, doubleQuoted, singleQuoted) => {
    const quote = quotedValue[0];
    const value = doubleQuoted ?? singleQuoted ?? '';
    return `style=${quote}${rewriteCssUrls(value)}${quote}`;
  });

  return rewriteCssUrls(rewritten);
}

async function convertSinglePage(page, platform, logDetail) {
  const { templateName } = getTemplateInfo(page.route);
  const renderMode = 'full DOM kept for client runtime';

  logDetail(
    `Agent: Converting route '${page.route}' into ${templateName} (${(page.templateHtml || page.html || '').length.toLocaleString()} chars, ${renderMode})...`
  );

  return {
    templateName,
    phpContent: buildDirectTemplate(page),
  };
}

/**
 * Converts captured HTML into WordPress PHP templates using the rendered DOM pipeline
 */
async function convertHtmlToPhp(pagesData, platform = 'Lovable', logDetail = () => {}) {
  if (!pagesData || pagesData.length === 0) return {};

  const themeFiles = {
    'header.php': '',
    'footer.php': '',
    'content-schema.json': '',
  };

  try {
    logDetail(`Agent: Analyzing DOM structure across ${pagesData.length} routes from ${platform}...`);
    logDetail(
      `Agent: Step 4 settings -> concurrency ${getConcurrencyLimit()}, recovery passes ${getRecoveryPasses()}, full-page DOM with client runtime enabled.`
    );
    logDetail(`Agent: Building lightweight WordPress wrappers and keeping each route's full rendered DOM for client-side app mounting...`);

    themeFiles['header.php'] = `<!DOCTYPE html>
<html <?php language_attributes(); ?>>
<head>
    <meta charset="<?php bloginfo( 'charset' ); ?>">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <?php wp_head(); ?>
</head>
<body <?php body_class(); ?>>
<?php wp_body_open(); ?>`;

    themeFiles['footer.php'] = `<?php wp_footer(); ?>
</body>
</html>`;

    logDetail(`Agent: Generated WordPress document wrappers successfully.`, 10);

    const totalPages = pagesData.length;
    let pagesCompleted = 0;
    const preparedPages = pagesData.map((page) => {
      const preparedContent = prepareEditableContentForPage(page.route, page.html || '');
      return {
        ...page,
        editableFields: preparedContent.fields,
        templateHtml: preparedContent.annotatedHtml || page.html || '',
      };
    });

    themeFiles['content-schema.json'] = `${JSON.stringify(buildContentSchema(preparedPages), null, 2)}\n`;

    const totalPreparedChars = preparedPages.reduce((sum, page) => sum + page.templateHtml.length, 0);
    logDetail(
      `Agent: Preserving ${totalPreparedChars.toLocaleString()} chars of rendered route DOM for 1:1 page output and client-side app mounting.`
    );

    const baseConcurrency = getConcurrencyLimit();
    const recoveryPasses = getRecoveryPasses();
    let pendingPages = preparedPages.map((page) => ({ ...page, attemptPass: 0, lastError: '' }));

    logDetail(`Agent: Converting up to ${baseConcurrency} pages in parallel.`);

    for (let pass = 0; pass <= recoveryPasses && pendingPages.length > 0; pass++) {
      const isRecoveryPass = pass > 0;
      const concurrency = isRecoveryPass ? Math.max(1, Math.min(2, baseConcurrency)) : baseConcurrency;
      const passLabel = isRecoveryPass ? `recovery pass ${pass}` : 'initial pass';
      const failedPages = [];

      logDetail(`Agent: Starting ${passLabel} for ${pendingPages.length} page(s) with concurrency ${concurrency}.`);

      for (let i = 0; i < pendingPages.length; i += concurrency) {
        const batch = pendingPages.slice(i, i + concurrency);
        const results = await Promise.allSettled(
          batch.map((page) => convertSinglePage(page, platform, logDetail))
        );

        results.forEach((result, index) => {
          const page = batch[index];
          const { templateName } = getTemplateInfo(page.route);

          if (result.status === 'fulfilled') {
            themeFiles[result.value.templateName] = result.value.phpContent;
            pagesCompleted++;
            const currentPercent = 10 + Math.round((pagesCompleted / totalPages) * 90);
            logDetail(`Agent: Generated ${result.value.templateName} successfully.`, currentPercent);
            return;
          }

          const errorDetails = formatErrorDetails(result.reason);
          const nextPageState = {
            ...page,
            attemptPass: pass + 1,
            lastError: errorDetails,
          };

          if (pass < recoveryPasses) {
            logDetail(`Agent: ${templateName} failed (${errorDetails}). Queuing it for retry.`);
            failedPages.push(nextPageState);
          } else {
            logDetail(`Agent: ${templateName} failed permanently (${errorDetails}).`);
            failedPages.push(nextPageState);
          }
        });
      }

      pendingPages = failedPages;
    }

    if (pendingPages.length > 0) {
      const failedSummary = pendingPages
        .map((page) => {
          const { templateName } = getTemplateInfo(page.route);
          return `${templateName}: ${page.lastError}`;
        })
        .join('; ');

      throw new Error(`Failed to convert ${pendingPages.length} page(s) after retries. ${failedSummary}`);
    }

    logDetail(`Agent: All PHP templates finished!`, 100);

  } catch (error) {
    throw new Error(`Theme conversion logic failed: ${error.message}`);
  }

  return themeFiles;
}

module.exports = { convertHtmlToPhp };
