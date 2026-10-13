import {
  List,
  ActionPanel,
  Action,
  Icon,
  Color,
  showToast,
  Toast
} from "@ztools/raycast-compat";

export default function Command() {
  return List(
    {
      navigationTitle: "{{NAME}}",
      searchBarPlaceholder: "搜索项目或执行操作..."
    },
    [
      List.Section({ title: "快捷功能" }, [
        List.Item({
          id: "item-1",
          title: "欢迎使用 {{NAME}}",
          subtitle: "{{DESCRIPTION}}",
          icon: Icon.Star,
          accessories: [{ text: "就绪", icon: Icon.Check, color: Color.Green }],
          actions: ActionPanel({ title: "操作面板" }, [
            Action({
              title: "主要操作",
              icon: Icon.Check,
              onAction: async () => {
                await showToast(Toast.Style.Success, "操作已成功执行");
              }
            }),
            Action.CopyToClipboard({
              title: "复制插件信息",
              content: "{{NAME}} ({{ID}}): {{DESCRIPTION}}",
              icon: Icon.CopyClipboard
            })
          ])
        })
      ])
    ]
  );
}
