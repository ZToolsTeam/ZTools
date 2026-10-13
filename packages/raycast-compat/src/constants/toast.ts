/**
 * Raycast Toast Styles
 */
export enum ToastStyle {
  Success = "SUCCESS",
  Failure = "FAILURE",
  Animated = "ANIMATED"
}

export const Toast = {
  Style: ToastStyle
};

export interface ToastOptions {
  style: ToastStyle;
  title: string;
  message?: string;
  primaryAction?: {
    title: string;
    onAction: () => void;
  };
  secondaryAction?: {
    title: string;
    onAction: () => void;
  };
}
