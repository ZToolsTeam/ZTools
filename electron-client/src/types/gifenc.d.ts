declare module 'gifenc' {
  export function quantize(rgba: Uint8Array, colors: number, options?: { format?: 'rgb565' }): number[][]
  export function applyPalette(rgba: Uint8Array, palette: number[][], format?: 'rgb565'): Uint8Array
  export function GIFEncoder(): { writeFrame(pixels: Uint8Array, width: number, height: number, options: { palette: number[][]; delay: number; repeat: number; dispose: number }): void; finish(): void; bytes(): Uint8Array; bytesView(): Uint8Array }
}
