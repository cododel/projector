export interface TerminalWheelInput {
  deltaY: number;
  deltaMode: 0 | 1 | 2;
  altKey?: boolean;
  ctrlKey?: boolean;
  shiftKey?: boolean;
  deltaX?: number;
}

export interface TerminalWheelMetrics {
  rowHeight: number;
  rows: number;
  sensitivity: number;
  fastSensitivity: number;
}

export class TerminalWheelAccumulator {
  private queued = 0;
  private fraction = 0;
  private direction = 0;
  private metrics: TerminalWheelMetrics | undefined;

  get pending(): number {
    return this.queued;
  }

  reset(): void {
    this.queued = 0;
    this.fraction = 0;
    this.direction = 0;
    this.metrics = undefined;
  }

  update(input: TerminalWheelInput, metrics: TerminalWheelMetrics): number {
    if (
      !Number.isFinite(metrics.rowHeight) ||
      metrics.rowHeight <= 0 ||
      !Number.isSafeInteger(metrics.rows) ||
      metrics.rows <= 0 ||
      !Number.isFinite(metrics.sensitivity) ||
      metrics.sensitivity <= 0 ||
      !Number.isFinite(metrics.fastSensitivity) ||
      metrics.fastSensitivity <= 0
    ) {
      this.reset();
      return 0;
    }
    if (
      !this.metrics ||
      this.metrics.rowHeight !== metrics.rowHeight ||
      this.metrics.rows !== metrics.rows ||
      this.metrics.sensitivity !== metrics.sensitivity ||
      this.metrics.fastSensitivity !== metrics.fastSensitivity
    ) {
      this.reset();
      this.metrics = { ...metrics };
    }
    if (
      input.shiftKey ||
      (input.deltaX !== undefined && input.deltaX !== 0) ||
      !Number.isFinite(input.deltaY) ||
      ![0, 1, 2].includes(input.deltaMode) ||
      input.deltaY === 0
    )
      return 0;

    const direction = Math.sign(input.deltaY);
    if (this.direction !== 0 && direction !== this.direction) {
      this.queued = 0;
      this.fraction = 0;
    }
    this.direction = direction;
    const units =
      input.deltaMode === 0 ? 1 / metrics.rowHeight : input.deltaMode === 2 ? metrics.rows : 1;
    const speed =
      metrics.sensitivity * (input.altKey || input.ctrlKey ? metrics.fastSensitivity : 1);
    const capacity = 2 * metrics.rows;
    const lines = this.fraction + input.deltaY * units * speed;
    // Discard excess instead of retaining a large latent scroll after the queue drains.
    if (!Number.isFinite(lines) || Math.abs(lines) + Math.abs(this.queued) >= capacity) {
      this.queued = direction * capacity;
      this.fraction = 0;
      return this.queued;
    }
    const whole = Math.trunc(lines + direction * 1e-9);
    this.fraction = lines - whole;
    this.queued += whole;
    return this.queued;
  }

  take(max = 16): number {
    if (!Number.isFinite(max) || max <= 0) return 0;
    const count = Math.sign(this.queued) * Math.min(Math.abs(this.queued), Math.floor(max));
    this.queued -= count;
    return count;
  }
}
