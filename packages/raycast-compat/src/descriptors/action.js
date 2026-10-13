import { createDescriptor } from "./factory.js";
/**
 * Action 基础声明式组件
 */
export function Action(props) {
    return createDescriptor("Action", props);
}
Action.CopyToClipboard = function CopyToClipboard(props) {
    return createDescriptor("Action.CopyToClipboard", props);
};
Action.Paste = function Paste(props) {
    return createDescriptor("Action.Paste", props);
};
Action.OpenInBrowser = function OpenInBrowser(props) {
    return createDescriptor("Action.OpenInBrowser", props);
};
Action.OpenWith = function OpenWith(props) {
    return createDescriptor("Action.OpenWith", props);
};
Action.ShowInFinder = function ShowInFinder(props) {
    return createDescriptor("Action.ShowInFinder", props);
};
Action.Push = function Push(props) {
    return createDescriptor("Action.Push", props);
};
Action.SubmitForm = function SubmitForm(props) {
    return createDescriptor("Action.SubmitForm", props);
};
/**
 * ActionPanel 容器组件
 */
export function ActionPanel(props, ...children) {
    return createDescriptor("ActionPanel", props, ...children);
}
ActionPanel.Section = function ActionPanelSection(props, ...children) {
    return createDescriptor("ActionPanel.Section", props, ...children);
};
ActionPanel.Submenu = function ActionPanelSubmenu(props, ...children) {
    return createDescriptor("ActionPanel.Submenu", props, ...children);
};
