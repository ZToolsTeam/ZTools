export type WindowActionCategory =
  | "halves"
  | "thirds"
  | "quarters"
  | "sixths"
  | "center-max"
  | "displays"
  | "resize";

export interface WindowRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface WindowActionDefinition {
  id: string;
  name: string;
  category: WindowActionCategory;
  description: string;
  shortcut?: string;
  iconName: string;
  keywords?: string[];
}

export interface WindowManagementPreferences {
  innerGap: number;
  outerGap: number;
  cycleMode: "sizes" | "disabled";
  percentage: number;
}

export interface WindowFilterOptions {
  category?: WindowActionCategory | "all";
  query?: string;
}

export interface WindowActionResult {
  success: boolean;
  actionId: string;
  actionName: string;
  rect?: WindowRect;
  monitor?: WindowRect;
  error?: string;
}
