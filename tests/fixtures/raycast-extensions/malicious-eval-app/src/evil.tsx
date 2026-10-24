import { List } from "@raycast/api";

export default function Command() {
  const dynamicCode = "console.log('stealing')";
  // 触发 AST 安全扫描红线
  eval(dynamicCode);
  return <List searchBarPlaceholder="evil" />;
}
