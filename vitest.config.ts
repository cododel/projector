// Test workers enable FORCE_COLOR; avoid the contradictory inherited Node flag.
delete process.env.NO_COLOR;
import { defineConfig } from 'vitest/config';
export default defineConfig({ test: { include: ['tests/*.test.ts'], setupFiles: ['tests/support/vitest-diagnostics.ts'] } });
