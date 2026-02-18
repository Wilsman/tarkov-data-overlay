/**
 * Tests for scripts/validate.ts helpers
 */

import { describe, expect, it } from 'vitest';
import { join } from 'path';
import {
  getProjectPaths,
  listJson5Files,
  SCHEMA_CONFIGS,
} from '../src/lib/index.js';
import {
  getValidator,
  initializeValidators,
  validateSourceFiles,
} from '../scripts/validate.ts';

describe('scripts/validate helpers', () => {
  it('initializes validators for configured schema patterns', () => {
    const validators = initializeValidators();

    for (const config of SCHEMA_CONFIGS) {
      expect(getValidator(config.pattern, validators)).not.toBeNull();
    }
    expect(getValidator('unknown.json5', validators)).toBeNull();
  });

  it('validates all source files used by overlay data', () => {
    const { srcDir } = getProjectPaths();
    const expectedFiles = [
      ...listJson5Files(join(srcDir, 'overrides')).map((file) => `overrides/${file}`),
      ...listJson5Files(join(srcDir, 'additions')).map((file) => `additions/${file}`),
      ...['regular', 'pve'].flatMap((mode) => [
        ...listJson5Files(join(srcDir, 'overrides', 'modes', mode)).map(
          (file) => `overrides/modes/${mode}/${file}`
        ),
        ...listJson5Files(join(srcDir, 'additions', 'modes', mode)).map(
          (file) => `additions/modes/${mode}/${file}`
        ),
      ]),
    ].sort();

    const results = validateSourceFiles();
    const files = results.map((result) => result.file).sort();

    expect(files).toEqual(expectedFiles);
    expect(results.every((result) => result.valid)).toBe(true);
  });
});
