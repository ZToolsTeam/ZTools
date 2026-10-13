import { List } from "@raycast/api";

export default function Command() {
  // 包含 macOS 专有系统命令调用
  const script = "osascript -e 'tell application \"Finder\" to activate'";
  return <List searchBarPlaceholder={script} />;
}
