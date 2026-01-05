/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {zod} from '../third_party/index.js';
import type {HTTPRequest} from '../third_party/index.js';

import {ToolCategory} from './categories.js';
import type {CoverageReportEntry} from './coverage.js';
import {defineTool} from './ToolDefinition.js';

// ============================================================================
// Types
// ============================================================================

interface BundleChainNode {
  url: string;
  sizeBytes: number;
  startTimeMs: number;
  endTimeMs: number;
  loadTimeMs: number;
  children: BundleChainNode[];
}

interface BundleChain {
  depth: number;
  totalTimeMs: number;
  urls: string[];
  root: BundleChainNode;
}


interface DependencyAlternative {
  alternative: string;
  sizeSavingsKB: number;
  effort: 'low' | 'medium' | 'high';
}

type Priority = 'critical' | 'high' | 'medium' | 'low';

interface CodeSplitSuggestion {
  url: string;
  priority: Priority;
  totalBytes: number;
  usedBytes: number;
  unusedBytes: number;
  usagePercent: number;
  isExternal: boolean;
  detectedDependency?: string;
}

// ============================================================================
// Constants
// ============================================================================

/**
 * Static database of heavy dependencies with lighter alternatives.
 */
const DEPENDENCY_ALTERNATIVES: Record<string, DependencyAlternative[]> = {
  moment: [
    {alternative: 'dayjs', sizeSavingsKB: 58, effort: 'low'},
    {alternative: 'date-fns', sizeSavingsKB: 45, effort: 'medium'},
    {alternative: 'luxon', sizeSavingsKB: 30, effort: 'medium'},
  ],
  lodash: [
    {alternative: 'lodash-es (tree-shakeable)', sizeSavingsKB: 60, effort: 'low'},
    {alternative: 'Native methods + individual imports', sizeSavingsKB: 65, effort: 'medium'},
  ],
  underscore: [
    {alternative: 'lodash-es', sizeSavingsKB: 15, effort: 'low'},
    {alternative: 'Native methods', sizeSavingsKB: 20, effort: 'medium'},
  ],
  jquery: [
    {alternative: 'Native DOM APIs', sizeSavingsKB: 85, effort: 'high'},
    {alternative: 'cash-dom', sizeSavingsKB: 75, effort: 'low'},
  ],
  axios: [
    {alternative: 'fetch (native)', sizeSavingsKB: 12, effort: 'medium'},
    {alternative: 'ky', sizeSavingsKB: 8, effort: 'low'},
  ],
  'chart.js': [
    {alternative: 'uPlot', sizeSavingsKB: 150, effort: 'high'},
    {alternative: 'Chart.js with tree-shaking', sizeSavingsKB: 80, effort: 'medium'},
  ],
  'react-icons': [
    {alternative: 'Individual icon imports', sizeSavingsKB: 100, effort: 'low'},
  ],
  'core-js': [
    {alternative: 'Targeted polyfills only', sizeSavingsKB: 80, effort: 'medium'},
  ],
  validator: [
    {alternative: 'validator/es (tree-shakeable)', sizeSavingsKB: 40, effort: 'low'},
  ],
  numeral: [
    {alternative: 'Intl.NumberFormat (native)', sizeSavingsKB: 25, effort: 'medium'},
  ],
  'highlight.js': [
    {alternative: 'Prism.js with selected languages', sizeSavingsKB: 200, effort: 'medium'},
  ],
  quill: [
    {alternative: 'Tiptap', sizeSavingsKB: 100, effort: 'high'},
  ],
  'draft-js': [
    {alternative: 'Slate.js', sizeSavingsKB: 80, effort: 'high'},
  ],
  antd: [
    {alternative: 'Individual component imports', sizeSavingsKB: 300, effort: 'medium'},
  ],
  'material-ui': [
    {alternative: 'Individual component imports', sizeSavingsKB: 250, effort: 'medium'},
  ],
};

// Time threshold for considering scripts as part of a chain (ms)
const CHAIN_GAP_THRESHOLD_MS = 50;

// ============================================================================
// Helper Functions
// ============================================================================


/**
 * Gets timing information from a network request.
 * Returns start and end times in milliseconds since epoch.
 */
function getRequestTiming(request: HTTPRequest): {
  startTimeMs: number;
  endTimeMs: number;
  sizeBytes: number;
} | null {
  const response = request.response();
  if (!response) {
    return null;
  }

  const timing = response.timing();
  if (!timing) {
    return null;
  }

  // timing.requestTime is in seconds since epoch
  const startTimeMs = timing.requestTime * 1000;
  // receiveHeadersEnd is ms relative to requestTime
  const endTimeMs = startTimeMs + timing.receiveHeadersEnd;

  // Get size from Content-Length header or estimate
  const contentLength = response.headers()['content-length'];
  const sizeBytes = contentLength ? parseInt(contentLength, 10) : 0;

  return {startTimeMs, endTimeMs, sizeBytes};
}

/**
 * Detects bundle loading chains from network requests.
 * A chain is detected when script B starts loading within CHAIN_GAP_THRESHOLD_MS
 * of script A completing.
 */
function detectBundleChains(
  requests: HTTPRequest[],
  minChainDepth: number,
  minChainTimeMs: number,
): BundleChain[] {
  // Filter to script requests with timing data
  const scriptRequests = requests.filter(r => r.resourceType() === 'script');

  const scriptsWithTiming: Array<{
    request: HTTPRequest;
    url: string;
    startTimeMs: number;
    endTimeMs: number;
    sizeBytes: number;
  }> = [];

  for (const request of scriptRequests) {
    const timing = getRequestTiming(request);
    if (timing) {
      scriptsWithTiming.push({
        request,
        url: request.url(),
        ...timing,
      });
    }
  }

  // Sort by end time
  scriptsWithTiming.sort((a, b) => a.endTimeMs - b.endTimeMs);

  // Build chain nodes
  const chains: BundleChain[] = [];
  const usedUrls = new Set<string>();

  for (const script of scriptsWithTiming) {
    if (usedUrls.has(script.url)) {
      continue;
    }

    // Try to build a chain starting from this script
    const chainNodes: BundleChainNode[] = [];
    let currentScript = script;
    const chainUrls: string[] = [];

    while (currentScript) {
      const node: BundleChainNode = {
        url: currentScript.url,
        sizeBytes: currentScript.sizeBytes,
        startTimeMs: currentScript.startTimeMs,
        endTimeMs: currentScript.endTimeMs,
        loadTimeMs: currentScript.endTimeMs - currentScript.startTimeMs,
        children: [],
      };
      chainNodes.push(node);
      chainUrls.push(currentScript.url);
      usedUrls.add(currentScript.url);

      // Find next script in chain (starts shortly after current ends)
      const nextScript = scriptsWithTiming.find(
        s =>
          !usedUrls.has(s.url) &&
          s.startTimeMs >= currentScript.endTimeMs &&
          s.startTimeMs <= currentScript.endTimeMs + CHAIN_GAP_THRESHOLD_MS,
      );

      if (nextScript) {
        currentScript = nextScript;
      } else {
        break;
      }
    }

    // Build tree structure (linear chain)
    if (chainNodes.length >= minChainDepth) {
      for (let i = 0; i < chainNodes.length - 1; i++) {
        chainNodes[i].children = [chainNodes[i + 1]];
      }

      const totalTimeMs =
        chainNodes[chainNodes.length - 1].endTimeMs - chainNodes[0].startTimeMs;

      if (totalTimeMs >= minChainTimeMs) {
        chains.push({
          depth: chainNodes.length,
          totalTimeMs,
          urls: chainUrls,
          root: chainNodes[0],
        });
      }
    }
  }

  return chains;
}

/**
 * Formats a bundle chain as a tree visualization.
 */
function formatChainTree(node: BundleChainNode, indent: number = 0): string {
  const prefix = '  '.repeat(indent);
  const arrow = indent > 0 ? '=> ' : '';
  const shortUrl =
    node.url.length > 60 ? '...' + node.url.slice(-57) : node.url;
  const sizeKB = (node.sizeBytes / 1024).toFixed(1);

  let line = `${prefix}${arrow}${shortUrl} (${node.loadTimeMs.toFixed(0)}ms, ${sizeKB}KB)`;

  for (const child of node.children) {
    line += '\n' + formatChainTree(child, indent + 1);
  }

  return line;
}

/**
 * Generates preload link tags for bundle chains.
 */
function generatePreloadTags(chains: BundleChain[]): string[] {
  const tags: string[] = [];

  for (const chain of chains) {
    // Skip the first script (already discovered by parser)
    // Preload all subsequent scripts in the chain
    for (const url of chain.urls.slice(1)) {
      tags.push(`<link rel="preload" href="${url}" as="script">`);
    }
  }

  return tags;
}


/**
 * Identifies merge candidates (scripts always loaded together).
 */
function identifyMergeCandidates(
  chains: BundleChain[],
): Array<{urls: string[]; combinedSizeKB: number; reason: string}> {
  const candidates: Array<{
    urls: string[];
    combinedSizeKB: number;
    reason: string;
  }> = [];

  for (const chain of chains) {
    if (chain.urls.length >= 2) {
      // Calculate combined size from the chain
      let combinedSize = 0;
      let node: BundleChainNode | undefined = chain.root;
      while (node) {
        combinedSize += node.sizeBytes;
        node = node.children[0];
      }

      candidates.push({
        urls: chain.urls,
        combinedSizeKB: combinedSize / 1024,
        reason: 'Always loaded together in sequence',
      });
    }
  }

  return candidates;
}

/**
 * Detects heavy dependencies from URL patterns.
 */
function detectHeavyDependency(url: string): string | null {
  const lowerUrl = url.toLowerCase();

  for (const dep of Object.keys(DEPENDENCY_ALTERNATIVES)) {
    // Check for common patterns: /moment/, moment.js, moment.min.js, etc.
    const patterns = [
      `/${dep}/`,
      `/${dep}.`,
      `${dep}.js`,
      `${dep}.min.js`,
      `${dep}-`,
    ];

    for (const pattern of patterns) {
      if (lowerUrl.includes(pattern)) {
        return dep;
      }
    }
  }

  return null;
}

/**
 * Determines priority based on unused bytes and percentage.
 */
function determinePriority(unusedBytes: number, unusedPercent: number): Priority {
  if (unusedBytes > 100 * 1024 || unusedPercent > 50) {
    return 'critical';
  }
  if (unusedBytes > 50 * 1024 || unusedPercent > 30) {
    return 'high';
  }
  if (unusedBytes > 20 * 1024 || unusedPercent > 20) {
    return 'medium';
  }
  return 'low';
}

/**
 * Generates natural language advice for lazy loading a module.
 */
function generateLazyLoadAdvice(url: string, unusedPercent: number): string {
  const fileName = url.split('/').pop() || 'this module';
  const shortName = fileName.length > 40 ? '...' + fileName.slice(-37) : fileName;

  return `**${shortName}** has ${unusedPercent.toFixed(0)}% unused code on initial load. Consider lazy loading this module so it's only fetched when actually needed. Convert static imports to dynamic imports and load the module on user interaction or route change.`;
}

// ============================================================================
// Tools
// ============================================================================

export const analyzeBundleChains = defineTool({
  name: 'analyze_bundle_chains',
  description: `Analyzes JavaScript bundle loading patterns to detect sequential loading chains (A→B→C) where each bundle must load before the next is discovered. Returns optimization suggestions including preload link tags, general optimization advice, and merge candidates. Use this after the page has loaded to identify bundle loading inefficiencies.`,
  annotations: {
    category: ToolCategory.PERFORMANCE,
    readOnlyHint: true,
  },
  schema: {
    minChainDepth: zod
      .number()
      .int()
      .min(2)
      .default(2)
      .optional()
      .describe('Minimum chain depth to report. Default is 2.'),
    minChainTimeMs: zod
      .number()
      .min(0)
      .default(100)
      .optional()
      .describe('Minimum total chain time in ms to report. Default is 100ms.'),
  },
  handler: async (request, response, context) => {
    const minChainDepth = request.params.minChainDepth ?? 2;
    const minChainTimeMs = request.params.minChainTimeMs ?? 100;

    const requests = context.getNetworkRequests(true);
    const scriptRequests = requests.filter(r => r.resourceType() === 'script');

    if (scriptRequests.length === 0) {
      response.appendResponseLine(
        'No JavaScript requests found. Navigate to a page first.',
      );
      return;
    }

    // Detect chains
    const chains = detectBundleChains(requests, minChainDepth, minChainTimeMs);

    const lines: string[] = [];
    lines.push('## Bundle Chain Analysis');
    lines.push('');
    lines.push(`**Total scripts analyzed**: ${scriptRequests.length}`);
    lines.push('');

    if (chains.length === 0) {
      lines.push('### No Loading Chains Detected');
      lines.push('');
      lines.push(
        `No sequential bundle chains found with depth >= ${minChainDepth} and time >= ${minChainTimeMs}ms.`,
      );
      lines.push('');
      lines.push('This could mean:');
      lines.push('- Scripts are loaded in parallel (good!)');
      lines.push('- Scripts are preloaded or inlined');
      lines.push(
        '- The page uses effective code splitting',
      );
    } else {
      // Summary
      const totalChainTime = chains.reduce((sum, c) => sum + c.totalTimeMs, 0);
      const avgChainDepth =
        chains.reduce((sum, c) => sum + c.depth, 0) / chains.length;

      lines.push('### Summary');
      lines.push(`- Chains detected: ${chains.length}`);
      lines.push(`- Total chain time: ${totalChainTime.toFixed(0)}ms`);
      lines.push(`- Average chain depth: ${avgChainDepth.toFixed(1)}`);
      lines.push(
        `- Potential savings: ~${(totalChainTime * 0.7).toFixed(0)}ms (estimated)`,
      );
      lines.push('');

      // Chain visualizations
      lines.push('### Loading Chains');
      lines.push('');

      for (let i = 0; i < chains.length; i++) {
        const chain = chains[i];
        lines.push(
          `#### Chain ${i + 1} (${chain.depth} levels, ${chain.totalTimeMs.toFixed(0)}ms)`,
        );
        lines.push('');
        lines.push('```');
        lines.push(formatChainTree(chain.root));
        lines.push('```');
        lines.push('');
      }

      // Preload suggestions
      const preloadTags = generatePreloadTags(chains);
      if (preloadTags.length > 0) {
        lines.push('### Preload Suggestions');
        lines.push('Add these to your HTML `<head>` to hint the browser to fetch these scripts earlier:');
        lines.push('');
        lines.push('```html');
        lines.push(...preloadTags);
        lines.push('```');
        lines.push('');
      }

      // General optimization advice
      lines.push('### Optimization Strategies');
      lines.push('');
      lines.push('**1. Use resource hints**: Add `<link rel="preload">` tags (shown above) to tell the browser about critical scripts before they are discovered in the dependency chain.');
      lines.push('');
      lines.push('**2. Configure your bundler for preloading**: Most bundlers support automatic preload injection. Look for preload/prefetch options in your build configuration. For dynamic imports, there are usually magic comments or configuration options to mark chunks as preloadable.');
      lines.push('');
      lines.push('**3. Consider code splitting boundaries**: If scripts are always loaded together in a chain, they might be better combined into a single chunk to reduce round trips.');
      lines.push('');
      lines.push('**4. Review dynamic import patterns**: Chains often form when dynamically imported modules import other modules. Consider whether the child dependencies should be bundled with their parent.');
      lines.push('');

      // Merge candidates
      const mergeCandidates = identifyMergeCandidates(chains);
      if (mergeCandidates.length > 0) {
        lines.push('### Merge Candidates');
        lines.push(
          'These bundles are always loaded together and could be merged:',
        );
        lines.push('');
        for (const candidate of mergeCandidates) {
          const shortUrls = candidate.urls.map(u =>
            u.length > 40 ? '...' + u.slice(-37) : u,
          );
          lines.push(`- ${shortUrls.join(' + ')}`);
          lines.push(`  - Combined size: ${candidate.combinedSizeKB.toFixed(1)}KB`);
          lines.push(`  - Reason: ${candidate.reason}`);
        }
      }
    }

    response.appendResponseLine(lines.join('\n'));
  },
});

export const suggestCodeSplits = defineTool({
  name: 'suggest_code_splits',
  description: `Analyzes code coverage data to identify oversized bundles and suggest optimizations. Returns recommendations for lazy loading, tree shaking, lighter dependency alternatives, and duplicate detection. Requires coverage_stop to have been called first to collect coverage data.`,
  annotations: {
    category: ToolCategory.PERFORMANCE,
    readOnlyHint: true,
  },
  schema: {
    minBundleSizeKB: zod
      .number()
      .min(0)
      .default(50)
      .optional()
      .describe('Minimum bundle size in KB to analyze. Default is 50KB.'),
    minUnusedPercent: zod
      .number()
      .min(0)
      .max(100)
      .default(20)
      .optional()
      .describe(
        'Minimum unused percentage to flag as optimization opportunity. Default is 20%.',
      ),
  },
  handler: async (request, response, context) => {
    const minBundleSizeKB = request.params.minBundleSizeKB ?? 50;
    const minUnusedPercent = request.params.minUnusedPercent ?? 20;

    const coverageReport = context.getLastCoverageReport();

    if (!coverageReport) {
      response.appendResponseLine('## Error: No Coverage Data Available');
      response.appendResponseLine('');
      response.appendResponseLine(
        'You must run coverage tracking before using this tool:',
      );
      response.appendResponseLine('1. Call `coverage_start` to begin tracking');
      response.appendResponseLine('2. Navigate or interact with the page');
      response.appendResponseLine('3. Call `coverage_stop` to collect data');
      response.appendResponseLine(
        '4. Then call `suggest_code_splits` to analyze',
      );
      return;
    }

    const jsCoverage = coverageReport.jsCoverage;

    if (jsCoverage.length === 0) {
      response.appendResponseLine('## No JavaScript Coverage Data');
      response.appendResponseLine('');
      response.appendResponseLine(
        'No JavaScript files were captured in the coverage report.',
      );
      return;
    }

    // Filter bundles by size and unused percentage
    const candidates: CodeSplitSuggestion[] = [];
    const heavyDeps = new Map<string, CoverageReportEntry>();

    for (const entry of jsCoverage) {
      const sizeKB = entry.totalBytes / 1024;
      const unusedPercent = 100 - entry.usagePercent;

      if (sizeKB >= minBundleSizeKB && unusedPercent >= minUnusedPercent) {
        const detectedDep = detectHeavyDependency(entry.url);

        candidates.push({
          url: entry.url,
          priority: determinePriority(entry.unusedBytes, unusedPercent),
          totalBytes: entry.totalBytes,
          usedBytes: entry.usedBytes,
          unusedBytes: entry.unusedBytes,
          usagePercent: entry.usagePercent,
          isExternal: entry.isExternal,
          detectedDependency: detectedDep || undefined,
        });

        if (detectedDep) {
          heavyDeps.set(detectedDep, entry);
        }
      }
    }

    // Sort by priority and unused bytes
    const priorityOrder: Record<Priority, number> = {
      critical: 0,
      high: 1,
      medium: 2,
      low: 3,
    };
    candidates.sort((a, b) => {
      const priorityDiff = priorityOrder[a.priority] - priorityOrder[b.priority];
      if (priorityDiff !== 0) return priorityDiff;
      return b.unusedBytes - a.unusedBytes;
    });

    const lines: string[] = [];
    lines.push('## Code Split Suggestions');
    lines.push('');

    // Summary
    const totalUnused = candidates.reduce((sum, c) => sum + c.unusedBytes, 0);
    const criticalCount = candidates.filter(c => c.priority === 'critical').length;
    const highCount = candidates.filter(c => c.priority === 'high').length;

    lines.push('### Summary');
    lines.push(`- Total unused: ${(totalUnused / 1024).toFixed(1)}KB`);
    lines.push(
      `- Potential savings: ~${((totalUnused * 0.7) / 1024).toFixed(1)}KB (estimated)`,
    );
    lines.push(`- Critical issues: ${criticalCount}`);
    lines.push(`- High priority issues: ${highCount}`);
    lines.push(`- Total opportunities: ${candidates.length}`);
    lines.push('');

    if (candidates.length === 0) {
      lines.push('### No Optimization Opportunities Found');
      lines.push('');
      lines.push(
        `No bundles found with size >= ${minBundleSizeKB}KB and unused >= ${minUnusedPercent}%.`,
      );
      lines.push('Your bundles appear well-optimized!');
    } else {
      // Heavy dependencies with alternatives
      if (heavyDeps.size > 0) {
        lines.push('### Heavy Dependencies with Lighter Alternatives');
        lines.push('');
        lines.push('| Current | Alternative | Savings | Effort |');
        lines.push('|---------|-------------|---------|--------|');

        for (const [dep] of heavyDeps) {
          const alternatives = DEPENDENCY_ALTERNATIVES[dep];
          if (alternatives) {
            for (const alt of alternatives) {
              lines.push(
                `| ${dep} | ${alt.alternative} | ${alt.sizeSavingsKB}KB | ${alt.effort} |`,
              );
            }
          }
        }
        lines.push('');
      }

      // Lazy load candidates
      const lazyLoadCandidates = candidates.filter(
        c => c.usagePercent < 50 && !c.isExternal,
      );
      if (lazyLoadCandidates.length > 0) {
        lines.push('### Lazy Load Candidates');
        lines.push(
          'These modules have low initial usage and should be lazy loaded to improve initial page load:',
        );
        lines.push('');

        for (const candidate of lazyLoadCandidates.slice(0, 5)) {
          const unusedPercent = 100 - candidate.usagePercent;
          lines.push(
            `- ${generateLazyLoadAdvice(candidate.url, unusedPercent)} [${candidate.priority}]`,
          );
          lines.push('');
        }
      }

      // Tree shaking suggestions for detected dependencies
      if (heavyDeps.size > 0) {
        lines.push('### Tree Shaking Opportunities');
        lines.push('');
        lines.push(
          'The following heavy dependencies were detected. Consider these optimizations:',
        );
        lines.push('');

        for (const [dep, entry] of heavyDeps) {
          const unusedPercent = 100 - entry.usagePercent;
          lines.push(`**${dep}** (${unusedPercent.toFixed(0)}% unused)`);
          lines.push('');
          lines.push(
            `- Only ${entry.usagePercent.toFixed(0)}% of this library is being used. Import only the specific functions you need instead of the entire library.`,
          );
          lines.push(
            `- Check if there's an ES modules version (often named with "-es" suffix) that supports tree shaking.`,
          );
          lines.push(
            `- Consider whether a lighter alternative from the table above would meet your needs.`,
          );
          lines.push('');
        }
      }

      // All candidates table
      lines.push('### All Optimization Opportunities');
      lines.push('');
      lines.push('| URL | Priority | Size | Used | Unused | Usage % |');
      lines.push('|-----|----------|------|------|--------|---------|');

      for (const candidate of candidates.slice(0, 15)) {
        const shortUrl =
          candidate.url.length > 35
            ? '...' + candidate.url.slice(-32)
            : candidate.url;
        lines.push(
          `| ${shortUrl} | ${candidate.priority} | ${(candidate.totalBytes / 1024).toFixed(1)}KB | ${(candidate.usedBytes / 1024).toFixed(1)}KB | ${(candidate.unusedBytes / 1024).toFixed(1)}KB | ${candidate.usagePercent.toFixed(1)}% |`,
        );
      }

      if (candidates.length > 15) {
        lines.push('');
        lines.push(`*...and ${candidates.length - 15} more opportunities*`);
      }
    }

    response.appendResponseLine(lines.join('\n'));
  },
});
