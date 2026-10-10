import type { Reporter, TestCase, TestResult } from '@playwright/test/reporter';

export default class NoSkipsReporter implements Reporter {
  private skipped = 0;
  onTestEnd(_test: TestCase, result: TestResult) {
    if (result.status === 'skipped') this.skipped++;
  }
  async onEnd() {
    if (this.skipped) {
      console.error(`Full E2E rejected: ${this.skipped} skipped tests`);
      return { status: 'failed' as const };
    }
  }
}
