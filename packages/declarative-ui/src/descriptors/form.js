import { createDescriptor } from "./factory.js";
/**
 * Form 表单声明式组件
 */
export function Form(props, ...children) {
    return createDescriptor("Form", props, ...children);
}
Form.TextField = function FormTextField(props) {
    return createDescriptor("Form.TextField", props);
};
Form.TextArea = function FormTextArea(props) {
    return createDescriptor("Form.TextArea", props);
};
Form.Checkbox = function FormCheckbox(props) {
    return createDescriptor("Form.Checkbox", props);
};
const DropdownComponent = function FormDropdown(props, ...children) {
    return createDescriptor("Form.Dropdown", props, ...children);
};
DropdownComponent.Item = function FormDropdownItem(props) {
    return createDescriptor("Form.Dropdown.Item", props);
};
Form.Dropdown = DropdownComponent;
