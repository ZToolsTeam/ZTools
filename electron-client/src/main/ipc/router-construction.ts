import { runCleanupActions, type ApplicationCleanupAction } from '../application-lifecycle.js'

/** Tracks resources acquired while the IPC router constructor is still synchronous. */
export class RouterConstructionScope {
  readonly #cleanupActions: ApplicationCleanupAction[] = []
  #state: 'open' | 'committed' | 'rolled-back' = 'open'

  own<T>(resource: T, cleanup: (resource: T) => void | Promise<void>): T {
    if (this.#state !== 'open') throw new Error('Router construction scope is closed')
    this.#cleanupActions.push(() => cleanup(resource))
    return resource
  }

  ownCleanup<T extends ApplicationCleanupAction>(cleanup: T): T {
    if (this.#state !== 'open') throw new Error('Router construction scope is closed')
    this.#cleanupActions.push(cleanup)
    return cleanup
  }

  commit(): void {
    if (this.#state !== 'open') throw new Error('Router construction scope is closed')
    this.#state = 'committed'
    this.#cleanupActions.length = 0
  }

  async rollback(constructionError: unknown): Promise<never> {
    if (this.#state !== 'open') throw new Error('Router construction scope is closed')
    this.#state = 'rolled-back'
    try {
      await runCleanupActions([...this.#cleanupActions].reverse())
    } catch (cleanupError) {
      throw new AggregateError(
        [constructionError, cleanupError],
        'IPC router construction and resource cleanup both failed'
      )
    }
    throw constructionError
  }
}

export async function constructWithRouterRollback<T>(
  construct: (scope: RouterConstructionScope) => T
): Promise<T> {
  const scope = new RouterConstructionScope()
  try {
    const result = construct(scope)
    scope.commit()
    return result
  } catch (constructionError) {
    return await scope.rollback(constructionError)
  }
}
