declare module 'ini' {
  export function parse(text: string): Record<string, unknown>
  export function stringify(value: Record<string, unknown>, options?: { whitespace?: boolean; newline?: boolean }): string
}
