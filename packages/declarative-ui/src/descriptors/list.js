import { createDescriptor } from "./factory.js";
/**
 * List 顶层列表容器
 */
export function List(props, ...children) {
    return createDescriptor("List", props, ...children);
}
import { Detail } from "./detail.js";

const ListItemComponent = function ListItem(props) {
    return createDescriptor("List.Item", props);
};

const ListItemDetailComponent = function ListItemDetail(props, ...children) {
    return createDescriptor("List.Item.Detail", props, ...children);
};
ListItemDetailComponent.Metadata = Detail.Metadata;

ListItemComponent.Detail = ListItemDetailComponent;
List.Item = ListItemComponent;
List.Section = function ListSection(props, ...children) {
    return createDescriptor("List.Section", props, ...children);
};
/**
 * List.Dropdown 下拉筛选器
 */
const DropdownComponent = function ListDropdown(props, ...children) {
    return createDescriptor("List.Dropdown", props, ...children);
};
DropdownComponent.Item = function ListDropdownItem(props) {
    return createDescriptor("List.Dropdown.Item", props);
};
DropdownComponent.Section = function ListDropdownSection(props, ...children) {
    return createDescriptor("List.Dropdown.Section", props, ...children);
};
List.Dropdown = DropdownComponent;
