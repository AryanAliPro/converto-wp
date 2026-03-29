const fs = require('fs');
const path = require('path');
const archiver = require('archiver');
const os = require('os');

const TEXT_ASSET_EXTENSIONS = new Set([
    '.css',
    '.html',
    '.svg',
    '.xml',
]);

function findViteAssets(buildPath) {
    const result = { css: [], js: [] };

    const normalizeAssetPath = (value = '') => value
        .trim()
        .replace(/^https?:\/\/[^/]+/i, '')
        .replace(/^\.?\//, '');

    const indexHtmlPath = path.join(buildPath, 'index.html');
    if (fs.existsSync(indexHtmlPath)) {
        const indexHtml = fs.readFileSync(indexHtmlPath, 'utf8');
        const stylesheetMatches = indexHtml.matchAll(/<link[^>]+rel=["'][^"']*stylesheet[^"']*["'][^>]+href=["']([^"']+)["'][^>]*>/gi);
        const scriptMatches = indexHtml.matchAll(/<script[^>]+src=["']([^"']+)["'][^>]*><\/script>/gi);

        for (const match of stylesheetMatches) {
            const normalized = normalizeAssetPath(match[1]);
            if (normalized) {
                result.css.push(normalized);
            }
        }

        for (const match of scriptMatches) {
            const normalized = normalizeAssetPath(match[1]);
            if (normalized) {
                result.js.push(normalized);
            }
        }
    }

    if (result.css.length === 0 || result.js.length === 0) {
        const assetsDir = path.join(buildPath, 'assets');
        if (fs.existsSync(assetsDir)) {
            const files = fs.readdirSync(assetsDir);
            for (const file of files) {
                if (file.endsWith('.css') && result.css.length === 0) result.css.push(`assets/${file}`);
                if (file.endsWith('.js') && result.js.length === 0) result.js.push(`assets/${file}`);
            }
        }
    }

    return {
        css: [...new Set(result.css)],
        js: [...new Set(result.js)],
    };
}

function toPosixPath(filePath) {
    return filePath.split(path.sep).join('/');
}

function isThemeAssetReference(rawPath = '') {
    if (!rawPath) return false;

    const normalized = rawPath.trim();
    if (!normalized.startsWith('/')) return false;
    if (/^\/\//.test(normalized)) return false;

    return /^\/(assets|lovable-uploads)\//i.test(normalized) || /^\/placeholder\.svg(\?.*)?$/i.test(normalized);
}

function buildRelativeThemeAssetPath(filePath, buildPath, rawPath) {
    const fileDir = path.dirname(filePath);
    const relativeToRoot = path.relative(fileDir, buildPath);
    const assetPath = rawPath.replace(/^\/+/, '');
    const joined = relativeToRoot
        ? path.posix.join(toPosixPath(relativeToRoot), assetPath)
        : assetPath;

    return joined.startsWith('.') ? joined : `./${joined}`;
}

function rewriteThemeAssetReferences(content, filePath, buildPath) {
    if (!content) return content;

    return content.replace(/(?<prefix>[:=,(]\s*|["'`])(?<path>\/(?:assets|lovable-uploads)\/[^"'`\s)]+|\/placeholder\.svg(?:\?[^"'`\s)]*)?)/gi, (match, prefix, assetPath) => {
        if (!isThemeAssetReference(assetPath)) {
            return match;
        }

        return `${prefix}${buildRelativeThemeAssetPath(filePath, buildPath, assetPath)}`;
    });
}

function normalizeRuntimeThemeAssetReference(rawPath = '') {
    if (!rawPath) return '';

    let normalized = rawPath.trim().replace(/^['"`]|['"`]$/g, '');
    if (!normalized) return '';

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
    }

    normalized = normalized.replace(/^(?:\.\.?\/)+/g, '');
    normalized = normalized.replace(/^\/+/, '');

    if (/^(assets|lovable-uploads)\//i.test(normalized)) {
        return normalized;
    }

    if (/^placeholder\.svg(\?.*)?$/i.test(normalized)) {
        return normalized;
    }

    return '';
}

function buildThemeRuntimeAssetExpression(rawPath) {
    const normalized = normalizeRuntimeThemeAssetReference(rawPath);
    if (!normalized) {
        return JSON.stringify(rawPath);
    }

    return `((window.__LOVABLE_WP_THEME__&&window.__LOVABLE_WP_THEME__.viteAssetsBase)?window.__LOVABLE_WP_THEME__.viteAssetsBase+${JSON.stringify(`/${normalized}`)}:${JSON.stringify(rawPath)})`;
}

function rewriteThemeAssetReferencesInJs(content) {
    if (!content) return content;

    return content.replace(
        /(["'`])((?:https?:\/\/(?:localhost|127\.0\.0\.1)(?::\d+)?\/(?:assets|lovable-uploads)\/[^"'`\s)]+)|(?:\.\.?\/)+(?:assets|lovable-uploads)\/[^"'`\s)]+|\/(?:assets|lovable-uploads)\/[^"'`\s)]+|(?:\.\.?\/)+placeholder\.svg(?:\?[^"'`\s)]*)?|\/placeholder\.svg(?:\?[^"'`\s)]*)?)\1/gi,
        (match, quote, assetPath) => buildThemeRuntimeAssetExpression(assetPath)
    );
}

function stageBuildAssets(buildPath, logDetail = () => {}) {
    const stagedBuildPath = fs.mkdtempSync(path.join(os.tmpdir(), 'wp-theme-build-'));

    fs.cpSync(buildPath, stagedBuildPath, { recursive: true });

    const queue = [stagedBuildPath];
    while (queue.length > 0) {
        const currentPath = queue.pop();
        const entries = fs.readdirSync(currentPath, { withFileTypes: true });

        for (const entry of entries) {
            const entryPath = path.join(currentPath, entry.name);
            const extension = path.extname(entry.name).toLowerCase();

            if (entry.isDirectory()) {
                queue.push(entryPath);
                continue;
            }

            if (extension === '.js' || extension === '.mjs') {
                const original = fs.readFileSync(entryPath, 'utf8');
                const rewritten = rewriteThemeAssetReferencesInJs(original);

                if (rewritten !== original) {
                    fs.writeFileSync(entryPath, rewritten, 'utf8');
                }

                continue;
            }

            if (!TEXT_ASSET_EXTENSIONS.has(extension)) {
                continue;
            }

            const original = fs.readFileSync(entryPath, 'utf8');
            const rewritten = rewriteThemeAssetReferences(original, entryPath, stagedBuildPath);

            if (rewritten !== original) {
                fs.writeFileSync(entryPath, rewritten, 'utf8');
            }
        }
    }

    logDetail(`Rewrote bundled CSS/HTML asset paths and JS runtime asset literals for WordPress theme paths.`);

    return stagedBuildPath;
}

/**
 * Generates functions.php to properly enqueue Vite CSS and JS
 */
function createFunctionsPhp(viteAssets, themeFiles) {
  let assetEnqueue = '';
  viteAssets.css.forEach((file, i) => {
      assetEnqueue += `    wp_enqueue_style('theme-style-${i}', get_template_directory_uri() . '/vite-assets/${file}', array(), filemtime(get_template_directory() . '/vite-assets/${file}'), 'all');\n`;
  });

  if (viteAssets.js.length > 0) {
      viteAssets.js.forEach((file, i) => {
          assetEnqueue += `    wp_enqueue_script('theme-script-${i}', get_template_directory_uri() . '/vite-assets/${file}', array(), filemtime(get_template_directory() . '/vite-assets/${file}'), true);\n`;
          assetEnqueue += `    wp_script_add_data('theme-script-${i}', 'type', 'module');\n`;
      });
      assetEnqueue += `    wp_add_inline_script('theme-script-0', 'window.__LOVABLE_WP_THEME__ = ' . wp_json_encode(array(
        'basename' => untrailingslashit((string) (wp_parse_url(home_url('/'), PHP_URL_PATH) ?: '')),
        'viteAssetsBase' => get_template_directory_uri() . '/vite-assets',
        'hydrationEnabled' => true,
        'contentOverrides' => theme_get_frontend_content_overrides(),
        'formEndpoint' => esc_url_raw(rest_url('lovable-theme/v1/form-submit')),
        'formRequestHeader' => 'X-Lovable-Theme-Form',
      )) . ';', 'before');\n`;
  } else {
      assetEnqueue += `    wp_enqueue_script('theme-interactions', get_template_directory_uri() . '/theme-interactions.js', array(), filemtime(get_template_directory() . '/theme-interactions.js'), true);\n`;
      assetEnqueue += `    wp_add_inline_script('theme-interactions', 'window.__LOVABLE_WP_THEME__ = ' . wp_json_encode(array(
        'basename' => untrailingslashit((string) (wp_parse_url(home_url('/'), PHP_URL_PATH) ?: '')),
        'viteAssetsBase' => get_template_directory_uri() . '/vite-assets',
        'hydrationEnabled' => false,
        'contentOverrides' => theme_get_frontend_content_overrides(),
        'formEndpoint' => esc_url_raw(rest_url('lovable-theme/v1/form-submit')),
        'formRequestHeader' => 'X-Lovable-Theme-Form',
      )) . ';', 'before');\n`;
  }

  assetEnqueue += `    wp_enqueue_script('theme-bridge', get_template_directory_uri() . '/theme-bridge.js', array(), filemtime(get_template_directory() . '/theme-bridge.js'), true);\n`;

  const pageSlugs = Object.keys(themeFiles)
    .filter((filename) => /^page-[^.]+\.php$/i.test(filename))
    .map((filename) => filename.replace(/^page-/i, '').replace(/\.php$/i, ''));

  const pageCreationEntries = pageSlugs
    .map((slug) => `        '${slug}' => '${slug.charAt(0).toUpperCase()}${slug.slice(1)}',`)
    .join('\n');

  return `<?php
function theme_load_content_schema() {
    static $schema = null;

    if ($schema !== null) {
        return $schema;
    }

    $schemaPath = get_template_directory() . '/content-schema.json';
    if (!file_exists($schemaPath)) {
        $schema = array('routes' => array());
        return $schema;
    }

    $decoded = json_decode((string) file_get_contents($schemaPath), true);
    if (!is_array($decoded)) {
        $decoded = array();
    }

    if (!isset($decoded['routes']) || !is_array($decoded['routes'])) {
        $decoded['routes'] = array();
    }

    $schema = $decoded;
    return $schema;
}

function theme_get_content_overrides() {
    $overrides = get_option('lovable_theme_content_overrides', array());
    return is_array($overrides) ? $overrides : array();
}

function theme_get_frontend_content_overrides() {
    $schema = theme_load_content_schema();
    $stored = theme_get_content_overrides();
    $compiled = array();

    foreach ($schema['routes'] as $routeEntry) {
        $routeKey = isset($routeEntry['route']) ? (string) $routeEntry['route'] : '';
        $fields = isset($routeEntry['fields']) && is_array($routeEntry['fields']) ? $routeEntry['fields'] : array();

        if ($routeKey === '' || empty($fields)) {
            continue;
        }

        foreach ($fields as $field) {
            $fieldId = isset($field['id']) ? (string) $field['id'] : '';
            $selector = isset($field['selector']) ? (string) $field['selector'] : '';
            $value = array_key_exists($fieldId, $stored) ? (string) $stored[$fieldId] : '';

            if ($fieldId === '' || $selector === '' || $value === '') {
                continue;
            }

            if (!isset($compiled[$routeKey])) {
                $compiled[$routeKey] = array();
            }

            $compiled[$routeKey][] = array(
                'fieldId' => $fieldId,
                'selector' => $selector,
                'scope' => isset($field['scope']) ? (string) $field['scope'] : '',
                'type' => isset($field['type']) ? (string) $field['type'] : 'text',
                'attribute' => isset($field['attribute']) ? (string) $field['attribute'] : '',
                'value' => $value,
            );
        }
    }

    return $compiled;
}

function theme_get_current_route_key() {
    global $wp;

    if (!isset($wp) || !isset($wp->request)) {
        return '/';
    }

    $requestPath = trim((string) $wp->request, '/');
    if ($requestPath === '') {
        return '/';
    }

    return '/' . $requestPath . '/';
}

function theme_apply_content_overrides_to_html($html) {
    if (!is_string($html) || $html === '') {
        return $html;
    }

    if (!class_exists('DOMDocument')) {
        return $html;
    }

    $allOverrides = theme_get_frontend_content_overrides();
    $routeKey = theme_get_current_route_key();
    $entries = isset($allOverrides[$routeKey]) && is_array($allOverrides[$routeKey])
        ? $allOverrides[$routeKey]
        : array();

    if (empty($entries)) {
        return $html;
    }

    $previousUseInternalErrors = libxml_use_internal_errors(true);
    $doc = new DOMDocument('1.0', 'UTF-8');

    if (!$doc->loadHTML('<?xml encoding="utf-8" ?>' . $html, LIBXML_HTML_NOIMPLIED | LIBXML_HTML_NODEFDTD)) {
        libxml_clear_errors();
        libxml_use_internal_errors($previousUseInternalErrors);
        return $html;
    }

    $xpath = new DOMXPath($doc);

    foreach ($entries as $entry) {
        $fieldId = isset($entry['fieldId']) ? sanitize_key((string) $entry['fieldId']) : '';
        $value = isset($entry['value']) ? (string) $entry['value'] : '';
        $type = isset($entry['type']) ? (string) $entry['type'] : 'text';
        $attribute = isset($entry['attribute']) ? (string) $entry['attribute'] : '';

        if ($fieldId === '' || $value === '') {
            continue;
        }

        $nodes = $xpath->query(sprintf("//*[@data-wp-field-id='%s']", $fieldId));
        if (!$nodes || $nodes->length === 0) {
            continue;
        }

        foreach ($nodes as $node) {
            if ($type === 'image' || $attribute !== '') {
                $attributeName = $attribute !== '' ? $attribute : 'src';
                if ($node instanceof DOMElement) {
                    $node->setAttribute($attributeName, $value);
                }
                continue;
            }

            $node->nodeValue = '';
            $node->appendChild($doc->createTextNode($value));
        }
    }

    $result = $doc->saveHTML();
    libxml_clear_errors();
    libxml_use_internal_errors($previousUseInternalErrors);

    return preg_replace('/^<\\?xml[^>]+>\\s*/', '', (string) $result);
}

function theme_start_content_override_buffer() {
    if (is_admin() || wp_doing_ajax() || is_feed() || is_embed() || (defined('REST_REQUEST') && REST_REQUEST)) {
        return;
    }

    ob_start('theme_apply_content_overrides_to_html');
}
add_action('template_redirect', 'theme_start_content_override_buffer', 0);

function theme_sanitize_content_overrides($input) {
    $input = is_array($input) ? $input : array();
    $schema = theme_load_content_schema();
    $sanitized = array();

    foreach ($schema['routes'] as $routeEntry) {
        $fields = isset($routeEntry['fields']) && is_array($routeEntry['fields']) ? $routeEntry['fields'] : array();

        foreach ($fields as $field) {
            $fieldId = isset($field['id']) ? (string) $field['id'] : '';
            $fieldType = isset($field['type']) ? (string) $field['type'] : 'text';

            if ($fieldId === '' || !array_key_exists($fieldId, $input)) {
                continue;
            }

            $rawValue = is_string($input[$fieldId]) ? trim($input[$fieldId]) : '';
            if ($rawValue === '') {
                continue;
            }

            $sanitized[$fieldId] = $fieldType === 'image'
                ? esc_url_raw($rawValue)
                : sanitize_textarea_field($rawValue);
        }
    }

    return $sanitized;
}

function theme_register_content_settings() {
    register_setting('lovable_theme_content', 'lovable_theme_content_overrides', array(
        'type' => 'array',
        'sanitize_callback' => 'theme_sanitize_content_overrides',
        'default' => array(),
    ));
}
add_action('admin_init', 'theme_register_content_settings');

function theme_enqueue_content_admin_assets($hook) {
    if ($hook !== 'appearance_page_lovable-theme-content') {
        return;
    }

    wp_enqueue_media();
}
add_action('admin_enqueue_scripts', 'theme_enqueue_content_admin_assets');

function theme_group_admin_fields($fields) {
    $grouped = array();

    foreach ($fields as $field) {
        $groupLabel = isset($field['group']) && $field['group'] !== ''
            ? (string) $field['group']
            : __('General', 'lovable-theme');

        if (!isset($grouped[$groupLabel])) {
            $grouped[$groupLabel] = array();
        }

        $grouped[$groupLabel][] = $field;
    }

    return $grouped;
}

function theme_render_content_admin_page() {
    if (!current_user_can('manage_options')) {
        return;
    }

    $schema = theme_load_content_schema();
    $overrides = theme_get_content_overrides();
    $routeEntries = isset($schema['routes']) && is_array($schema['routes']) ? $schema['routes'] : array();
    ?>
    <div class="wrap lovable-theme-admin">
        <style>
            .lovable-theme-admin {
                max-width: 1240px;
            }
            .lovable-theme-admin__intro {
                margin: 16px 0 24px;
                padding: 18px 20px;
                background: #ffffff;
                border: 1px solid #dcdcde;
                border-radius: 14px;
            }
            .lovable-theme-admin__intro p {
                margin: 8px 0 0;
                color: #50575e;
                max-width: 860px;
            }
            .lovable-theme-admin__toolbar {
                display: grid;
                gap: 16px;
                margin-bottom: 20px;
            }
            .lovable-theme-admin__tabs {
                display: flex;
                flex-wrap: wrap;
                gap: 8px;
            }
            .lovable-theme-admin__tab {
                border: 1px solid #c3c4c7;
                background: #ffffff;
                color: #1d2327;
                padding: 9px 14px;
                border-radius: 999px;
                cursor: pointer;
                font-weight: 600;
            }
            .lovable-theme-admin__tab.is-active {
                background: #1d4ed8;
                border-color: #1d4ed8;
                color: #ffffff;
            }
            .lovable-theme-admin__search input {
                width: 100%;
                max-width: 440px;
                padding: 10px 14px;
                border-radius: 10px;
            }
            .lovable-theme-admin__panel {
                display: none;
            }
            .lovable-theme-admin__panel.is-active {
                display: block;
            }
            .lovable-theme-admin__panel-summary {
                margin: 0 0 18px;
                color: #50575e;
            }
            .lovable-theme-admin__group {
                margin: 0 0 18px;
                padding: 18px;
                background: #ffffff;
                border: 1px solid #dcdcde;
                border-radius: 14px;
            }
            .lovable-theme-admin__group-title {
                margin: 0 0 16px;
                font-size: 16px;
            }
            .lovable-theme-admin__grid {
                display: grid;
                grid-template-columns: repeat(auto-fit, minmax(320px, 1fr));
                gap: 16px;
            }
            .lovable-theme-admin__field {
                display: grid;
                gap: 10px;
                padding: 16px;
                border: 1px solid #e2e8f0;
                border-radius: 12px;
                background: #f8fafc;
            }
            .lovable-theme-admin__field-head {
                display: flex;
                justify-content: space-between;
                align-items: center;
                gap: 12px;
            }
            .lovable-theme-admin__field-title {
                margin: 0;
                font-size: 14px;
                line-height: 1.4;
            }
            .lovable-theme-admin__badge {
                display: inline-flex;
                align-items: center;
                justify-content: center;
                min-width: 54px;
                padding: 4px 8px;
                border-radius: 999px;
                background: #e0f2fe;
                color: #075985;
                font-size: 11px;
                font-weight: 700;
                text-transform: uppercase;
                letter-spacing: .04em;
            }
            .lovable-theme-admin__field textarea,
            .lovable-theme-admin__field input[type="url"] {
                width: 100%;
                margin: 0;
                border-radius: 10px;
            }
            .lovable-theme-admin__media-row {
                display: flex;
                flex-wrap: wrap;
                gap: 8px;
                align-items: center;
            }
            .lovable-theme-admin__default {
                margin: 0;
                color: #50575e;
                font-size: 12px;
                line-height: 1.5;
            }
            .lovable-theme-admin__preview {
                max-width: 180px;
                height: auto;
                border: 1px solid #dcdcde;
                border-radius: 10px;
                padding: 4px;
                background: #ffffff;
            }
            .lovable-theme-admin__actions {
                position: sticky;
                bottom: 0;
                display: flex;
                align-items: center;
                justify-content: space-between;
                gap: 16px;
                margin-top: 24px;
                padding: 14px 18px;
                background: rgba(255, 255, 255, 0.96);
                border: 1px solid #dcdcde;
                border-radius: 14px;
                backdrop-filter: blur(8px);
            }
            .lovable-theme-admin__hint {
                margin: 0;
                color: #50575e;
            }
            .lovable-theme-admin__empty {
                margin: 0;
                color: #50575e;
                font-style: italic;
            }
            @media (max-width: 782px) {
                .lovable-theme-admin__actions {
                    position: static;
                    flex-direction: column;
                    align-items: stretch;
                }
            }
        </style>
        <div class="lovable-theme-admin__intro">
            <h1><?php echo esc_html__('Theme Content', 'lovable-theme'); ?></h1>
            <p><?php echo esc_html__('Edit the main page content here without touching code. Switch between pages, search for the section you want, update the field, and save. The site will keep its original design and interactivity while showing your WordPress-managed content.', 'lovable-theme'); ?></p>
        </div>
        <?php if (isset($_GET['settings-updated'])) : ?>
            <div class="notice notice-success is-dismissible"><p><?php echo esc_html__('Theme content updated successfully.', 'lovable-theme'); ?></p></div>
        <?php endif; ?>
        <form method="post" action="options.php">
            <?php settings_fields('lovable_theme_content'); ?>
            <div class="lovable-theme-admin__toolbar">
                <div class="lovable-theme-admin__tabs" role="tablist" aria-label="<?php echo esc_attr__('Theme pages', 'lovable-theme'); ?>">
                    <?php foreach ($routeEntries as $routeIndex => $routeEntry) : ?>
                        <?php
                        $routeLabel = isset($routeEntry['label']) ? (string) $routeEntry['label'] : __('Page', 'lovable-theme');
                        $routeKey = isset($routeEntry['route']) ? (string) $routeEntry['route'] : '/';
                        $panelId = 'lovable-route-' . sanitize_title($routeKey === '/' ? 'home' : trim($routeKey, '/'));
                        ?>
                        <button
                            type="button"
                            class="lovable-theme-admin__tab<?php echo $routeIndex === 0 ? ' is-active' : ''; ?>"
                            data-route-tab="<?php echo esc_attr($panelId); ?>"
                            role="tab"
                            aria-selected="<?php echo $routeIndex === 0 ? 'true' : 'false'; ?>"
                        >
                            <?php echo esc_html($routeLabel); ?>
                        </button>
                    <?php endforeach; ?>
                </div>
                <div class="lovable-theme-admin__search">
                    <input type="search" id="lovable-theme-admin-search" placeholder="<?php echo esc_attr__('Search headings, buttons, paragraphs, sections...', 'lovable-theme'); ?>" />
                </div>
            </div>

            <?php foreach ($routeEntries as $routeIndex => $routeEntry) : ?>
                <?php
                $routeLabel = isset($routeEntry['label']) ? (string) $routeEntry['label'] : __('Page', 'lovable-theme');
                $routeKey = isset($routeEntry['route']) ? (string) $routeEntry['route'] : '/';
                $fields = isset($routeEntry['fields']) && is_array($routeEntry['fields']) ? $routeEntry['fields'] : array();
                $groupedFields = theme_group_admin_fields($fields);
                $panelId = 'lovable-route-' . sanitize_title($routeKey === '/' ? 'home' : trim($routeKey, '/'));
                ?>
                <section class="lovable-theme-admin__panel<?php echo $routeIndex === 0 ? ' is-active' : ''; ?>" data-route-panel="<?php echo esc_attr($panelId); ?>" role="tabpanel">
                    <p class="lovable-theme-admin__panel-summary">
                        <?php
                        echo esc_html(sprintf(
                            /* translators: 1: page label, 2: number of editable fields */
                            __('%1$s has %2$d editable content fields.', 'lovable-theme'),
                            $routeLabel,
                            count($fields)
                        ));
                        ?>
                    </p>

                    <?php if (empty($groupedFields)) : ?>
                        <p class="lovable-theme-admin__empty"><?php echo esc_html__('No editable content was detected for this page.', 'lovable-theme'); ?></p>
                    <?php endif; ?>

                    <?php foreach ($groupedFields as $groupLabel => $groupFields) : ?>
                        <div class="lovable-theme-admin__group" data-group-search="<?php echo esc_attr(strtolower($groupLabel)); ?>">
                            <h2 class="lovable-theme-admin__group-title"><?php echo esc_html($groupLabel); ?></h2>
                            <div class="lovable-theme-admin__grid">
                                <?php foreach ($groupFields as $field) : ?>
                                    <?php
                                    $fieldId = isset($field['id']) ? (string) $field['id'] : '';
                                    $fieldType = isset($field['type']) ? (string) $field['type'] : 'text';
                                    $fieldLabel = isset($field['label']) ? (string) $field['label'] : $fieldId;
                                    $defaultValue = isset($field['defaultValue']) ? (string) $field['defaultValue'] : '';
                                    $value = array_key_exists($fieldId, $overrides) ? (string) $overrides[$fieldId] : '';
                                    $searchText = strtolower(trim($fieldLabel . ' ' . $defaultValue . ' ' . $groupLabel . ' ' . $routeLabel));

                                    if ($fieldId === '') {
                                        continue;
                                    }
                                    ?>
                                    <article class="lovable-theme-admin__field" data-field-search="<?php echo esc_attr($searchText); ?>">
                                        <div class="lovable-theme-admin__field-head">
                                            <h3 class="lovable-theme-admin__field-title">
                                                <label for="<?php echo esc_attr($fieldId); ?>"><?php echo esc_html($fieldLabel); ?></label>
                                            </h3>
                                            <span class="lovable-theme-admin__badge"><?php echo esc_html($fieldType); ?></span>
                                        </div>

                                        <?php if ($fieldType === 'image') : ?>
                                            <div class="lovable-theme-admin__media-row">
                                                <input
                                                    type="url"
                                                    class="regular-text"
                                                    id="<?php echo esc_attr($fieldId); ?>"
                                                    name="lovable_theme_content_overrides[<?php echo esc_attr($fieldId); ?>]"
                                                    value="<?php echo esc_attr($value); ?>"
                                                    placeholder="<?php echo esc_attr($defaultValue); ?>"
                                                />
                                                <button
                                                    type="button"
                                                    class="button lovable-theme-media-button"
                                                    data-target-input="<?php echo esc_attr($fieldId); ?>"
                                                    data-target-preview="<?php echo esc_attr($fieldId); ?>_preview"
                                                >
                                                    <?php echo esc_html__('Choose Image', 'lovable-theme'); ?>
                                                </button>
                                            </div>
                                            <img
                                                class="lovable-theme-admin__preview"
                                                id="<?php echo esc_attr($fieldId); ?>_preview"
                                                src="<?php echo esc_url($value !== '' ? $value : $defaultValue); ?>"
                                                alt=""
                                                style="<?php echo esc_attr(($value !== '' || $defaultValue !== '') ? 'display:block;' : 'display:none;'); ?>"
                                            />
                                        <?php else : ?>
                                            <textarea
                                                class="large-text"
                                                rows="<?php echo (int) (strlen($defaultValue) > 140 ? 5 : 3); ?>"
                                                id="<?php echo esc_attr($fieldId); ?>"
                                                name="lovable_theme_content_overrides[<?php echo esc_attr($fieldId); ?>]"
                                                placeholder="<?php echo esc_attr($defaultValue); ?>"
                                            ><?php echo esc_textarea($value); ?></textarea>
                                        <?php endif; ?>

                                        <p class="lovable-theme-admin__default">
                                            <strong><?php echo esc_html__('Original:', 'lovable-theme'); ?></strong>
                                            <?php echo esc_html($defaultValue); ?>
                                        </p>
                                    </article>
                                <?php endforeach; ?>
                            </div>
                        </div>
                    <?php endforeach; ?>
                </section>
            <?php endforeach; ?>

            <div class="lovable-theme-admin__actions">
                <p class="lovable-theme-admin__hint"><?php echo esc_html__('Tip: save your changes, then refresh the frontend page you are editing to see the updated content applied over the original design.', 'lovable-theme'); ?></p>
                <?php submit_button(__('Save Theme Content', 'lovable-theme'), 'primary', 'submit', false); ?>
            </div>
        </form>
    </div>
    <script>
    document.addEventListener('DOMContentLoaded', function () {
        var tabs = Array.prototype.slice.call(document.querySelectorAll('.lovable-theme-admin__tab'));
        var panels = Array.prototype.slice.call(document.querySelectorAll('.lovable-theme-admin__panel'));
        var searchInput = document.getElementById('lovable-theme-admin-search');

        function setActivePanel(panelId) {
            tabs.forEach(function (tab) {
                var isActive = tab.getAttribute('data-route-tab') === panelId;
                tab.classList.toggle('is-active', isActive);
                tab.setAttribute('aria-selected', isActive ? 'true' : 'false');
            });

            panels.forEach(function (panel) {
                panel.classList.toggle('is-active', panel.getAttribute('data-route-panel') === panelId);
            });
        }

        tabs.forEach(function (tab) {
            tab.addEventListener('click', function () {
                setActivePanel(tab.getAttribute('data-route-tab'));
            });
        });

        if (searchInput) {
            searchInput.addEventListener('input', function () {
                var term = String(searchInput.value || '').toLowerCase().trim();

                document.querySelectorAll('.lovable-theme-admin__field').forEach(function (field) {
                    var haystack = field.getAttribute('data-field-search') || '';
                    field.style.display = term === '' || haystack.indexOf(term) !== -1 ? '' : 'none';
                });

                document.querySelectorAll('.lovable-theme-admin__group').forEach(function (group) {
                    var visibleFields = group.querySelectorAll('.lovable-theme-admin__field:not([style*="display: none"])').length;
                    group.style.display = visibleFields > 0 ? '' : 'none';
                });
            });
        }

        if (typeof wp === 'undefined' || !wp.media) {
            return;
        }

        document.querySelectorAll('.lovable-theme-media-button').forEach(function (button) {
            button.addEventListener('click', function () {
                var input = document.getElementById(button.getAttribute('data-target-input'));
                var preview = document.getElementById(button.getAttribute('data-target-preview'));
                var frame = wp.media({
                    title: '<?php echo esc_js(__('Select image', 'lovable-theme')); ?>',
                    button: { text: '<?php echo esc_js(__('Use image', 'lovable-theme')); ?>' },
                    multiple: false
                });

                frame.on('select', function () {
                    var attachment = frame.state().get('selection').first().toJSON();
                    if (!attachment || !attachment.url || !input) {
                        return;
                    }

                    input.value = attachment.url;

                    if (preview) {
                        preview.src = attachment.url;
                        preview.style.display = 'block';
                    }
                });

                frame.open();
            });
        });
    });
    </script>
    <?php
}

function theme_add_content_admin_page() {
    add_theme_page(
        __('Theme Content', 'lovable-theme'),
        __('Theme Content', 'lovable-theme'),
        'manage_options',
        'lovable-theme-content',
        'theme_render_content_admin_page'
    );
}
add_action('admin_menu', 'theme_add_content_admin_page');

function theme_register_form_entry_post_type() {
    register_post_type('lovable_form_entry', array(
        'labels' => array(
            'name' => __('Form Entries', 'lovable-theme'),
            'singular_name' => __('Form Entry', 'lovable-theme'),
        ),
        'public' => false,
        'show_ui' => true,
        'show_in_menu' => true,
        'menu_icon' => 'dashicons-email-alt',
        'supports' => array('title', 'editor', 'custom-fields'),
    ));
}
add_action('init', 'theme_register_form_entry_post_type');

function theme_get_form_limits() {
    return array(
        'max_fields' => 80,
        'max_labels' => 80,
        'max_total_characters' => 20000,
        'max_files' => 5,
        'max_file_size' => 10 * 1024 * 1024,
        'max_requests' => 8,
        'window_seconds' => 15 * MINUTE_IN_SECONDS,
    );
}

function theme_get_form_upload_allowed_extensions() {
    return array('jpg', 'jpeg', 'jpe', 'png', 'gif', 'webp', 'pdf', 'txt', 'csv', 'doc', 'docx');
}

function theme_get_form_upload_allowed_mimes() {
    return array(
        'jpg|jpeg|jpe' => 'image/jpeg',
        'png' => 'image/png',
        'gif' => 'image/gif',
        'webp' => 'image/webp',
        'pdf' => 'application/pdf',
        'txt' => 'text/plain',
        'csv' => 'text/csv',
        'doc' => 'application/msword',
        'docx' => 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    );
}

function theme_get_form_request_ip() {
    $remoteAddr = isset($_SERVER['REMOTE_ADDR']) ? (string) wp_unslash($_SERVER['REMOTE_ADDR']) : '';
    return sanitize_text_field($remoteAddr);
}

function theme_get_form_rate_limit_key() {
    $ip = theme_get_form_request_ip();
    if ($ip === '') {
        return '';
    }

    return 'lovable_form_rate_' . md5($ip);
}

function theme_is_form_rate_limited() {
    if (current_user_can('manage_options')) {
        return false;
    }

    $key = theme_get_form_rate_limit_key();
    if ($key === '') {
        return false;
    }

    $limits = theme_get_form_limits();
    $state = get_transient($key);
    return is_array($state) && isset($state['count']) && (int) $state['count'] >= (int) $limits['max_requests'];
}

function theme_increment_form_rate_limit() {
    if (current_user_can('manage_options')) {
        return;
    }

    $key = theme_get_form_rate_limit_key();
    if ($key === '') {
        return;
    }

    $limits = theme_get_form_limits();
    $state = get_transient($key);
    $count = is_array($state) && isset($state['count']) ? (int) $state['count'] : 0;

    set_transient($key, array(
        'count' => $count + 1,
    ), (int) $limits['window_seconds']);
}

function theme_validate_form_request_origin($request) {
    if (!$request instanceof WP_REST_Request) {
        return true;
    }

    $siteHost = (string) wp_parse_url(home_url('/'), PHP_URL_HOST);
    if ($siteHost === '') {
        return true;
    }

    foreach (array('origin', 'referer') as $headerName) {
        $headerValue = trim((string) $request->get_header($headerName));
        if ($headerValue === '') {
            continue;
        }

        $headerHost = (string) wp_parse_url($headerValue, PHP_URL_HOST);
        if ($headerHost !== '' && !hash_equals(strtolower($siteHost), strtolower($headerHost))) {
            return new WP_Error(
                'lovable_theme_invalid_origin',
                __('This form request was blocked because it did not originate from the current site.', 'lovable-theme'),
                array('status' => 403)
            );
        }
    }

    return true;
}

function theme_can_submit_public_form($request) {
    if (!$request instanceof WP_REST_Request) {
        return new WP_Error(
            'lovable_theme_invalid_form_request',
            __('This form request could not be verified.', 'lovable-theme'),
            array('status' => 403)
        );
    }

    $headerValue = trim((string) $request->get_header('x-lovable-theme-form'));
    if ($headerValue !== '1') {
        return new WP_Error(
            'lovable_theme_invalid_form_request',
            __('This form request could not be verified.', 'lovable-theme'),
            array('status' => 403)
        );
    }

    $originValidation = theme_validate_form_request_origin($request);
    if (is_wp_error($originValidation)) {
        return $originValidation;
    }

    if (theme_is_form_rate_limited()) {
        return new WP_Error(
            'lovable_theme_rate_limited',
            __('Too many form submissions were received from this address. Please wait a few minutes and try again.', 'lovable-theme'),
            array('status' => 429)
        );
    }

    return true;
}

function theme_sanitize_form_field_key($key) {
    $normalized = preg_replace('/([a-z0-9])([A-Z])/', '$1_$2', (string) $key);
    return sanitize_key($normalized);
}

function theme_normalize_form_value($value) {
    if (is_array($value)) {
        $normalized = array();

        foreach ($value as $item) {
            $itemValue = theme_normalize_form_value($item);

            if (is_array($itemValue)) {
                foreach ($itemValue as $flattenedValue) {
                    if ($flattenedValue !== '') {
                        $normalized[] = $flattenedValue;
                    }
                }
                continue;
            }

            if (is_string($itemValue) && $itemValue !== '') {
                $normalized[] = $itemValue;
            }
        }

        $normalized = array_values(array_unique($normalized));
        return empty($normalized) ? null : $normalized;
    }

    if (is_bool($value)) {
        return $value ? __('Yes', 'lovable-theme') : __('No', 'lovable-theme');
    }

    if (!is_scalar($value) && $value !== null) {
        return null;
    }

    $sanitized = sanitize_textarea_field((string) $value);
    return $sanitized === '' ? null : $sanitized;
}

function theme_normalize_submitted_fields($rawFields) {
    $fields = array();
    if (!is_array($rawFields)) {
        return $fields;
    }

    foreach ($rawFields as $key => $value) {
        $fieldKey = theme_sanitize_form_field_key($key);
        if ($fieldKey === '') {
            $fieldKey = 'field_' . (count($fields) + 1);
        }

        $normalizedValue = theme_normalize_form_value($value);
        if ($normalizedValue === null || $normalizedValue === array()) {
            continue;
        }

        $fields[$fieldKey] = $normalizedValue;
    }

    return $fields;
}

function theme_normalize_submitted_labels($rawLabels) {
    $labels = array();
    if (!is_array($rawLabels)) {
        return $labels;
    }

    foreach ($rawLabels as $key => $value) {
        $fieldKey = theme_sanitize_form_field_key($key);
        $label = sanitize_text_field((string) $value);

        if ($fieldKey === '' || $label === '') {
            continue;
        }

        $labels[$fieldKey] = $label;
    }

    return $labels;
}

function theme_extract_form_payload($params) {
    if (!is_array($params)) {
        return array();
    }

    if (!array_key_exists('payload', $params)) {
        return $params;
    }

    $payload = $params['payload'];
    if (is_array($payload)) {
        return $payload;
    }

    if (!is_string($payload) || trim($payload) === '') {
        return array();
    }

    if (strlen($payload) > 250000) {
        return array();
    }

    $decoded = json_decode(wp_unslash($payload), true);
    return is_array($decoded) ? $decoded : array();
}

function theme_format_form_value_for_display($value) {
    if (is_array($value)) {
        return implode(', ', array_map('theme_format_form_value_for_display', $value));
    }

    return (string) $value;
}

function theme_get_form_field_label($fieldKey, $labels = array()) {
    if (isset($labels[$fieldKey]) && $labels[$fieldKey] !== '') {
        return (string) $labels[$fieldKey];
    }

    return ucwords(str_replace('_', ' ', (string) $fieldKey));
}

function theme_calculate_form_content_length($value) {
    if (is_array($value)) {
        $totalLength = 0;
        foreach ($value as $item) {
            $totalLength += theme_calculate_form_content_length($item);
        }
        return $totalLength;
    }

    if (!is_scalar($value) && $value !== null) {
        return 0;
    }

    $stringValue = (string) $value;
    return function_exists('mb_strlen') ? mb_strlen($stringValue) : strlen($stringValue);
}

function theme_validate_form_submission($fields, $fieldLabels, $fileCount) {
    $limits = theme_get_form_limits();

    if (count($fields) > (int) $limits['max_fields']) {
        return new WP_Error(
            'lovable_theme_form_too_large',
            __('This form contains too many fields to process safely.', 'lovable-theme'),
            array('status' => 400)
        );
    }

    if (count($fieldLabels) > (int) $limits['max_labels']) {
        return new WP_Error(
            'lovable_theme_form_too_large',
            __('This form contains too many labels to process safely.', 'lovable-theme'),
            array('status' => 400)
        );
    }

    if ((int) $fileCount > (int) $limits['max_files']) {
        return new WP_Error(
            'lovable_theme_too_many_files',
            sprintf(
                __('Please upload no more than %d files at a time.', 'lovable-theme'),
                (int) $limits['max_files']
            ),
            array('status' => 400)
        );
    }

    $totalCharacters = 0;
    foreach ($fields as $value) {
        $totalCharacters += theme_calculate_form_content_length($value);
    }

    foreach ($fieldLabels as $value) {
        $totalCharacters += theme_calculate_form_content_length($value);
    }

    if ($totalCharacters > (int) $limits['max_total_characters']) {
        return new WP_Error(
            'lovable_theme_form_too_large',
            __('This form submission is too large to process safely.', 'lovable-theme'),
            array('status' => 400)
        );
    }

    return true;
}

function theme_collect_uploaded_files($fileParams) {
    $files = array();
    if (!is_array($fileParams)) {
        return $files;
    }

    foreach ($fileParams as $rawKey => $file) {
        if (!is_array($file) || !preg_match('/^wp_file__(.+)__\\d+$/', (string) $rawKey, $matches)) {
            continue;
        }

        $fieldKey = theme_sanitize_form_field_key($matches[1]);
        if ($fieldKey === '') {
            $fieldKey = 'attachment';
        }

        $errorCode = isset($file['error']) ? (int) $file['error'] : UPLOAD_ERR_NO_FILE;
        $tmpName = isset($file['tmp_name']) ? (string) $file['tmp_name'] : '';

        if ($errorCode !== UPLOAD_ERR_OK || $tmpName === '') {
            continue;
        }

        if (!is_uploaded_file($tmpName)) {
            continue;
        }

        $files[] = array(
            'fieldKey' => $fieldKey,
            'file' => $file,
        );
    }

    return $files;
}

function theme_store_uploaded_file($file, $fieldKey) {
    if (!function_exists('wp_handle_upload')) {
        require_once ABSPATH . 'wp-admin/includes/file.php';
    }

    $limits = theme_get_form_limits();
    $allowedExtensions = theme_get_form_upload_allowed_extensions();
    $allowedMimes = theme_get_form_upload_allowed_mimes();
    $fileName = isset($file['name']) ? sanitize_file_name((string) $file['name']) : '';
    $tmpName = isset($file['tmp_name']) ? (string) $file['tmp_name'] : '';
    $fileSize = isset($file['size']) ? (int) $file['size'] : 0;

    if ($tmpName === '' || !is_uploaded_file($tmpName)) {
        return array(
            'fieldKey' => $fieldKey,
            'name' => $fileName,
            'error' => __('WordPress could not verify this uploaded file.', 'lovable-theme'),
        );
    }

    if ($fileSize <= 0) {
        return array(
            'fieldKey' => $fieldKey,
            'name' => $fileName,
            'error' => __('Uploaded files must not be empty.', 'lovable-theme'),
        );
    }

    if ($fileSize > (int) $limits['max_file_size']) {
        return array(
            'fieldKey' => $fieldKey,
            'name' => $fileName,
            'error' => sprintf(
                __('Uploaded files must be smaller than %d MB.', 'lovable-theme'),
                (int) floor(((int) $limits['max_file_size']) / (1024 * 1024))
            ),
        );
    }

    $checkedFile = wp_check_filetype_and_ext($tmpName, $fileName, $allowedMimes);
    $extension = isset($checkedFile['ext']) ? strtolower((string) $checkedFile['ext']) : '';
    if ($extension === '' || !in_array($extension, $allowedExtensions, true)) {
        return array(
            'fieldKey' => $fieldKey,
            'name' => $fileName,
            'error' => __('This uploaded file type is not allowed.', 'lovable-theme'),
        );
    }

    $stored = wp_handle_upload($file, array(
        'test_form' => false,
        'test_type' => true,
        'mimes' => $allowedMimes,
    ));
    if (!is_array($stored) || isset($stored['error'])) {
        return array(
            'fieldKey' => $fieldKey,
            'name' => $fileName,
            'error' => isset($stored['error']) ? sanitize_text_field((string) $stored['error']) : __('WordPress could not store this uploaded file.', 'lovable-theme'),
        );
    }

    return array(
        'fieldKey' => $fieldKey,
        'name' => isset($file['name']) ? sanitize_file_name((string) $file['name']) : basename((string) $stored['file']),
        'path' => isset($stored['file']) ? (string) $stored['file'] : '',
        'url' => isset($stored['url']) ? esc_url_raw((string) $stored['url']) : '',
        'type' => isset($stored['type']) ? sanitize_mime_type((string) $stored['type']) : '',
        'error' => '',
    );
}

function theme_send_form_notification($recipient, $subject, $message, $headers = array(), $attachments = array()) {
    $result = array(
        'sent' => false,
        'error' => '',
    );

    $failureHandler = function ($wpError) use (&$result) {
        if ($wpError instanceof WP_Error) {
            $result['error'] = $wpError->get_error_message();
        }
    };

    add_action('wp_mail_failed', $failureHandler);
    $result['sent'] = (bool) wp_mail($recipient, $subject, $message, $headers, $attachments);
    remove_action('wp_mail_failed', $failureHandler);

    if (!$result['sent'] && $result['error'] === '') {
        $result['error'] = __('WordPress could not send the notification email. Check your mail settings or SMTP configuration.', 'lovable-theme');
    }

    return $result;
}

function theme_handle_form_submit($request) {
    $params = $request instanceof WP_REST_Request ? $request->get_json_params() : array();
    if (!is_array($params) || empty($params)) {
        $params = $request instanceof WP_REST_Request ? $request->get_params() : array();
    }

    theme_increment_form_rate_limit();

    $payload = theme_extract_form_payload($params);
    $rawFields = isset($payload['fields']) && is_array($payload['fields'])
        ? $payload['fields']
        : (isset($params['fields']) && is_array($params['fields']) ? $params['fields'] : array());
    $fieldLabels = theme_normalize_submitted_labels(isset($payload['labels']) && is_array($payload['labels']) ? $payload['labels'] : array());
    $route = isset($payload['route']) ? sanitize_text_field((string) $payload['route']) : (isset($params['route']) ? sanitize_text_field((string) $params['route']) : '');
    $pageUrl = isset($payload['page']) ? esc_url_raw((string) $payload['page']) : (isset($params['page']) ? esc_url_raw((string) $params['page']) : '');
    $formId = isset($payload['formId']) ? theme_sanitize_form_field_key($payload['formId']) : (isset($params['formId']) ? theme_sanitize_form_field_key($params['formId']) : '');
    $formName = isset($payload['formName']) ? sanitize_text_field((string) $payload['formName']) : (isset($params['formName']) ? sanitize_text_field((string) $params['formName']) : '');
    $fields = theme_normalize_submitted_fields($rawFields);

    $collectedUploads = $request instanceof WP_REST_Request
        ? theme_collect_uploaded_files($request->get_file_params())
        : array();
    $submissionValidation = theme_validate_form_submission($fields, $fieldLabels, count($collectedUploads));
    if (is_wp_error($submissionValidation)) {
        $status = $submissionValidation->get_error_data('lovable_theme_form_too_large');
        if (!is_array($status)) {
            $status = $submissionValidation->get_error_data('lovable_theme_too_many_files');
        }
        $statusCode = is_array($status) && isset($status['status']) ? (int) $status['status'] : 400;

        return new WP_REST_Response(array(
            'success' => false,
            'message' => $submissionValidation->get_error_message(),
        ), $statusCode);
    }

    $storedFiles = array();
    $attachmentPaths = array();
    $uploadErrors = array();

    foreach ($collectedUploads as $uploadEntry) {
        $storedFile = theme_store_uploaded_file($uploadEntry['file'], $uploadEntry['fieldKey']);

        if (!empty($storedFile['error'])) {
            $uploadErrors[] = $storedFile['error'];
            continue;
        }

        $storedFiles[] = $storedFile;

        if (!empty($storedFile['path'])) {
            $attachmentPaths[] = $storedFile['path'];
        }
    }

    if (empty($fields) && empty($storedFiles)) {
        return new WP_REST_Response(array(
            'success' => false,
            'message' => __('No form fields or files were submitted.', 'lovable-theme'),
        ), 400);
    }

    $titleSource = '';

    foreach (array('name', 'full_name', 'first_name', 'email', 'subject') as $candidate) {
        if (!empty($fields[$candidate])) {
            $titleSource = theme_format_form_value_for_display($fields[$candidate]);
            break;
        }
    }

    if ($titleSource === '' && !empty($fields['first_name']) && !empty($fields['last_name'])) {
        $titleSource = trim(
            theme_format_form_value_for_display($fields['first_name']) . ' ' .
            theme_format_form_value_for_display($fields['last_name'])
        );
    }

    if ($titleSource === '' && $formName !== '') {
        $titleSource = $formName;
    }

    $entryTitle = $titleSource !== ''
        ? sprintf(__('Submission from %s', 'lovable-theme'), $titleSource)
        : sprintf(__('Form Submission %s', 'lovable-theme'), current_time('mysql'));

    $contentLines = array(
        sprintf(__('Route: %s', 'lovable-theme'), $route !== '' ? $route : '/'),
    );

    if ($formName !== '') {
        $contentLines[] = sprintf(__('Form: %s', 'lovable-theme'), $formName);
    } elseif ($formId !== '') {
        $contentLines[] = sprintf(__('Form ID: %s', 'lovable-theme'), $formId);
    }

    if ($pageUrl !== '') {
        $contentLines[] = sprintf(__('Page URL: %s', 'lovable-theme'), $pageUrl);
    }

    $contentLines[] = '';

    foreach ($fields as $fieldKey => $value) {
        $contentLines[] = sprintf(
            '%s: %s',
            theme_get_form_field_label($fieldKey, $fieldLabels),
            theme_format_form_value_for_display($value)
        );
    }

    if (!empty($storedFiles)) {
        $contentLines[] = '';
        $contentLines[] = __('Uploaded files:', 'lovable-theme');

        foreach ($storedFiles as $storedFile) {
            $contentLines[] = sprintf(
                '%s: %s%s',
                theme_get_form_field_label($storedFile['fieldKey'], $fieldLabels),
                $storedFile['name'],
                !empty($storedFile['url']) ? sprintf(' (%s)', $storedFile['url']) : ''
            );
        }
    }

    if (!empty($uploadErrors)) {
        $contentLines[] = '';
        $contentLines[] = __('Upload warnings:', 'lovable-theme');
        foreach ($uploadErrors as $uploadError) {
            $contentLines[] = sprintf('- %s', $uploadError);
        }
    }

    $postId = wp_insert_post(array(
        'post_type' => 'lovable_form_entry',
        'post_status' => 'publish',
        'post_title' => $entryTitle,
        'post_content' => implode("\\n", $contentLines),
    ));

    if (is_wp_error($postId) || !$postId) {
        return new WP_REST_Response(array(
            'success' => false,
            'message' => __('WordPress could not save this submission.', 'lovable-theme'),
        ), 500);
    }

    update_post_meta($postId, '_lovable_route', $route);
    update_post_meta($postId, '_lovable_page_url', $pageUrl);
    update_post_meta($postId, '_lovable_fields', $fields);
    update_post_meta($postId, '_lovable_field_labels', $fieldLabels);
    update_post_meta($postId, '_lovable_form_id', $formId);
    update_post_meta($postId, '_lovable_form_name', $formName);
    update_post_meta($postId, '_lovable_uploaded_files', $storedFiles);
    update_post_meta($postId, '_lovable_upload_warnings', $uploadErrors);

    foreach ($fields as $fieldKey => $value) {
        update_post_meta($postId, 'field_' . $fieldKey, theme_format_form_value_for_display($value));
    }

    $emailLines = array(
        sprintf(__('Site: %s', 'lovable-theme'), wp_specialchars_decode(get_bloginfo('name'), ENT_QUOTES)),
        sprintf(__('Route: %s', 'lovable-theme'), $route !== '' ? $route : '/'),
    );

    if ($formName !== '') {
        $emailLines[] = sprintf(__('Form: %s', 'lovable-theme'), $formName);
    } elseif ($formId !== '') {
        $emailLines[] = sprintf(__('Form ID: %s', 'lovable-theme'), $formId);
    }

    if ($pageUrl !== '') {
        $emailLines[] = sprintf(__('Page URL: %s', 'lovable-theme'), $pageUrl);
    }

    $emailLines[] = '';
    $emailLines[] = __('Submitted fields:', 'lovable-theme');

    foreach ($fields as $fieldKey => $value) {
        $emailLines[] = sprintf(
            '%s: %s',
            theme_get_form_field_label($fieldKey, $fieldLabels),
            theme_format_form_value_for_display($value)
        );
    }

    if (!empty($storedFiles)) {
        $emailLines[] = '';
        $emailLines[] = __('Uploaded files:', 'lovable-theme');

        foreach ($storedFiles as $storedFile) {
            $emailLines[] = sprintf(
                '%s: %s%s',
                theme_get_form_field_label($storedFile['fieldKey'], $fieldLabels),
                $storedFile['name'],
                !empty($storedFile['url']) ? sprintf(' (%s)', $storedFile['url']) : ''
            );
        }
    }

    if (!empty($uploadErrors)) {
        $emailLines[] = '';
        $emailLines[] = __('Upload warnings:', 'lovable-theme');
        foreach ($uploadErrors as $uploadError) {
            $emailLines[] = sprintf('- %s', $uploadError);
        }
    }

    $recipient = sanitize_email((string) get_option('admin_email'));
    $subjectSuffix = $formName !== ''
        ? sprintf(__(' - %s', 'lovable-theme'), $formName)
        : ($formId !== '' ? sprintf(__(' - %s', 'lovable-theme'), $formId) : '');

    $headers = array('Content-Type: text/plain; charset=UTF-8');
    if (!empty($fields['email']) && is_email(theme_format_form_value_for_display($fields['email']))) {
        $replyToName = $titleSource !== '' ? $titleSource : __('Website Visitor', 'lovable-theme');
        $headers[] = sprintf('Reply-To: %s <%s>', $replyToName, theme_format_form_value_for_display($fields['email']));
    }

    $mailResult = array(
        'sent' => false,
        'error' => __('Notification email was skipped because the WordPress admin email is not configured.', 'lovable-theme'),
    );

    if ($recipient !== '') {
        $mailResult = theme_send_form_notification(
            $recipient,
            sprintf(
                __('[%s] New form submission%s', 'lovable-theme'),
                wp_specialchars_decode(get_bloginfo('name'), ENT_QUOTES),
                $subjectSuffix
            ),
            implode("\\n", $emailLines),
            $headers,
            $attachmentPaths
        );
    }

    update_post_meta($postId, '_lovable_mail_sent', !empty($mailResult['sent']) ? '1' : '0');
    update_post_meta($postId, '_lovable_mail_error', isset($mailResult['error']) ? (string) $mailResult['error'] : '');

    $responseMessage = __('Thanks! Your message was sent.', 'lovable-theme');
    $responseWarnings = array();

    if (!empty($uploadErrors)) {
        $responseWarnings = array_merge($responseWarnings, $uploadErrors);
    }

    if (empty($mailResult['sent'])) {
        $responseWarnings[] = isset($mailResult['error']) && $mailResult['error'] !== ''
            ? (string) $mailResult['error']
            : __('WordPress could not send the notification email.', 'lovable-theme');
        $responseMessage = __('Your message was saved in WordPress, but the notification email could not be sent.', 'lovable-theme');
    } elseif (!empty($uploadErrors)) {
        $responseMessage = __('Your message was sent, but some uploaded files need attention.', 'lovable-theme');
    }

    return new WP_REST_Response(array(
        'success' => true,
        'stored' => true,
        'mailSent' => !empty($mailResult['sent']),
        'entryId' => (int) $postId,
        'message' => $responseMessage,
        'warnings' => $responseWarnings,
    ), 200);
}

function theme_register_form_rest_routes() {
    register_rest_route('lovable-theme/v1', '/form-submit', array(
        'methods' => WP_REST_Server::CREATABLE,
        'callback' => 'theme_handle_form_submit',
        'permission_callback' => 'theme_can_submit_public_form',
    ));
}
add_action('rest_api_init', 'theme_register_form_rest_routes');

function theme_enqueue_assets() {
${assetEnqueue}
}
add_action('wp_enqueue_scripts', 'theme_enqueue_assets');

function theme_create_route_pages() {
    $pages = array(
${pageCreationEntries}
    );

    foreach ($pages as $slug => $title) {
        if (!get_page_by_path($slug, OBJECT, 'page')) {
            wp_insert_post(array(
                'post_title' => $title,
                'post_name' => $slug,
                'post_status' => 'publish',
                'post_type' => 'page',
            ));
        }
    }
}
add_action('after_switch_theme', 'theme_create_route_pages');

function theme_setup() {
    add_theme_support('title-tag');
    add_theme_support('post-thumbnails');
    register_nav_menus(array(
        'primary' => __('Primary Menu', 'lovable-theme'),
    ));
}
add_action('after_setup_theme', 'theme_setup');
?>`;
}

function createThemeInteractionsJs() {
  return `(function () {
  const MOBILE_BREAKPOINT = 768;
  const CLOSE_ICON = '<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="lucide lucide-x w-6 h-6"><path d="M18 6 6 18"></path><path d="m6 6 12 12"></path></svg>';

  function ready(callback) {
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', callback, { once: true });
      return;
    }

    callback();
  }

  function classTokens(value) {
    return String(value || '')
      .split(/\\s+/)
      .map(function (token) { return token.trim(); })
      .filter(Boolean);
  }

  function hasClassToken(element, token) {
    return classTokens(element && element.getAttribute('class')).includes(token);
  }

  function isLikelyMenuButton(button) {
    if (!button) return false;

    const ariaLabel = button.getAttribute('aria-label') || '';
    if (/menu|toggle/i.test(ariaLabel)) {
      return true;
    }

    if (classTokens(button.getAttribute('class')).some(function (token) { return /menu/i.test(token); })) {
      return true;
    }

    return Array.from(button.querySelectorAll('svg')).some(function (svg) {
      return /lucide-(menu|x)/i.test(svg.getAttribute('class') || '');
    });
  }

  function scoreNav(nav) {
    if (!nav) return -1;

    const links = nav.querySelectorAll('a[href]').length;
    if (links < 2) return -1;

    const className = nav.getAttribute('class') || '';
    let score = links;

    if (hasClassToken(nav, 'hidden')) score += 2;
    if (classTokens(className).some(function (token) { return /^md:flex$|^lg:flex$/.test(token); })) score += 3;
    if (classTokens(className).some(function (token) { return /^md:hidden$|^lg:hidden$/.test(token); })) score -= 3;

    return score;
  }

  function findSourceNav(root) {
    const annotated = root.querySelector('[data-wp-mobile-source-nav="true"]');
    if (annotated) {
      return annotated;
    }

    return Array.from(root.querySelectorAll('nav'))
      .map(function (nav) { return { nav: nav, score: scoreNav(nav) }; })
      .sort(function (left, right) { return right.score - left.score; })
      .map(function (entry) { return entry.score >= 0 ? entry.nav : null; })
      .find(Boolean) || null;
  }

  function scoreActionGroup(element) {
    if (!element || element.querySelector('nav')) return -1;

    const buttons = element.querySelectorAll('button').length;
    const links = element.querySelectorAll('a[href]').length;
    const phoneLinks = element.querySelectorAll('a[href^="tel:"]').length;

    if (buttons === 0 && phoneLinks === 0) return -1;

    let score = (buttons * 3) + (phoneLinks * 2) + Math.min(links, 2);
    const className = element.getAttribute('class') || '';

    if (hasClassToken(element, 'hidden')) score += 1;
    if (classTokens(className).some(function (token) { return /^md:flex$|^lg:flex$/.test(token); })) score += 2;

    return score;
  }

  function findActionGroup(root, nav) {
    const annotated = root.querySelector('[data-wp-mobile-source-actions="true"]');
    if (annotated) {
      return annotated;
    }

    return Array.from(root.querySelectorAll('div, section, aside'))
      .filter(function (element) { return element !== nav; })
      .map(function (element) { return { element: element, score: scoreActionGroup(element) }; })
      .sort(function (left, right) { return right.score - left.score; })
      .map(function (entry) { return entry.score >= 0 ? entry.element : null; })
      .find(Boolean) || null;
  }

  function cleanupClone(root) {
    root.querySelectorAll('[id]').forEach(function (element) {
      element.removeAttribute('id');
    });

    root.querySelectorAll('[data-wp-mobile-source-nav],[data-wp-mobile-source-actions]').forEach(function (element) {
      element.removeAttribute('data-wp-mobile-source-nav');
      element.removeAttribute('data-wp-mobile-source-actions');
    });
  }

  function buildMobilePanel(root, nav, actionGroup) {
    const panel = document.createElement('div');
    panel.setAttribute('data-wp-mobile-menu-panel', 'true');
    panel.setAttribute('class', 'md:hidden bg-card border-t border-border');
    panel.hidden = true;
    panel.style.display = 'none';

    const navClone = nav.cloneNode(true);
    cleanupClone(navClone);
    navClone.setAttribute('class', 'flex flex-col px-4 py-4 gap-2');
    navClone.querySelectorAll('a').forEach(function (link) {
      link.classList.add('block', 'py-3', 'px-2');
    });
    panel.appendChild(navClone);

    if (actionGroup) {
      const actionClone = actionGroup.cloneNode(true);
      cleanupClone(actionClone);
      actionClone.setAttribute('class', 'flex flex-col gap-3 px-4 pb-4 pt-2 border-t border-border');

      actionClone.querySelectorAll('a').forEach(function (link) {
        if (link.querySelector('button')) {
          link.classList.add('w-full');
        }
      });

      actionClone.querySelectorAll('button').forEach(function (button) {
        button.classList.add('w-full');
      });

      panel.appendChild(actionClone);
    }

    root.appendChild(panel);
    return panel;
  }

  function setButtonState(button, isOpen) {
    if (!button.dataset.wpMobileClosedIcon) {
      button.dataset.wpMobileClosedIcon = button.innerHTML;
    }

    button.setAttribute('aria-expanded', isOpen ? 'true' : 'false');
    button.setAttribute('aria-label', isOpen ? 'Close menu' : 'Toggle menu');

    if (isOpen) {
      button.innerHTML = CLOSE_ICON;
      return;
    }

    button.innerHTML = button.dataset.wpMobileClosedIcon;
  }

  ready(function () {
    const roots = Array.from(document.querySelectorAll('[data-wp-mobile-header="true"]'));

    roots.forEach(function (root) {
      const button = root.querySelector('[data-wp-mobile-toggle="true"]') ||
        Array.from(root.querySelectorAll('button')).find(isLikelyMenuButton);
      const nav = findSourceNav(root);

      if (!button || !nav) {
        return;
      }

      const actionGroup = findActionGroup(root, nav);
      const panel = root.querySelector('[data-wp-mobile-menu-panel="true"]') || buildMobilePanel(root, nav, actionGroup);

      function isOpen() {
        return root.getAttribute('data-wp-mobile-open') === 'true';
      }

      function setOpen(nextOpen) {
        root.setAttribute('data-wp-mobile-open', nextOpen ? 'true' : 'false');
        panel.hidden = !nextOpen;
        panel.style.display = nextOpen ? '' : 'none';
        setButtonState(button, nextOpen);
      }

      setOpen(false);

      button.addEventListener('click', function (event) {
        event.preventDefault();
        event.stopPropagation();
        setOpen(!isOpen());
      });

      panel.addEventListener('click', function (event) {
        if (event.target && event.target.closest('a, button')) {
          setOpen(false);
        }
      });

      document.addEventListener('click', function (event) {
        if (isOpen() && !root.contains(event.target)) {
          setOpen(false);
        }
      });

      document.addEventListener('keydown', function (event) {
        if (event.key === 'Escape' && isOpen()) {
          setOpen(false);
        }
      });

      window.addEventListener('resize', function () {
        if (window.innerWidth >= MOBILE_BREAKPOINT && isOpen()) {
          setOpen(false);
        }
      });
    });
  });
})();`;
}

function createThemeBridgeJs() {
  return `(function () {
  var ROOT_SELECTOR = '#root';
  var observer = null;
  var applyQueued = false;
  var isApplying = false;
  var formListenerBound = false;
  var routeListenerBound = false;

  function ready(callback) {
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', callback, { once: true });
      return;
    }

    callback();
  }

  function getConfig() {
    return window.__LOVABLE_WP_THEME__ || {};
  }

  function normalizePath(value) {
    var pathValue = String(value || '/')
      .split('#')[0]
      .split('?')[0]
      .trim();

    if (!pathValue) {
      return '/';
    }

    if (/^https?:\\/\\//i.test(pathValue)) {
      try {
        pathValue = new URL(pathValue, window.location.href).pathname || '/';
      } catch (error) {
        pathValue = '/';
      }
    }

    if (pathValue.charAt(0) !== '/') {
      pathValue = '/' + pathValue;
    }

    pathValue = pathValue.replace(/\\/+/g, '/');

    if (pathValue !== '/' && !/\\/$/.test(pathValue)) {
      pathValue += '/';
    }

    return pathValue;
  }

  function trimTrailingSlash(value) {
    var normalized = normalizePath(value);
    return normalized === '/' ? '/' : normalized.replace(/\\/+$/, '');
  }

  function getCurrentRouteKey() {
    var config = getConfig();
    var basename = trimTrailingSlash(config.basename || '/');
    var pathname = normalizePath(window.location.pathname || '/');
    var root = getRoot();
    var rootRoute = root && root.getAttribute('data-wp-route')
      ? normalizePath(root.getAttribute('data-wp-route'))
      : '';

    if (basename !== '/' && pathname === basename) {
      pathname = '/';
    } else if (basename !== '/' && pathname.indexOf(basename + '/') === 0) {
      pathname = pathname.slice(basename.length) || '/';
    }

    if (rootRoute && rootRoute !== '/' && pathname === '/') {
      return rootRoute;
    }

    return normalizePath(pathname);
  }

  function getRouteOverrides() {
    var allOverrides = getConfig().contentOverrides || {};
    var routeKey = getCurrentRouteKey();
    var alternateKey = routeKey === '/' ? '/' : routeKey.replace(/\\/$/, '');

    return allOverrides[routeKey] || allOverrides[alternateKey] || [];
  }

  function getRoot() {
    return document.querySelector(ROOT_SELECTOR);
  }

  function applySingleOverride(root, entry) {
    if (!root || !entry || (!entry.selector && !entry.fieldId)) {
      return;
    }

    var nodes = [];

    if (entry.fieldId) {
      try {
        nodes = root.querySelectorAll('[data-wp-field-id="' + escapeSelectorValue(entry.fieldId) + '"]');
      } catch (error) {
        nodes = [];
      }
    }

    var queryRoot = root;
    if (entry.scope) {
      try {
        queryRoot = root.querySelector(entry.scope) || root;
      } catch (error) {
        queryRoot = root;
      }
    }

    if (!nodes.length && entry.selector) {
      try {
        nodes = queryRoot.querySelectorAll(entry.selector);
      } catch (error) {
        return;
      }
    }

    Array.from(nodes).forEach(function (node) {
      if (entry.type === 'image' || entry.attribute) {
        var attributeName = entry.attribute || 'src';
        if (node.getAttribute(attributeName) !== entry.value) {
          node.setAttribute(attributeName, entry.value);
        }

        if (attributeName in node && node[attributeName] !== entry.value) {
          try {
            node[attributeName] = entry.value;
          } catch (error) {
            // Ignore read-only DOM properties.
          }
        }

        return;
      }

      if (node.textContent !== entry.value) {
        node.textContent = entry.value;
      }
    });
  }

  function applyContentOverrides() {
    var root = getRoot();
    var overrides = getRouteOverrides();

    if (!root || !overrides.length) {
      return;
    }

    isApplying = true;
    try {
      overrides.forEach(function (entry) {
        applySingleOverride(root, entry);
      });
    } finally {
      isApplying = false;
    }
  }

  function scheduleApply() {
    if (applyQueued) {
      return;
    }

    applyQueued = true;
    window.requestAnimationFrame(function () {
      applyQueued = false;
      applyContentOverrides();
    });
  }

  function scheduleRouteAwareApply() {
    scheduleApply();
    window.setTimeout(scheduleApply, 0);
    window.setTimeout(scheduleApply, 50);
    window.setTimeout(scheduleApply, 180);
    window.setTimeout(scheduleApply, 400);
  }

  function observeRoot() {
    var root = getRoot();
    if (!root) {
      return;
    }

    if (observer) {
      observer.disconnect();
    }

    observer = new MutationObserver(function () {
      if (!isApplying) {
        scheduleApply();
      }
    });

    observer.observe(root, {
      childList: true,
      subtree: true,
      characterData: true,
      attributes: true,
    });

    scheduleRouteAwareApply();
  }

  function bindRouteListeners() {
    if (routeListenerBound) {
      return;
    }

    var originalPushState = window.history && window.history.pushState;
    var originalReplaceState = window.history && window.history.replaceState;

    if (typeof originalPushState === 'function') {
      window.history.pushState = function () {
        var result = originalPushState.apply(this, arguments);
        scheduleRouteAwareApply();
        return result;
      };
    }

    if (typeof originalReplaceState === 'function') {
      window.history.replaceState = function () {
        var result = originalReplaceState.apply(this, arguments);
        scheduleRouteAwareApply();
        return result;
      };
    }

    window.addEventListener('popstate', scheduleRouteAwareApply);
    window.addEventListener('hashchange', scheduleRouteAwareApply);
    routeListenerBound = true;
  }

  function sanitizeKey(value) {
    return String(value || '')
      .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
      .toLowerCase()
      .replace(/&/g, ' and ')
      .replace(/[^a-z0-9]+/g, '_')
      .replace(/^_+|_+$/g, '');
  }

  function escapeSelectorValue(value) {
    if (window.CSS && typeof window.CSS.escape === 'function') {
      return window.CSS.escape(value);
    }

    return String(value || '').replace(/["\\\\]/g, '\\\\$&');
  }

  function getLabelText(control) {
    if (!control) {
      return '';
    }

    function extractLabelText(labelNode) {
      if (!labelNode) {
        return '';
      }

      var clone = labelNode.cloneNode(true);
      Array.from(clone.querySelectorAll('input, select, textarea, button')).forEach(function (field) {
        field.remove();
      });

      return (clone.textContent || '').replace(/\\s+/g, ' ').trim();
    }

    if (control.labels && control.labels.length) {
      return Array.from(control.labels)
        .map(function (label) { return extractLabelText(label); })
        .find(Boolean) || '';
    }

    if (control.id) {
      var explicitLabel = document.querySelector('label[for="' + escapeSelectorValue(control.id) + '"]');
      if (explicitLabel) {
        return extractLabelText(explicitLabel);
      }
    }

    var parentLabel = control.closest('label');
    if (parentLabel) {
      return extractLabelText(parentLabel);
    }

    var previousLabel = control.previousElementSibling;
    if (previousLabel && previousLabel.tagName === 'LABEL') {
      return extractLabelText(previousLabel);
    }

    return '';
  }

  function formatFieldLabel(fieldKey) {
    return String(fieldKey || '')
      .replace(/[_-]+/g, ' ')
      .replace(/\\s+/g, ' ')
      .trim()
      .replace(/\\b\\w/g, function (character) { return character.toUpperCase(); });
  }

  function normalizeFieldCandidate(candidate) {
    var normalized = sanitizeKey(candidate);
    if (!normalized) {
      return '';
    }

    if (/first_?name|given_?name/.test(normalized)) return 'first_name';
    if (/last_?name|sur_?name|family_?name/.test(normalized)) return 'last_name';
    if (/full_?name|your_?name|contact_?name|^name$/.test(normalized)) return 'name';
    if (/e_?mail|email_?address|^email$/.test(normalized)) return 'email';
    if (/phone|mobile|telephone|cell/.test(normalized)) return 'phone';
    if (/service|interest|project_?type|request_?type/.test(normalized)) return 'service';
    if (/message|details|project_?details|comment|description|notes/.test(normalized)) return 'message';
    if (/subject/.test(normalized)) return 'subject';
    if (/company|business/.test(normalized)) return 'company';
    if (/address|location/.test(normalized)) return 'address';

    if (!/^(field|input|select|textarea|option|text|value)$/.test(normalized)) {
      return normalized;
    }

    return '';
  }

  function getHumanFieldLabel(control, fallbackKey) {
    var controlType = control && control.getAttribute ? (control.getAttribute('type') || '').toLowerCase() : '';
    var candidates = controlType === 'hidden'
      ? [
        control && control.getAttribute ? control.getAttribute('data-label') : '',
        control && control.getAttribute ? control.getAttribute('aria-label') : '',
        control && control.getAttribute ? control.getAttribute('name') : '',
        control && control.id ? control.id : '',
        fallbackKey ? formatFieldLabel(fallbackKey) : ''
      ].filter(Boolean)
      : [
        getLabelText(control),
        control && control.getAttribute ? control.getAttribute('aria-label') : '',
        control && control.getAttribute ? control.getAttribute('placeholder') : '',
        control && control.getAttribute ? control.getAttribute('name') : '',
        control && control.id ? control.id : '',
        fallbackKey ? formatFieldLabel(fallbackKey) : ''
      ].filter(Boolean);

    for (var i = 0; i < candidates.length; i += 1) {
      var candidate = String(candidates[i] || '').replace(/\\s+/g, ' ').trim();
      if (candidate) {
        return candidate;
      }
    }

    return fallbackKey ? formatFieldLabel(fallbackKey) : 'Field';
  }

  function inferCanonicalFieldName(control, index) {
    var rawCandidates = [
      control.getAttribute('name'),
      control.id,
      getLabelText(control),
      control.getAttribute('aria-label'),
      control.getAttribute('placeholder'),
      control.getAttribute('data-label'),
    ].filter(Boolean);

    for (var i = 0; i < rawCandidates.length; i += 1) {
      var normalized = normalizeFieldCandidate(rawCandidates[i]);
      if (normalized) {
        return normalized;
      }
    }

    var controlType = sanitizeKey(control.getAttribute('type') || control.tagName || 'field') || 'field';
    return 'field_' + index + '_' + controlType;
  }

  function isCollectibleControl(control) {
    if (!control || control.disabled) {
      return false;
    }

    var tagName = (control.tagName || '').toUpperCase();
    var type = (control.getAttribute('type') || '').toLowerCase();

    if (tagName === 'BUTTON') {
      return false;
    }

    if (tagName !== 'INPUT' && tagName !== 'SELECT' && tagName !== 'TEXTAREA') {
      return false;
    }

    if (type === 'submit' || type === 'button' || type === 'reset' || type === 'image') {
      return false;
    }

    return true;
  }

  function isResettableControl(control) {
    if (!isCollectibleControl(control)) {
      return false;
    }

    var type = (control.getAttribute('type') || '').toLowerCase();
    if (type === 'hidden') {
      return false;
    }

    return true;
  }

  function getControlValue(control) {
    var tagName = (control.tagName || '').toUpperCase();
    var type = (control.getAttribute('type') || '').toLowerCase();

    if (type === 'checkbox') {
      if (!control.checked) {
        return null;
      }

      return control.value && control.value !== 'on'
        ? control.value
        : (getLabelText(control) || 'yes');
    }

    if (type === 'radio') {
      return control.checked ? control.value : null;
    }

    if (tagName === 'SELECT' && control.multiple) {
      return Array.from(control.selectedOptions || [])
        .map(function (option) { return option.value || option.textContent || ''; })
        .filter(Boolean);
    }

    if (type === 'file') {
      return null;
    }

    return String(control.value || '').trim();
  }

  function getControlFiles(control) {
    if (!control || (control.getAttribute('type') || '').toLowerCase() !== 'file') {
      return [];
    }

    return Array.from(control.files || []).filter(function (file) {
      return file && file.name;
    });
  }

  function appendCollectedValue(target, key, value) {
    if (value === null || value === '') {
      return;
    }

    if (Array.isArray(value)) {
      value.forEach(function (entry) {
        appendCollectedValue(target, key, entry);
      });
      return;
    }

    if (Object.prototype.hasOwnProperty.call(target, key)) {
      if (Array.isArray(target[key])) {
        if (target[key].indexOf(value) === -1) {
          target[key].push(value);
        }
        return;
      }

      if (target[key] !== value) {
        target[key] = [target[key], value];
      }
      return;
    }

    target[key] = value;
  }

  function appendCollectedFile(target, key, file) {
    if (!file || !file.name) {
      return;
    }

    if (!Object.prototype.hasOwnProperty.call(target, key)) {
      target[key] = [];
    }

    target[key].push(file);
  }

  function createNativeFormData(form, submitter) {
    if (typeof FormData !== 'function') {
      return null;
    }

    try {
      if (submitter) {
        return new FormData(form, submitter);
      }

      return new FormData(form);
    } catch (error) {
      try {
        var fallback = new FormData(form);
        if (submitter && submitter.name && !fallback.has(submitter.name)) {
          fallback.append(submitter.name, submitter.value || '');
        }
        return fallback;
      } catch (fallbackError) {
        return null;
      }
    }
  }

  function findNamedControl(form, name) {
    if (!form || !name) {
      return null;
    }

    try {
      return form.querySelector('[name="' + escapeSelectorValue(name) + '"]');
    } catch (error) {
      return null;
    }
  }

  function collectFormSubmission(form, submitter) {
    var fields = {};
    var labels = {};
    var files = {};
    var serializedNames = {};
    var nativeFormData = createNativeFormData(form, submitter);

    if (nativeFormData) {
      nativeFormData.forEach(function (value, rawName) {
        var fieldKey = normalizeFieldCandidate(rawName);
        if (!fieldKey) {
          return;
        }

        serializedNames[String(rawName)] = true;
        var control = findNamedControl(form, rawName);
        if (!labels[fieldKey]) {
          labels[fieldKey] = getHumanFieldLabel(control, fieldKey);
        }

        if (typeof File !== 'undefined' && value instanceof File) {
          appendCollectedFile(files, fieldKey, value);
          return;
        }

        appendCollectedValue(fields, fieldKey, String(value || '').trim());
      });
    }

    Array.from(form.elements || []).filter(isCollectibleControl).forEach(function (control, index) {
      var rawName = (control.getAttribute('name') || '').trim();
      if (rawName && serializedNames[rawName]) {
        return;
      }

      var fieldKey = inferCanonicalFieldName(control, index + 1);
      if (!fieldKey) {
        return;
      }

      if (!labels[fieldKey]) {
        labels[fieldKey] = getHumanFieldLabel(control, fieldKey);
      }

      if ((control.getAttribute('type') || '').toLowerCase() === 'file') {
        getControlFiles(control).forEach(function (file) {
          appendCollectedFile(files, fieldKey, file);
        });
        return;
      }

      appendCollectedValue(fields, fieldKey, getControlValue(control));
    });

    return {
      fields: fields,
      labels: labels,
      files: files
    };
  }

  function getNearestHeadingText(form) {
    if (!form) {
      return '';
    }

    var section = form.closest('section, article, main, aside, div');
    if (section) {
      var sectionHeading = section.querySelector('h1, h2, h3, h4, h5, h6');
      if (sectionHeading && sectionHeading.textContent) {
        return sectionHeading.textContent.replace(/\\s+/g, ' ').trim();
      }
    }

    var previousHeading = form.previousElementSibling;
    while (previousHeading) {
      if (/^H[1-6]$/.test(previousHeading.tagName || '')) {
        return (previousHeading.textContent || '').replace(/\\s+/g, ' ').trim();
      }
      previousHeading = previousHeading.previousElementSibling;
    }

    return '';
  }

  function getSubmitterText(submitter) {
    if (!submitter) {
      return '';
    }

    return String(submitter.textContent || submitter.value || '')
      .replace(/\\s+/g, ' ')
      .trim();
  }

  function inferFormMeta(form, submitter) {
    var rawName = [
      form.getAttribute('data-wp-form-name'),
      form.getAttribute('aria-label'),
      getNearestHeadingText(form),
      getSubmitterText(submitter)
    ].find(Boolean) || '';
    var rawId = [
      form.getAttribute('data-wp-form-id'),
      form.getAttribute('name'),
      form.id,
      rawName,
      getCurrentRouteKey() + '_form'
    ].find(Boolean) || 'form';

    return {
      formId: sanitizeKey(rawId) || 'form',
      formName: String(rawName || '').trim()
    };
  }

  function buildFormRequestBody(form, submission, submitter) {
    var body = new FormData();
    var formMeta = inferFormMeta(form, submitter);

    body.append('payload', JSON.stringify({
      route: getCurrentRouteKey(),
      page: window.location.href,
      formId: formMeta.formId,
      formName: formMeta.formName,
      fields: submission.fields,
      labels: submission.labels
    }));

    Object.keys(submission.files || {}).forEach(function (fieldKey) {
      var fileList = Array.isArray(submission.files[fieldKey]) ? submission.files[fieldKey] : [];
      fileList.forEach(function (file, index) {
        body.append('wp_file__' + fieldKey + '__' + index, file, file.name || (fieldKey + '-' + index));
      });
    });

    return body;
  }

  function createNativeSetter(prototype, property) {
    var descriptor = prototype && Object.getOwnPropertyDescriptor(prototype, property);
    return descriptor && typeof descriptor.set === 'function' ? descriptor.set : null;
  }

  var inputValueSetter = createNativeSetter(window.HTMLInputElement && window.HTMLInputElement.prototype, 'value');
  var inputCheckedSetter = createNativeSetter(window.HTMLInputElement && window.HTMLInputElement.prototype, 'checked');
  var textareaValueSetter = createNativeSetter(window.HTMLTextAreaElement && window.HTMLTextAreaElement.prototype, 'value');
  var selectValueSetter = createNativeSetter(window.HTMLSelectElement && window.HTMLSelectElement.prototype, 'value');

  function dispatchControlEvents(control) {
    control.dispatchEvent(new Event('input', { bubbles: true }));
    control.dispatchEvent(new Event('change', { bubbles: true }));
  }

  function setControlValue(control, value) {
    var tagName = (control.tagName || '').toUpperCase();
    var type = (control.getAttribute('type') || '').toLowerCase();

    if (type === 'file') {
      try {
        control.value = value || '';
      } catch (error) {
        // Ignore browsers that block file input mutation.
      }
      dispatchControlEvents(control);
      return;
    }

    if (type === 'checkbox' || type === 'radio') {
      if (inputCheckedSetter) {
        inputCheckedSetter.call(control, Boolean(value));
      } else {
        control.checked = Boolean(value);
      }
      dispatchControlEvents(control);
      return;
    }

    if (tagName === 'TEXTAREA') {
      if (textareaValueSetter) {
        textareaValueSetter.call(control, value);
      } else {
        control.value = value;
      }
      dispatchControlEvents(control);
      return;
    }

    if (tagName === 'SELECT') {
      if (selectValueSetter) {
        selectValueSetter.call(control, value);
      } else {
        control.value = value;
      }
      dispatchControlEvents(control);
      return;
    }

    if (inputValueSetter) {
      inputValueSetter.call(control, value);
    } else {
      control.value = value;
    }

    dispatchControlEvents(control);
  }

  function resetFormControls(form) {
    var controls = Array.from(form.elements || []).filter(isResettableControl);
    if (typeof form.reset === 'function') {
      form.reset();
    }

    controls.forEach(function (control) {
      dispatchControlEvents(control);
    });
  }

  function getStatusNode(form) {
    var existing = form.nextElementSibling;
    if (existing && existing.getAttribute('data-wp-form-status') === 'true') {
      return existing;
    }

    var status = document.createElement('div');
    status.setAttribute('data-wp-form-status', 'true');
    status.setAttribute('role', 'status');
    status.style.marginTop = '12px';
    status.style.padding = '12px 14px';
    status.style.borderRadius = '8px';
    status.style.fontSize = '14px';
    status.style.display = 'none';
    form.insertAdjacentElement('afterend', status);
    return status;
  }

  function setStatus(form, kind, message) {
    var status = getStatusNode(form);
    status.textContent = message || '';

    if (!message) {
      status.style.display = 'none';
      return;
    }

    status.style.display = 'block';

    if (kind === 'success') {
      status.style.background = '#ecfdf3';
      status.style.color = '#166534';
      status.style.border = '1px solid #86efac';
      return;
    }

    if (kind === 'error') {
      status.style.background = '#fef2f2';
      status.style.color = '#991b1b';
      status.style.border = '1px solid #fca5a5';
      return;
    }

    if (kind === 'warning') {
      status.style.background = '#fffbeb';
      status.style.color = '#92400e';
      status.style.border = '1px solid #fcd34d';
      return;
    }

    status.style.background = '#eff6ff';
    status.style.color = '#1d4ed8';
    status.style.border = '1px solid #93c5fd';
  }

  function setFormSubmitting(form, submitting) {
    form.dataset.wpBridgeSubmitting = submitting ? 'true' : 'false';

    Array.from(form.querySelectorAll('button, input[type="submit"], input[type="button"]')).forEach(function (control) {
      control.disabled = submitting;
    });
  }

  function shouldHandleForm(form) {
    if (!form || form.dataset.wpBridgeIgnore === 'true') {
      return false;
    }

    var method = (form.getAttribute('method') || '').trim().toUpperCase();
    if (method === 'GET') {
      return false;
    }

    var submitControl = form.querySelector('button[type="submit"], button:not([type]), input[type="submit"]');
    var controls = Array.from(form.elements || []).filter(isCollectibleControl);
    return Boolean(submitControl && controls.length > 0);
  }

  async function handleFormSubmit(event) {
    var form = event.target;
    var config = getConfig();
    var endpoint = config.formEndpoint;
    var requestHeaderName = config.formRequestHeader || 'X-Lovable-Theme-Form';
    var submitter = event.submitter || document.activeElement || null;

    if (!shouldHandleForm(form) || !endpoint || form.dataset.wpBridgeSubmitting === 'true') {
      return;
    }

    event.preventDefault();
    event.stopPropagation();
    if (typeof event.stopImmediatePropagation === 'function') {
      event.stopImmediatePropagation();
    }

    if (!form.hasAttribute('novalidate')) {
      if (typeof form.reportValidity === 'function' && !form.reportValidity()) {
        return;
      }

      if (typeof form.checkValidity === 'function' && !form.checkValidity()) {
        setStatus(form, 'error', 'Please complete the required fields before submitting.');
        return;
      }
    }

    var submission = collectFormSubmission(form, submitter);
    if (!Object.keys(submission.fields).length && !Object.keys(submission.files).length) {
      setStatus(form, 'error', 'Please complete the form before submitting it.');
      return;
    }

    setFormSubmitting(form, true);
    setStatus(form, 'info', 'Sending your message...');

    try {
      var response = await fetch(endpoint, {
        method: 'POST',
        headers: {
          'Accept': 'application/json',
          [requestHeaderName]: '1'
        },
        credentials: 'same-origin',
        body: buildFormRequestBody(form, submission, submitter)
      });

      var payload = {};
      try {
        payload = await response.json();
      } catch (error) {
        payload = {};
      }

      if (!response.ok || payload.success === false) {
        throw new Error(payload.message || 'WordPress could not process this form.');
      }

      resetFormControls(form);
      var statusKind = payload.mailSent === false || (Array.isArray(payload.warnings) && payload.warnings.length)
        ? 'warning'
        : 'success';
      setStatus(
        form,
        statusKind,
        payload.message || (statusKind === 'warning'
          ? 'Your submission was saved, but WordPress reported a delivery warning.'
          : 'Thanks! Your message was sent.')
      );
      window.dispatchEvent(new CustomEvent('lovable:wp-form-submitted', { detail: payload }));
    } catch (error) {
      setStatus(form, 'error', error && error.message ? error.message : 'Something went wrong while submitting the form.');
    } finally {
      setFormSubmitting(form, false);
    }
  }

  function bindFormListener() {
    if (formListenerBound) {
      return;
    }

    document.addEventListener('submit', handleFormSubmit, true);
    formListenerBound = true;
  }

  ready(function () {
    observeRoot();
    bindFormListener();
    bindRouteListeners();
    scheduleRouteAwareApply();
    window.addEventListener('pageshow', scheduleRouteAwareApply);
  });
})();`;
}

/**
 * Packages the PHP files and static assets into a WordPress theme ZIP
 */
async function packageTheme(themeFiles, buildPath, originalZipPath, logDetail = () => {}) {
  return new Promise((resolve, reject) => {
    // Determine a theme name from the original zip name
    const themeName = path.basename(originalZipPath, '.zip').toLowerCase().replace(/[^a-z0-9]/g, '-') || 'lovable-theme';
    
    // Create a temp output directory
    const outputDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wp-theme-'));
    const finalZipPath = path.join(path.dirname(originalZipPath), `${themeName}-wp-theme.zip`);
    const stagedBuildPath = stageBuildAssets(buildPath, logDetail);

    const output = fs.createWriteStream(finalZipPath);
    const archive = archiver('zip', { zlib: { level: 9 } });

    const cleanup = () => {
      fs.rmSync(outputDir, { recursive: true, force: true });
      fs.rmSync(stagedBuildPath, { recursive: true, force: true });
    };

    output.on('close', () => {
      cleanup();
      resolve(finalZipPath);
    });
    archive.on('error', (err) => {
      cleanup();
      reject(err);
    });

    archive.pipe(output);

    // 1. Add style.css metadata
    const styleCss = `/*
Theme Name: ${themeName}
Description: Converted from Lovable React template
Version: 1.0.0
Author: Lovable WP Agent
*/`;
    archive.append(styleCss, { name: `${themeName}/style.css` });

    // 2. Add all PHP files from LLM
    for (const [filename, content] of Object.entries(themeFiles)) {
      archive.append(content, { name: `${themeName}/${filename}` });
    }

    // Ensure index.php exists (Required by WordPress to be considered a valid theme)
    if (!themeFiles['index.php']) {
      const indexPhpContent = `<?php\n// Fallback index.php\nget_header();\nif (have_posts()) : while (have_posts()) : the_post(); the_content(); endwhile; endif;\nget_footer();\n?>`;
      archive.append(indexPhpContent, { name: `${themeName}/index.php` });
      logDetail(`Generated fallback index.php to satisfy WordPress requirements.`);
    }

    // 3. Embed entire dist folder mapped under vite-assets
    logDetail(`Bundling all static assets (including images/uploads) into theme...`);
    const viteAssets = findViteAssets(stagedBuildPath);
    archive.directory(stagedBuildPath, `${themeName}/vite-assets`);

    // 4. Add functions.php to properly link to the specific generated asset names
    archive.append(createFunctionsPhp(viteAssets, themeFiles), { name: `${themeName}/functions.php` });
    archive.append(createThemeInteractionsJs(), { name: `${themeName}/theme-interactions.js` });
    archive.append(createThemeBridgeJs(), { name: `${themeName}/theme-bridge.js` });

    archive.finalize();
  });
}

module.exports = { packageTheme };
