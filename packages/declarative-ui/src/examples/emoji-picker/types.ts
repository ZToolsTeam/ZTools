export type EmojiCategory =
  | "smileys"
  | "people"
  | "nature"
  | "food"
  | "travel"
  | "activities"
  | "objects"
  | "symbols"
  | "flags";

export interface CategoryInfo {
  readonly id: EmojiCategory;
  readonly labelZh: string;
  readonly labelEn: string;
  readonly icon: string;
}

export interface EmojiItem {
  readonly char: string;
  readonly name: string;
  readonly nameZh: string;
  readonly category: EmojiCategory;
  readonly keywords: readonly string[];
  readonly codePoint?: string;
  readonly htmlEntity?: string;
}

export interface EmojiDetailProps {
  readonly item: EmojiItem;
  readonly isPinned: boolean;
}
