import { createDescriptor } from "./factory.js";
import {
  FormProps,
  FormTextFieldProps,
  FormTextAreaProps,
  FormCheckboxProps,
  FormDropdownProps,
  FormDropdownItemProps,
  FormDescriptionProps,
  FormPasswordFieldProps,
  ViewDescriptor
} from "./types.js";

export interface FormDropdownComponent {
  (props: FormDropdownProps, ...children: any[]): ViewDescriptor<FormDropdownProps>;
  Item: (props: FormDropdownItemProps) => ViewDescriptor<FormDropdownItemProps>;
}

export interface FormComponent {
  (props?: FormProps, ...children: any[]): ViewDescriptor<FormProps>;
  TextField: (props: FormTextFieldProps) => ViewDescriptor<FormTextFieldProps>;
  PasswordField: (props: FormPasswordFieldProps) => ViewDescriptor<FormPasswordFieldProps>;
  TextArea: (props: FormTextAreaProps) => ViewDescriptor<FormTextAreaProps>;
  Checkbox: (props: FormCheckboxProps) => ViewDescriptor<FormCheckboxProps>;
  Dropdown: FormDropdownComponent;
  Description: (props: FormDescriptionProps) => ViewDescriptor<FormDescriptionProps>;
}

const DropdownComponent: any = function FormDropdown(
  props: FormDropdownProps,
  ...children: any[]
): ViewDescriptor<FormDropdownProps> {
  return createDescriptor("Form.Dropdown", props, ...children);
};

DropdownComponent.Item = function FormDropdownItem(
  props: FormDropdownItemProps
): ViewDescriptor<FormDropdownItemProps> {
  return createDescriptor("Form.Dropdown.Item", props);
};

/**
 * Form 表单声明式组件
 */
export const Form: FormComponent = function Form(
  props?: FormProps,
  ...children: any[]
): ViewDescriptor<FormProps> {
  return createDescriptor("Form", props, ...children);
} as any;

Form.TextField = function FormTextField(
  props: FormTextFieldProps
): ViewDescriptor<FormTextFieldProps> {
  return createDescriptor("Form.TextField", props);
};

Form.PasswordField = function FormPasswordField(
  props: FormPasswordFieldProps
): ViewDescriptor<FormPasswordFieldProps> {
  return createDescriptor("Form.PasswordField", props);
};

Form.TextArea = function FormTextArea(
  props: FormTextAreaProps
): ViewDescriptor<FormTextAreaProps> {
  return createDescriptor("Form.TextArea", props);
};

Form.Checkbox = function FormCheckbox(
  props: FormCheckboxProps
): ViewDescriptor<FormCheckboxProps> {
  return createDescriptor("Form.Checkbox", props);
};

Form.Dropdown = DropdownComponent;

Form.Description = function FormDescription(
  props: FormDescriptionProps
): ViewDescriptor<FormDescriptionProps> {
  return createDescriptor("Form.Description", props);
};
