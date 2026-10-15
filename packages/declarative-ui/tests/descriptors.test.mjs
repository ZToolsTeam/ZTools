import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  List,
  Detail,
  Form,
  ActionPanel,
  Action,
  Icon,
  Color,
  isViewDescriptor,
  VIEW_DESCRIPTOR_SYMBOL
} from "../dist/index.js";

describe("Raycast Declarative View Descriptors", () => {
  test("List & List.Item & List.Section & List.Dropdown should build correct view descriptor tree", () => {
    const dropdown = List.Dropdown({
      tooltip: "Filter Type",
      defaultValue: "all",
      onChange: (val) => console.log(val)
    }, [
      List.Dropdown.Item({ title: "All", value: "all" }),
      List.Dropdown.Item({ title: "Active", value: "active" })
    ]);

    const tree = List({
      isLoading: false,
      searchText: "test",
      searchBarPlaceholder: "Search items...",
      searchBarAccessory: dropdown
    }, [
      List.Section({ title: "Favorites" }, [
        List.Item({
          id: "item-1",
          title: "First Item",
          subtitle: "Quick description",
          icon: Icon.Document,
          accessories: [{ text: "Active" }],
          actions: ActionPanel({ title: "Item Actions" }, [
            Action.CopyToClipboard({ content: "First Item Content" }),
            Action.OpenInBrowser({ url: "https://example.com" })
          ])
        })
      ])
    ]);

    assert.equal(isViewDescriptor(tree), true);
    assert.equal(tree.$$typeof, VIEW_DESCRIPTOR_SYMBOL);
    assert.equal(tree.type, "List");
    assert.equal(tree.props.searchBarPlaceholder, "Search items...");
    assert.equal(tree.props.searchBarAccessory.type, "List.Dropdown");
    assert.equal(tree.children.length, 1);

    const section = tree.children[0];
    assert.equal(section.type, "List.Section");
    assert.equal(section.props.title, "Favorites");
    assert.equal(section.children.length, 1);

    const item = section.children[0];
    assert.equal(item.type, "List.Item");
    assert.equal(item.props.title, "First Item");
    assert.equal(item.props.icon, "document");
    assert.equal(item.props.actions.type, "ActionPanel");
    assert.equal(item.props.actions.children.length, 2);
    assert.equal(item.props.actions.children[0].type, "Action.CopyToClipboard");
    assert.equal(item.props.actions.children[0].props.content, "First Item Content");
    assert.equal(item.props.actions.children[1].type, "Action.OpenInBrowser");
    assert.equal(item.props.actions.children[1].props.url, "https://example.com");
  });

  test("Detail & Detail.Metadata should build correct markdown descriptor", () => {
    const detail = Detail({
      markdown: "# Title\n\nThis is detailed markdown content.",
      isLoading: false,
      metadata: Detail.Metadata({}, [
        Detail.Metadata.Label({ title: "Author", text: "ZTools Team", icon: Icon.Star }),
        Detail.Metadata.TagList({ title: "Tags" }, [
          Detail.Metadata.TagList.Item({ text: "TypeScript", color: Color.Blue })
        ]),
        Detail.Metadata.Separator(),
        Detail.Metadata.Link({ title: "Website", target: "https://ztools.dev", text: "ztools.dev" })
      ]),
      actions: ActionPanel({}, [
        Action({ title: "Custom Action", onAction: () => {} })
      ])
    });

    assert.equal(isViewDescriptor(detail), true);
    assert.equal(detail.type, "Detail");
    assert.match(detail.props.markdown, /# Title/);
    assert.equal(detail.props.metadata.type, "Detail.Metadata");
    assert.equal(detail.props.metadata.children.length, 4);
    assert.equal(detail.props.metadata.children[0].type, "Detail.Metadata.Label");
    assert.equal(detail.props.metadata.children[1].type, "Detail.Metadata.TagList");
    assert.equal(detail.props.metadata.children[2].type, "Detail.Metadata.Separator");
    assert.equal(detail.props.metadata.children[3].type, "Detail.Metadata.Link");
  });

  test("Form & all Form Fields should build correct form descriptor", () => {
    const form = Form({
      navigationTitle: "User Registration",
      isLoading: false,
      actions: ActionPanel({}, [
        Action.SubmitForm({ title: "Submit Details", onSubmit: (values) => {} })
      ])
    }, [
      Form.TextField({ id: "username", title: "Username", placeholder: "Enter username" }),
      Form.TextArea({ id: "bio", title: "Biography", placeholder: "Tell us about yourself" }),
      Form.Checkbox({ id: "agree", title: "Agreement", label: "I agree to the terms", defaultValue: true }),
      Form.Dropdown({ id: "role", title: "Role", defaultValue: "dev" }, [
        Form.Dropdown.Item({ title: "Developer", value: "dev" }),
        Form.Dropdown.Item({ title: "Designer", value: "designer" })
      ])
    ]);

    assert.equal(isViewDescriptor(form), true);
    assert.equal(form.type, "Form");
    assert.equal(form.props.navigationTitle, "User Registration");
    assert.equal(form.children.length, 4);

    const [field1, field2, field3, field4] = form.children;
    assert.equal(field1.type, "Form.TextField");
    assert.equal(field1.props.id, "username");
    assert.equal(field2.type, "Form.TextArea");
    assert.equal(field2.props.id, "bio");
    assert.equal(field3.type, "Form.Checkbox");
    assert.equal(field3.props.defaultValue, true);
    assert.equal(field4.type, "Form.Dropdown");
    assert.equal(field4.children.length, 2);
  });
});
