export const DEFAULT_APPLICATION_LIFECYCLE_TIMEOUT_MS = 15_000

export type ApplicationLifecyclePhase =
  | 'idle'
  | 'starting'
  | 'running'
  | 'failed'
  | 'stopping'
  | 'stopped'

export type ApplicationStartup = (signal: AbortSignal) => void | Promise<void>
export type ApplicationCleanup = (signal: AbortSignal) => void | Promise<void>
export type ApplicationCleanupAction = () => void | Promise<void>

export class ApplicationLifecycleTimeoutError extends Error {
  constructor(
    readonly operation: 'startup-drain' | 'cleanup',
    readonly timeoutMs: number
  ) {
    super(`Application ${operation} exceeded ${timeoutMs}ms`)
    this.name = 'ApplicationLifecycleTimeoutError'
  }
}

function validateTimeout(timeoutMs: number): void {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0 || timeoutMs > 60_000) {
    throw new RangeError('Application lifecycle timeout must be an integer from 1 to 60000 ms')
  }
}

function withTimeout<T>(
  operation: Promise<T>,
  timeoutMs: number,
  timeoutOperation: ApplicationLifecycleTimeoutError['operation']
): Promise<T> {
  let timer: NodeJS.Timeout | undefined
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      reject(new ApplicationLifecycleTimeoutError(timeoutOperation, timeoutMs))
    }, timeoutMs)
  })
  return Promise.race([operation, timeout]).finally(() => {
    if (timer) clearTimeout(timer)
  })
}

function throwCollectedErrors(errors: unknown[], message: string): void {
  if (errors.length === 1) throw errors[0]
  if (errors.length > 1) throw new AggregateError(errors, message)
}

export async function runCleanupActions(
  actions: readonly ApplicationCleanupAction[],
  timeoutMs = DEFAULT_APPLICATION_LIFECYCLE_TIMEOUT_MS
): Promise<void> {
  validateTimeout(timeoutMs)
  const deadline = Date.now() + timeoutMs
  const errors: unknown[] = []
  let timeoutRecorded = false

  for (const action of actions) {
    let pending: Promise<void>
    try {
      pending = Promise.resolve(action())
    } catch (error) {
      errors.push(error)
      continue
    }

    const remainingMs = deadline - Date.now()
    if (remainingMs <= 0) {
      if (!timeoutRecorded) {
        errors.push(new ApplicationLifecycleTimeoutError('cleanup', timeoutMs))
        timeoutRecorded = true
      }
      void pending.catch(() => {})
      continue
    }

    try {
      await withTimeout(pending, remainingMs, 'cleanup')
    } catch (error) {
      errors.push(error)
      if (error instanceof ApplicationLifecycleTimeoutError) timeoutRecorded = true
    }
  }

  throwCollectedErrors(errors, 'Application cleanup failed')
}

export class ApplicationLifecycle {
  #phase: ApplicationLifecyclePhase = 'idle'
  #startupFailed = false
  #startupSettled: Promise<void> = Promise.resolve()
  #stopPromise: Promise<void> | null = null
  readonly #abortController = new AbortController()

  constructor(
    private readonly startupDrainTimeoutMs = DEFAULT_APPLICATION_LIFECYCLE_TIMEOUT_MS,
    private readonly cleanupTimeoutMs = DEFAULT_APPLICATION_LIFECYCLE_TIMEOUT_MS
  ) {
    validateTimeout(startupDrainTimeoutMs)
    validateTimeout(cleanupTimeoutMs)
  }

  get phase(): ApplicationLifecyclePhase {
    return this.#phase
  }

  get signal(): AbortSignal {
    return this.#abortController.signal
  }

  get cancellationRequested(): boolean {
    return this.signal.aborted
  }

  canContinueStartup(): boolean {
    return this.#phase === 'starting' && !this.signal.aborted
  }

  start(initialize: ApplicationStartup): Promise<void> | null {
    if (this.#phase !== 'idle') return null
    this.#phase = 'starting'

    const startup = Promise.resolve().then(async () => {
      if (!this.canContinueStartup()) return
      await initialize(this.signal)
    })
    this.#startupSettled = startup.then(
      () => undefined,
      () => { this.#startupFailed = true }
    )
    void startup.then(
      () => {
        if (this.#phase === 'starting') this.#phase = 'running'
      },
      () => {
        this.#startupFailed = true
        if (this.#phase === 'starting') this.#phase = 'failed'
      }
    )
    return startup
  }

  stop(cleanup: ApplicationCleanup): Promise<void> {
    if (this.#stopPromise) return this.#stopPromise
    this.#abortController.abort()
    this.#phase = 'stopping'
    this.#stopPromise = this.#performStop(cleanup)
    return this.#stopPromise
  }

  async #performStop(cleanup: ApplicationCleanup): Promise<void> {
    const errors: unknown[] = []
    try {
      await withTimeout(this.#startupSettled, this.startupDrainTimeoutMs, 'startup-drain')
    } catch (error) {
      errors.push(error)
    }

    try {
      await withTimeout(Promise.resolve().then(() => cleanup(this.signal)), this.cleanupTimeoutMs, 'cleanup')
    } catch (error) {
      errors.push(error)
    }

    if (errors.length > 0) {
      this.#phase = 'failed'
      throwCollectedErrors(errors, 'Application shutdown failed')
    }
    this.#phase = this.#startupFailed ? 'failed' : 'stopped'
  }
}
