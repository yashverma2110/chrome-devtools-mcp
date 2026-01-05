/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import assert from 'node:assert';
import {describe, it, afterEach} from 'node:test';

import type {HTTPRequest, HTTPResponse} from 'puppeteer-core';
import sinon from 'sinon';

import {stableIdSymbol} from '../../src/PageCollector.js';
import type {CoverageReport} from '../../src/tools/coverage.js';
import {
  analyzeBundleChains,
  suggestCodeSplits,
} from '../../src/tools/bundleAnalysis.js';
import {withMcpContext} from '../utils.js';

/**
 * Creates a mock HTTPRequest with timing data for testing bundle chains.
 */
function createMockScriptRequest(options: {
  url: string;
  startTimeMs: number;
  endTimeMs: number;
  sizeBytes?: number;
  stableId?: number;
}): HTTPRequest {
  const mockTiming = {
    requestTime: options.startTimeMs / 1000, // Convert to seconds
    receiveHeadersEnd: options.endTimeMs - options.startTimeMs, // Relative ms
  };

  const mockResponse = {
    timing: () => mockTiming,
    headers: () => ({
      'content-length': String(options.sizeBytes ?? 10000),
    }),
    status: () => 200,
  } as unknown as HTTPResponse;

  return {
    url: () => options.url,
    method: () => 'GET',
    resourceType: () => 'script',
    response: () => mockResponse,
    failure: () => null,
    headers: () => ({}),
    redirectChain: () => [],
    isNavigationRequest: () => false,
    frame: () => ({} as never),
    hasPostData: () => false,
    postData: () => undefined,
    fetchPostData: () => Promise.reject(),
    [stableIdSymbol]: options.stableId ?? 1,
  } as unknown as HTTPRequest;
}

/**
 * Creates a mock document request (non-script).
 */
function createMockDocumentRequest(): HTTPRequest {
  return {
    url: () => 'https://example.com/',
    method: () => 'GET',
    resourceType: () => 'document',
    response: () => null,
    failure: () => null,
    headers: () => ({}),
    redirectChain: () => [],
    isNavigationRequest: () => true,
    frame: () => ({} as never),
    hasPostData: () => false,
    postData: () => undefined,
    fetchPostData: () => Promise.reject(),
    [stableIdSymbol]: 0,
  } as unknown as HTTPRequest;
}

describe('bundleAnalysis', () => {
  afterEach(() => {
    sinon.restore();
  });

  describe('analyze_bundle_chains', () => {
    it('shows message when no script requests found', async () => {
      await withMcpContext(async (response, context) => {
        context.getNetworkRequests = () => [createMockDocumentRequest()];

        await analyzeBundleChains.handler(
          {params: {}},
          response,
          context,
        );

        const output = response.responseLines.join('\n');
        assert.ok(output.includes('No JavaScript requests found'));
      });
    });

    it('detects simple A->B chain', async () => {
      await withMcpContext(async (response, context) => {
        // Script A loads at 0-100ms, Script B loads at 110-200ms (within 50ms gap)
        const scriptA = createMockScriptRequest({
          url: 'https://example.com/app.js',
          startTimeMs: 0,
          endTimeMs: 100,
          sizeBytes: 50000,
          stableId: 1,
        });

        const scriptB = createMockScriptRequest({
          url: 'https://example.com/vendor.js',
          startTimeMs: 110, // Within 50ms of A ending
          endTimeMs: 250,
          sizeBytes: 80000,
          stableId: 2,
        });

        context.getNetworkRequests = () => [
          createMockDocumentRequest(),
          scriptA,
          scriptB,
        ];

        await analyzeBundleChains.handler(
          {params: {minChainDepth: 2, minChainTimeMs: 100}},
          response,
          context,
        );

        const output = response.responseLines.join('\n');
        assert.ok(output.includes('Bundle Chain Analysis'));
        assert.ok(output.includes('Loading Chains'));
        assert.ok(output.includes('app.js'));
        assert.ok(output.includes('vendor.js'));
        assert.ok(output.includes('Preload Suggestions'));
      });
    });

    it('filters chains below minChainDepth', async () => {
      await withMcpContext(async (response, context) => {
        // Single script, no chain
        const scriptA = createMockScriptRequest({
          url: 'https://example.com/app.js',
          startTimeMs: 0,
          endTimeMs: 100,
          stableId: 1,
        });

        context.getNetworkRequests = () => [scriptA];

        await analyzeBundleChains.handler(
          {params: {minChainDepth: 2}},
          response,
          context,
        );

        const output = response.responseLines.join('\n');
        assert.ok(output.includes('No Loading Chains Detected'));
      });
    });

    it('filters chains below minChainTimeMs', async () => {
      await withMcpContext(async (response, context) => {
        // Chain with total time of only 50ms (below 100ms threshold)
        const scriptA = createMockScriptRequest({
          url: 'https://example.com/app.js',
          startTimeMs: 0,
          endTimeMs: 20,
          stableId: 1,
        });

        const scriptB = createMockScriptRequest({
          url: 'https://example.com/vendor.js',
          startTimeMs: 25,
          endTimeMs: 50,
          stableId: 2,
        });

        context.getNetworkRequests = () => [scriptA, scriptB];

        await analyzeBundleChains.handler(
          {params: {minChainDepth: 2, minChainTimeMs: 100}},
          response,
          context,
        );

        const output = response.responseLines.join('\n');
        assert.ok(output.includes('No Loading Chains Detected'));
      });
    });

    it('generates preload tags for chained bundles', async () => {
      await withMcpContext(async (response, context) => {
        const scriptA = createMockScriptRequest({
          url: 'https://example.com/app.js',
          startTimeMs: 0,
          endTimeMs: 100,
          stableId: 1,
        });

        const scriptB = createMockScriptRequest({
          url: 'https://example.com/vendor.js',
          startTimeMs: 110,
          endTimeMs: 300,
          stableId: 2,
        });

        context.getNetworkRequests = () => [scriptA, scriptB];

        await analyzeBundleChains.handler(
          {params: {minChainDepth: 2, minChainTimeMs: 100}},
          response,
          context,
        );

        const output = response.responseLines.join('\n');
        assert.ok(output.includes('<link rel="preload" href="https://example.com/vendor.js" as="script">'));
      });
    });

    it('identifies merge candidates', async () => {
      await withMcpContext(async (response, context) => {
        const scriptA = createMockScriptRequest({
          url: 'https://example.com/app.js',
          startTimeMs: 0,
          endTimeMs: 100,
          stableId: 1,
        });

        const scriptB = createMockScriptRequest({
          url: 'https://example.com/utils.js',
          startTimeMs: 110,
          endTimeMs: 200,
          stableId: 2,
        });

        context.getNetworkRequests = () => [scriptA, scriptB];

        await analyzeBundleChains.handler(
          {params: {minChainDepth: 2, minChainTimeMs: 100}},
          response,
          context,
        );

        const output = response.responseLines.join('\n');
        assert.ok(output.includes('Merge Candidates'));
        assert.ok(output.includes('Always loaded together'));
      });
    });
  });

  describe('suggest_code_splits', () => {
    it('errors when no coverage data available', async () => {
      await withMcpContext(async (response, context) => {
        context.getLastCoverageReport = () => null;

        await suggestCodeSplits.handler(
          {params: {}},
          response,
          context,
        );

        const output = response.responseLines.join('\n');
        assert.ok(output.includes('Error: No Coverage Data Available'));
        assert.ok(output.includes('coverage_start'));
        assert.ok(output.includes('coverage_stop'));
      });
    });

    it('shows message when no JS coverage data', async () => {
      await withMcpContext(async (response, context) => {
        const mockReport: CoverageReport = {
          jsCoverage: [],
          cssCoverage: [],
          summary: {
            totalResources: 0,
            totalBytes: 0,
            usedBytes: 0,
            unusedBytes: 0,
            overallUsagePercent: 0,
          },
        };
        context.getLastCoverageReport = () => mockReport;

        await suggestCodeSplits.handler(
          {params: {}},
          response,
          context,
        );

        const output = response.responseLines.join('\n');
        assert.ok(output.includes('No JavaScript Coverage Data'));
      });
    });

    it('identifies bundles with high unused percentage', async () => {
      await withMcpContext(async (response, context) => {
        const mockReport: CoverageReport = {
          jsCoverage: [
            {
              url: 'https://example.com/large-unused.js',
              totalBytes: 100000,
              usedBytes: 20000,
              unusedBytes: 80000,
              usagePercent: 20,
              isExternal: false,
            },
          ],
          cssCoverage: [],
          summary: {
            totalResources: 1,
            totalBytes: 100000,
            usedBytes: 20000,
            unusedBytes: 80000,
            overallUsagePercent: 20,
          },
        };
        context.getLastCoverageReport = () => mockReport;

        await suggestCodeSplits.handler(
          {params: {minBundleSizeKB: 50, minUnusedPercent: 20}},
          response,
          context,
        );

        const output = response.responseLines.join('\n');
        assert.ok(output.includes('Code Split Suggestions'));
        assert.ok(output.includes('large-unused.js'));
        assert.ok(output.includes('critical') || output.includes('high'));
      });
    });

    it('detects moment.js and suggests alternatives', async () => {
      await withMcpContext(async (response, context) => {
        const mockReport: CoverageReport = {
          jsCoverage: [
            {
              url: 'https://example.com/moment.min.js',
              totalBytes: 150000,
              usedBytes: 30000,
              unusedBytes: 120000,
              usagePercent: 20,
              isExternal: true,
            },
          ],
          cssCoverage: [],
          summary: {
            totalResources: 1,
            totalBytes: 150000,
            usedBytes: 30000,
            unusedBytes: 120000,
            overallUsagePercent: 20,
          },
        };
        context.getLastCoverageReport = () => mockReport;

        await suggestCodeSplits.handler(
          {params: {minBundleSizeKB: 50, minUnusedPercent: 20}},
          response,
          context,
        );

        const output = response.responseLines.join('\n');
        assert.ok(output.includes('Heavy Dependencies'));
        assert.ok(output.includes('moment'));
        assert.ok(output.includes('dayjs'));
      });
    });

    it('detects lodash and suggests alternatives', async () => {
      await withMcpContext(async (response, context) => {
        const mockReport: CoverageReport = {
          jsCoverage: [
            {
              url: 'https://example.com/lodash.js',
              totalBytes: 100000,
              usedBytes: 20000,
              unusedBytes: 80000,
              usagePercent: 20,
              isExternal: true,
            },
          ],
          cssCoverage: [],
          summary: {
            totalResources: 1,
            totalBytes: 100000,
            usedBytes: 20000,
            unusedBytes: 80000,
            overallUsagePercent: 20,
          },
        };
        context.getLastCoverageReport = () => mockReport;

        await suggestCodeSplits.handler(
          {params: {minBundleSizeKB: 50, minUnusedPercent: 20}},
          response,
          context,
        );

        const output = response.responseLines.join('\n');
        assert.ok(output.includes('lodash'));
        assert.ok(output.includes('lodash-es'));
      });
    });

    it('respects minBundleSizeKB filter', async () => {
      await withMcpContext(async (response, context) => {
        const mockReport: CoverageReport = {
          jsCoverage: [
            {
              url: 'https://example.com/small.js',
              totalBytes: 10000, // Only 10KB
              usedBytes: 2000,
              unusedBytes: 8000,
              usagePercent: 20,
              isExternal: false,
            },
          ],
          cssCoverage: [],
          summary: {
            totalResources: 1,
            totalBytes: 10000,
            usedBytes: 2000,
            unusedBytes: 8000,
            overallUsagePercent: 20,
          },
        };
        context.getLastCoverageReport = () => mockReport;

        await suggestCodeSplits.handler(
          {params: {minBundleSizeKB: 50}}, // Require at least 50KB
          response,
          context,
        );

        const output = response.responseLines.join('\n');
        assert.ok(output.includes('No Optimization Opportunities Found'));
      });
    });

    it('respects minUnusedPercent filter', async () => {
      await withMcpContext(async (response, context) => {
        const mockReport: CoverageReport = {
          jsCoverage: [
            {
              url: 'https://example.com/well-used.js',
              totalBytes: 100000,
              usedBytes: 95000,
              unusedBytes: 5000,
              usagePercent: 95, // Only 5% unused
              isExternal: false,
            },
          ],
          cssCoverage: [],
          summary: {
            totalResources: 1,
            totalBytes: 100000,
            usedBytes: 95000,
            unusedBytes: 5000,
            overallUsagePercent: 95,
          },
        };
        context.getLastCoverageReport = () => mockReport;

        await suggestCodeSplits.handler(
          {params: {minBundleSizeKB: 50, minUnusedPercent: 20}}, // Require at least 20% unused
          response,
          context,
        );

        const output = response.responseLines.join('\n');
        assert.ok(output.includes('No Optimization Opportunities Found'));
      });
    });

    it('suggests lazy loading for internal bundles with low usage', async () => {
      await withMcpContext(async (response, context) => {
        const mockReport: CoverageReport = {
          jsCoverage: [
            {
              url: 'https://example.com/charts.js',
              totalBytes: 80000,
              usedBytes: 16000, // 20% used
              unusedBytes: 64000,
              usagePercent: 20,
              isExternal: false,
            },
          ],
          cssCoverage: [],
          summary: {
            totalResources: 1,
            totalBytes: 80000,
            usedBytes: 16000,
            unusedBytes: 64000,
            overallUsagePercent: 20,
          },
        };
        context.getLastCoverageReport = () => mockReport;

        await suggestCodeSplits.handler(
          {params: {minBundleSizeKB: 50, minUnusedPercent: 20}},
          response,
          context,
        );

        const output = response.responseLines.join('\n');
        assert.ok(output.includes('Lazy Load Candidates'));
        assert.ok(output.includes('lazy load') || output.includes('dynamic import'));
      });
    });

    it('assigns correct priority levels', async () => {
      await withMcpContext(async (response, context) => {
        const mockReport: CoverageReport = {
          jsCoverage: [
            {
              url: 'https://example.com/critical.js',
              totalBytes: 200000, // 200KB with 60% unused = critical
              usedBytes: 80000,
              unusedBytes: 120000,
              usagePercent: 40,
              isExternal: false,
            },
            {
              url: 'https://example.com/high.js',
              totalBytes: 100000, // 100KB with 40% unused = high
              usedBytes: 60000,
              unusedBytes: 40000,
              usagePercent: 60,
              isExternal: false,
            },
          ],
          cssCoverage: [],
          summary: {
            totalResources: 2,
            totalBytes: 300000,
            usedBytes: 140000,
            unusedBytes: 160000,
            overallUsagePercent: 46.7,
          },
        };
        context.getLastCoverageReport = () => mockReport;

        await suggestCodeSplits.handler(
          {params: {minBundleSizeKB: 50, minUnusedPercent: 20}},
          response,
          context,
        );

        const output = response.responseLines.join('\n');
        assert.ok(output.includes('critical'));
        assert.ok(output.includes('Critical issues:'));
      });
    });

    it('generates tree shaking suggestions for detected dependencies', async () => {
      await withMcpContext(async (response, context) => {
        const mockReport: CoverageReport = {
          jsCoverage: [
            {
              url: 'https://example.com/node_modules/lodash/lodash.js',
              totalBytes: 100000,
              usedBytes: 20000,
              unusedBytes: 80000,
              usagePercent: 20,
              isExternal: true,
            },
          ],
          cssCoverage: [],
          summary: {
            totalResources: 1,
            totalBytes: 100000,
            usedBytes: 20000,
            unusedBytes: 80000,
            overallUsagePercent: 20,
          },
        };
        context.getLastCoverageReport = () => mockReport;

        await suggestCodeSplits.handler(
          {params: {minBundleSizeKB: 50, minUnusedPercent: 20}},
          response,
          context,
        );

        const output = response.responseLines.join('\n');
        assert.ok(output.includes('Tree Shaking'));
        assert.ok(output.includes('ES modules') || output.includes('tree shaking'));
      });
    });
  });
});
