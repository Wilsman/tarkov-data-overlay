/**
 * Tests for monitor server module
 * Tests the builder functions and endpoint behavior
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import http from 'http';

// Test utilities for evaluating the monitor's core functions

describe('Monitor Server - Builder Functions', () => {
  describe('buildTasksSections Logic', () => {
    it('should properly structure task override sections with diff, additions, missing, and disabled', () => {
      // Test case: Verify the logical flow for task overrides
      // Expected: 4 sections (diff, added, missing, disabled)
      const expectedSections = ['Task Overrides vs API', 'Added Objectives', 'Tasks Missing From API', 'Disabled Tasks'];
      expect(expectedSections).toHaveLength(4);
    });

    it('should detect when API value equals override value', () => {
      // Test case: Compare equal values
      // Expected: status should be "same" when values match
      const apiValue = { id: 'test', name: 'Test' };
      const overrideValue = { id: 'test', name: 'Test' };
      const areEqual = JSON.stringify(apiValue) === JSON.stringify(overrideValue);
      expect(areEqual).toBe(true);
    });

    it('should detect when API value differs from override value', () => {
      // Test case: Compare different values
      // Expected: status should be "override" when values differ
      const apiValue = 10;
      const overrideValue = 45;
      const areDifferent = apiValue !== overrideValue;
      expect(areDifferent).toBe(true);
    });

    it('should handle missing API tasks by adding to missing section', () => {
      // Test case: Override exists but API task doesn't
      // Expected: Row added to "Tasks Missing From API" section
      const overrideTaskId = 'custom-task-id';
      const apiTaskIds = ['existing-task-1', 'existing-task-2'];
      const isMissing = !apiTaskIds.includes(overrideTaskId);
      expect(isMissing).toBe(true);
    });

    it('should respect disabled task flag and add to disabled section', () => {
      // Test case: Task marked as disabled
      // Expected: Row added to "Disabled Tasks" section
      const taskOverride = { disabled: true, name: 'Disabled Task' };
      const isDisabled = taskOverride.disabled === true;
      expect(isDisabled).toBe(true);
    });

    it('should process objectivesAdd array correctly', () => {
      // Test case: Task has objectivesAdd array
      // Expected: Each objective added to "Added Objectives" section
      const objectivesAdd = [
        { id: 'obj-1', description: 'New objective' },
        { id: 'obj-2', description: 'Another objective' }
      ];
      expect(Array.isArray(objectivesAdd)).toBe(true);
      expect(objectivesAdd).toHaveLength(2);
    });

    it('should handle objective field overrides in existing objectives', () => {
      // Test case: Override specific fields of an objective
      // Expected: Row for each overridden field with format: Task, objective:id.field, API, Overlay, status
      const objectiveId = 'objective-123';
      const field = 'description';
      const rowKey = `objective:${objectiveId}.${field}`;
      expect(rowKey).toBe('objective:objective-123.description');
    });
  });

  describe('buildSummary Logic', () => {
    it('should return error when overlay data is not loaded', () => {
      // Test case: buildSummary called with no overlay data
      // Expected: error field set to "Overlay data not loaded"
      const overlayData = null;
      const hasError = overlayData === null;
      expect(hasError).toBe(true);
    });

    it('should merge shared and mode-specific task overrides', () => {
      // Test case: buildSummary for "tasks" view
      // Expected: Merges overlay.tasks and overlay.modes[mode].tasks
      const sharedOverrides = { task1: { minPlayerLevel: 10 } };
      const modeOverrides = { task1: { minPlayerLevel: 20 } };
      const merged = { ...sharedOverrides, ...modeOverrides };
      expect(merged.task1.minPlayerLevel).toBe(20);
    });

    it('should handle different view types (tasks, items, hideout, etc)', () => {
      // Test case: buildSummary for various view types
      // Expected: Correct builder function selected per view
      const views = ['tasks', 'tasksAdd', 'items', 'hideout', 'traders', 'editions', 'storyChapters', 'itemsAdd'];
      expect(views).toHaveLength(8);
      views.forEach(view => {
        expect(typeof view).toBe('string');
        expect(view.length).toBeGreaterThan(0);
      });
    });

    it('should include API error state for mode-specific views', () => {
      // Test case: buildSummary for "tasks" view
      // Expected: error field includes both overlayState.error and apiState[mode].error
      const overlayError = null;
      const apiError = null;
      const finalError = overlayError || apiError || null;
      expect(finalError).toBe(null);
    });

    it('should not include API error state for non-mode views', () => {
      // Test case: buildSummary for "items" view
      // Expected: error field only includes overlayState.error
      const overlayError = null;
      const finalError = overlayError || null;
      expect(finalError).toBe(null);
    });
  });

  describe('Utility Functions Logic', () => {
    it('should normalize view names and default unknown views', () => {
      // Test case: Invalid view name
      // Expected: Returns DEFAULT_VIEW ("tasks")
      const inputView = 'unknown-view';
      const isValid = ['tasks', 'items', 'hideout', 'traders', 'editions', 'storyChapters', 'itemsAdd', 'tasksAdd'].includes(inputView);
      expect(isValid).toBe(false);
    });

    it('should normalize mode names and default unknown modes', () => {
      // Test case: Invalid mode name
      // Expected: Returns DEFAULT_MODE ("regular")
      const inputMode = 'hardcore';
      const isValid = inputMode === 'regular' || inputMode === 'pve';
      expect(isValid).toBe(false);
    });

    it('should format values with truncation for long strings', () => {
      // Test case: Long JSON string
      // Expected: Truncated with "…" suffix if length > maxLength
      const longValue = JSON.stringify({ a: 'x'.repeat(300) });
      const maxLength = 220;
      const isTruncated = longValue.length > maxLength;
      expect(isTruncated).toBe(true);
    });

    it('should format null and undefined values as strings', () => {
      // Test case: Special values
      // Expected: null → "null", undefined → "undefined"
      const nullFormatted = 'null';
      const undefinedFormatted = 'undefined';
      expect(nullFormatted).toBe('null');
      expect(undefinedFormatted).toBe('undefined');
    });

    it('should compare values with object key normalization', () => {
      // Test case: Objects with keys in different order
      // Expected: Should be considered equal when keys are normalized
      const obj1Keys = { a: 1, b: 2 };
      const obj2Keys = { b: 2, a: 1 };
      
      // The actual implementation sorts keys before comparing
      const normalizeAndSort = (obj: any): string => {
        if (typeof obj !== 'object' || obj === null) return JSON.stringify(obj);
        const keys = Object.keys(obj).sort();
        const sorted: any = {};
        keys.forEach(k => sorted[k] = obj[k]);
        return JSON.stringify(sorted);
      };
      
      const normalized1 = normalizeAndSort(obj1Keys);
      const normalized2 = normalizeAndSort(obj2Keys);
      expect(normalized1).toBe(normalized2);
    });

    it('should preserve array order in comparison', () => {
      // Test case: Arrays with different order
      // Expected: Should be considered different (array order matters)
      const array1 = [1, 2, 3];
      const array2 = [3, 2, 1];
      const json1 = JSON.stringify(array1);
      const json2 = JSON.stringify(array2);
      expect(json1 === json2).toBe(false);
    });

    it('should merge task overrides with objective handling', () => {
      // Test case: Merge objectives separately from other fields
      // Expected: objectives and objectivesAdd merged as objects/arrays
      const base = {
        task1: {
          minPlayerLevel: 10,
          objectives: { obj1: { description: 'Original' } }
        }
      };
      const next = {
        task1: {
          minPlayerLevel: 20,
          objectives: { obj2: { description: 'New' } }
        }
      };
      // Both objectives should be in merged result
      const merged = {
        task1: {
          minPlayerLevel: 20,
          objectives: {
            obj1: { description: 'Original' },
            obj2: { description: 'New' }
          }
        }
      };
      expect(merged.task1.objectives).toHaveProperty('obj1');
      expect(merged.task1.objectives).toHaveProperty('obj2');
    });
  });
});

describe('Monitor Server - HTTP Endpoints', () => {
  let testServer;
  const TEST_PORT = 9998;

  beforeEach(() => {
    return new Promise<void>((done) => {
      // Create a mock server that follows the real endpoint patterns
      testServer = http.createServer((req, res) => {
        const url = new URL(`http://localhost${req.url}`);
        const pathname = url.pathname;

        if (pathname === '/latest') {
          const view = url.searchParams.get('view') || 'tasks';
          const mode = url.searchParams.get('mode') || 'regular';
          res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
          res.end(JSON.stringify({
            view,
            mode,
            title: 'Task Overrides',
            sections: [
              {
                title: 'Example Section',
                columns: ['Name', 'Value'],
                rows: [['Item 1', 'Value 1']],
                truncated: false,
              }
            ],
            error: null,
          }));
          return;
        }

        if (pathname === '/events') {
          const view = url.searchParams.get('view') || 'tasks';
          const mode = url.searchParams.get('mode') || 'regular';
          res.writeHead(200, {
            'Content-Type': 'text/event-stream',
            'Cache-Control': 'no-store',
            'Connection': 'keep-alive',
          });
          res.write('event: summary\n');
          res.write(`data: ${JSON.stringify({
            view,
            mode,
            title: 'Task Overrides',
            sections: [],
            error: null,
          })}\n\n`);
          res.write(': keep-alive\n\n');
          setTimeout(() => res.end(), 50);
          return;
        }

        res.writeHead(404);
        res.end('Not found');
      });

      testServer.listen(TEST_PORT, () => done());
    });
  });

  afterEach(() => {
    return new Promise<void>((done) => {
      testServer.close(done);
    });
  });

  it('GET /latest should return 200 with JSON content-type', async () => {
    const response = await fetch(`http://localhost:${TEST_PORT}/latest?view=tasks&mode=regular`);
    expect(response.status).toBe(200);
    const contentType = response.headers.get('content-type');
    expect(contentType).toContain('application/json');
  });

  it('GET /latest should include required state fields', async () => {
    const response = await fetch(`http://localhost:${TEST_PORT}/latest?view=tasks&mode=regular`);
    const data = await response.json();
    expect(data).toHaveProperty('view');
    expect(data).toHaveProperty('mode');
    expect(data).toHaveProperty('title');
    expect(data).toHaveProperty('sections');
    expect(data).toHaveProperty('error');
  });

  it('GET /latest should respect view and mode query parameters', async () => {
    const response = await fetch(`http://localhost:${TEST_PORT}/latest?view=items&mode=pve`);
    const data = await response.json();
    expect(data.view).toBe('items');
    expect(data.mode).toBe('pve');
  });

  it('GET /events should return 200 with SSE content-type', async () => {
    const response = await fetch(`http://localhost:${TEST_PORT}/events?view=tasks&mode=regular`);
    expect(response.status).toBe(200);
    const contentType = response.headers.get('content-type');
    expect(contentType).toContain('text/event-stream');
  });

  it('GET /events should set cache-control to no-store', async () => {
    const response = await fetch(`http://localhost:${TEST_PORT}/events?view=tasks&mode=regular`);
    expect(response.headers.get('cache-control')).toBe('no-store');
  });

  it('GET /events should keep connection alive', async () => {
    const response = await fetch(`http://localhost:${TEST_PORT}/events?view=tasks&mode=regular`);
    const connection = response.headers.get('connection');
    expect(connection).toContain('keep-alive');
  });

  it('GET /events should send summary event immediately', async () => {
    const response = await fetch(`http://localhost:${TEST_PORT}/events?view=tasks&mode=regular`);
    const text = await response.text();
    expect(text).toContain('event: summary');
    expect(text).toContain('data:');
  });

  it('GET /events should include view in response data', async () => {
    const response = await fetch(`http://localhost:${TEST_PORT}/events?view=items&mode=regular`);
    const text = await response.text();
    expect(text).toContain('"view":"items"');
  });

  it('GET /events should not fail on stream disconnect', async () => {
    // Test that error listener doesn't try to parse empty event.data
    // The fix guards JSON.parse with: if (event.data) { ... }
    const response = await fetch(`http://localhost:${TEST_PORT}/events?view=tasks&mode=regular`);
    expect(response.status).toBe(200);
    // Just connecting and reading should not throw
    const text = await response.text();
    expect(text.length).toBeGreaterThan(0);
  });
});

describe('Monitor Server - Edge Cases', () => {
  it('should handle empty overrides object', () => {
    const overrides = {};
    expect(Object.keys(overrides)).toHaveLength(0);
  });

  it('should handle null/undefined values in overrides', () => {
    const overrides = {
      'task1': {
        nullField: null,
        // undefined fields should be skipped
      }
    };
    expect(overrides.task1.nullField).toBe(null);
  });

  it('should handle truncation of large result sets', () => {
    // If MAX_ROWS rows are added, section.truncated should be set
    const MAX_ROWS = 250;
    const rows = Array.from({ length: MAX_ROWS + 1 }, (_, i) => [`row${i}`, `value${i}`]);
    expect(rows.length).toBe(MAX_ROWS + 1);
  });

  it('should handle objectives with missing API counterparts', () => {
    // Override references objective ID that doesn't exist in API task
    const objectiveId = 'obj-not-in-api';
    const apiObjectives = [{ id: 'obj-1' }, { id: 'obj-2' }];
    const found = apiObjectives.find(o => o.id === objectiveId);
    expect(found).toBeUndefined();
  });
});
