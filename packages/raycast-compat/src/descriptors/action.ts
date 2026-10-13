import { createDescriptor } from "./factory.js";
import {
  ActionProps,
  ActionCopyToClipboardProps,
  ActionPasteProps,
  ActionOpenInBrowserProps,
  ActionOpenWithProps,
  ActionShowInFinderProps,
  ActionPushProps,
  ActionSubmitFormProps,
  ActionPanelProps,
  ActionPanelSectionProps,
  ActionPanelSubmenuProps,
  ViewDescriptor
} from "./types.js";

export interface ActionComponent {
  (props: ActionProps): ViewDescriptor<ActionProps>;
  CopyToClipboard: (props: ActionCopyToClipboardProps) => ViewDescriptor<ActionCopyToClipboardProps>;
  Paste: (props: ActionPasteProps) => ViewDescriptor<ActionPasteProps>;
  OpenInBrowser: (props: ActionOpenInBrowserProps) => ViewDescriptor<ActionOpenInBrowserProps>;
  OpenWith: (props: ActionOpenWithProps) => ViewDescriptor<ActionOpenWithProps>;
  ShowInFinder: (props: ActionShowInFinderProps) => ViewDescriptor<ActionShowInFinderProps>;
  Push: (props: ActionPushProps) => ViewDescriptor<ActionPushProps>;
  SubmitForm: (props: ActionSubmitFormProps) => ViewDescriptor<ActionSubmitFormProps>;
  Open: (props: any) => ViewDescriptor<any>;
}

export interface ActionPanelComponent {
  (props?: ActionPanelProps, ...children: any[]): ViewDescriptor<ActionPanelProps>;
  Section: (props?: ActionPanelSectionProps, ...children: any[]) => ViewDescriptor<ActionPanelSectionProps>;
  Submenu: (props: ActionPanelSubmenuProps, ...children: any[]) => ViewDescriptor<ActionPanelSubmenuProps>;
}

/**
 * Action 基础声明式组件
 */
export const Action: ActionComponent = function Action(props: ActionProps): ViewDescriptor<ActionProps> {
  return createDescriptor("Action", props);
} as any;

Action.CopyToClipboard = function CopyToClipboard(
  props: ActionCopyToClipboardProps
): ViewDescriptor<ActionCopyToClipboardProps> {
  return createDescriptor("Action.CopyToClipboard", props);
};

Action.Paste = function Paste(
  props: ActionPasteProps
): ViewDescriptor<ActionPasteProps> {
  return createDescriptor("Action.Paste", props);
};

Action.OpenInBrowser = function OpenInBrowser(
  props: ActionOpenInBrowserProps
): ViewDescriptor<ActionOpenInBrowserProps> {
  return createDescriptor("Action.OpenInBrowser", props);
};

Action.OpenWith = function OpenWith(
  props: ActionOpenWithProps
): ViewDescriptor<ActionOpenWithProps> {
  return createDescriptor("Action.OpenWith", props);
};

Action.ShowInFinder = function ShowInFinder(
  props: ActionShowInFinderProps
): ViewDescriptor<ActionShowInFinderProps> {
  return createDescriptor("Action.ShowInFinder", props);
};

Action.Push = function Push(
  props: ActionPushProps
): ViewDescriptor<ActionPushProps> {
  return createDescriptor("Action.Push", props);
};

Action.SubmitForm = function SubmitForm(
  props: ActionSubmitFormProps
): ViewDescriptor<ActionSubmitFormProps> {
  return createDescriptor("Action.SubmitForm", props);
};

Action.Open = function Open(props: any): ViewDescriptor<any> {
  return createDescriptor("Action.Open", props);
};

/**
 * ActionPanel 容器组件
 */
export const ActionPanel: ActionPanelComponent = function ActionPanel(
  props?: ActionPanelProps,
  ...children: any[]
): ViewDescriptor<ActionPanelProps> {
  return createDescriptor("ActionPanel", props, ...children);
} as any;

ActionPanel.Section = function ActionPanelSection(
  props?: ActionPanelSectionProps,
  ...children: any[]
): ViewDescriptor<ActionPanelSectionProps> {
  return createDescriptor("ActionPanel.Section", props, ...children);
};

ActionPanel.Submenu = function ActionPanelSubmenu(
  props: ActionPanelSubmenuProps,
  ...children: any[]
): ViewDescriptor<ActionPanelSubmenuProps> {
  return createDescriptor("ActionPanel.Submenu", props, ...children);
};
