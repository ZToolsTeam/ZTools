/**
 * Raycast Color 兼容定义
 */
export enum Color {
  Red = "rgb(255, 69, 58)",
  Orange = "rgb(255, 159, 10)",
  Yellow = "rgb(255, 214, 10)",
  Green = "rgb(48, 209, 88)",
  Blue = "rgb(10, 132, 255)",
  Purple = "rgb(191, 90, 242)",
  Magenta = "rgb(255, 55, 95)",
  PrimaryText = "rgba(255, 255, 255, 0.95)",
  SecondaryText = "rgba(255, 255, 255, 0.60)"
}

export type ColorResolvable = Color | string;
