import type { RecordingOperation } from "@jittle-lamp/shared";

type ActiveRecordingOperation = {
  operation: RecordingOperation;
  promise: Promise<unknown>;
};

export class RecordingLifecycle {
  private activeOperation: ActiveRecordingOperation | null = null;

  run<Result>(
    operation: RecordingOperation,
    task: () => Result | PromiseLike<Result>
  ): Promise<Result> {
    if (this.activeOperation) {
      if (this.activeOperation.operation === operation) {
        return this.activeOperation.promise as Promise<Result>;
      }

      return Promise.reject(
        new Error(
          `Cannot start recording operation "${operation}" while "${this.activeOperation.operation}" is active.`
        )
      );
    }

    const promise = Promise.resolve().then(task);
    const claimedOperation: ActiveRecordingOperation = {
      operation,
      promise
    };
    this.activeOperation = claimedOperation;

    void promise.then(
      () => this.release(claimedOperation),
      () => this.release(claimedOperation)
    );

    return promise;
  }

  current(): RecordingOperation | null {
    return this.activeOperation?.operation ?? null;
  }

  blocksCaptureIntake(): boolean {
    return this.activeOperation !== null;
  }

  resetForTests(): void {
    this.activeOperation = null;
  }

  private release(claimedOperation: ActiveRecordingOperation): void {
    if (this.activeOperation === claimedOperation) {
      this.activeOperation = null;
    }
  }
}
