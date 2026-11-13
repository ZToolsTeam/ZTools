export function readTestConcurrency(environment = process.env) {
  const value = environment.ZTOOLS_TEST_CONCURRENCY ?? '1'
  if (!/^(?:[1-9]|[12][0-9]|3[0-2])$/.test(value)) {
    throw new Error('ZTOOLS_TEST_CONCURRENCY 必须为 1..32 的整数；资源诊断请使用 1')
  }
  return Number(value)
}
