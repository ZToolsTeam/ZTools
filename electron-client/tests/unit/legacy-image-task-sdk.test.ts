import path from 'node:path'

// Keep the source-only SDK checks executable while shared TypeScript output is locked.
require(path.resolve('tests/unit/legacy-image-task-sdk.test.cjs'))
