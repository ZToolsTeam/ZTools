import { IconResolvable } from "../constants/icons.js";
import { ColorResolvable } from "../constants/colors.js";

/**
 * 唯一的 Symbol 标识，用于运行时安全识别 ViewDescriptor 对象
 */
export const VIEW_DESCRIPTOR_SYMBOL = Symbol.for("ztools.declarative.descriptor");

export interface ViewDescriptor<TProps = Record<string, any>> {
  readonly $$typeof: symbol;
  readonly type: string;
  readonly props: TProps;
  readonly children: ReadonlyArray<ViewDescriptor | any>;
  readonly key?: string | number;
}

/**
 * 所有声明式组件 Props 的基础接口，支持 key 标识
 */
export interface BaseProps {
  key?: string | number | null;
}

// -------------------------------------------------------------
// Action 相关接口定义
// -------------------------------------------------------------
export interface KeyboardShortcut {
  modifiers: ("cmd" | "ctrl" | "opt" | "alt" | "shift")[];
  key: string;
}

export interface ActionProps extends BaseProps {
  title: string;
  icon?: IconResolvable;
  style?: "regular" | "destructive" | string | any;
  onAction?: () => void | Promise<void>;
  shortcut?: KeyboardShortcut;
}

export interface ActionCopyToClipboardProps extends BaseProps {
  title?: string;
  content: string | number;
  icon?: IconResolvable;
  shortcut?: KeyboardShortcut;
  onCopy?: () => void;
}

export interface ActionOpenInBrowserProps extends BaseProps {
  title?: string;
  url: string;
  icon?: IconResolvable;
  shortcut?: KeyboardShortcut;
}

export interface ActionPushProps extends BaseProps {
  title?: string;
  target: any; // 组件函数或 ViewDescriptor
  icon?: IconResolvable;
  shortcut?: KeyboardShortcut;
}

export interface ActionSubmitFormProps extends BaseProps {
  title?: string;
  icon?: IconResolvable;
  onSubmit?: (values: Record<string, any>) => void | Promise<void>;
  shortcut?: KeyboardShortcut;
}

export interface ActionPasteProps extends BaseProps {
  title?: string;
  content: string | number;
  icon?: IconResolvable;
  shortcut?: KeyboardShortcut;
}

export interface ActionOpenWithProps extends BaseProps {
  title?: string;
  path?: string;
  icon?: IconResolvable;
  shortcut?: KeyboardShortcut;
  application?: string;
}

export interface ActionShowInFinderProps extends BaseProps {
  title?: string;
  path: string;
  icon?: IconResolvable;
  shortcut?: KeyboardShortcut;
}

export interface ActionPanelProps extends BaseProps {
  title?: string;
  children?: any;
}

export interface ActionPanelSectionProps extends BaseProps {
  title?: string;
  children?: any;
}

export interface ActionPanelSubmenuProps extends BaseProps {
  title: string;
  icon?: IconResolvable;
  children?: any;
  shortcut?: KeyboardShortcut;
}

// -------------------------------------------------------------
// List 相关接口定义
// -------------------------------------------------------------
export interface ListItemAccessory {
  text?: string | { value: string; color?: ColorResolvable };
  icon?: IconResolvable;
  tooltip?: string;
  tag?: string | { value: string; color?: ColorResolvable };
  date?: Date;
}

export interface ListItemProps extends BaseProps {
  id?: string;
  title: string;
  subtitle?: string;
  icon?: IconResolvable;
  accessories?: ListItemAccessory[];
  keywords?: string[];
  checkable?: boolean;
  checked?: boolean | "indeterminate";
  onCheckChange?: (checked: boolean) => void;
  actions?: ViewDescriptor | any;
  detail?: ViewDescriptor | any;
}

export interface ListSectionProps extends BaseProps {
  title?: string;
  subtitle?: string;
  checkable?: boolean;
  checked?: boolean | "indeterminate";
  onCheckChange?: (checked?: any) => void;
  children?: any;
}

export interface ListDropdownItemProps extends BaseProps {
  title: string;
  value: string;
  icon?: IconResolvable;
}

export interface ListDropdownSectionProps extends BaseProps {
  title?: string;
  children?: any;
}

export interface ListDropdownProps extends BaseProps {
  tooltip?: string;
  value?: string;
  defaultValue?: string;
  onChange?: (newValue: string) => void;
  children?: any;
}

export interface DistributionBarSegment {
  id: string;
  label: string;
  valueText?: string;
  formattedSize?: string;
  formattedValue?: string;
  sizeBytes?: number;
  subLabel?: string;
  value?: number;
  percent?: number;
  color: string;
  count?: number;
}

export interface DistributionBarProps extends BaseProps {
  title?: string;
  totalText?: string;
  totalLabel?: string;
  totalValue?: number;
  activeId?: string;
  activeSegmentId?: string;
  segments: DistributionBarSegment[];
  onSelect?: (id: string) => void;
  onSelectSegment?: (segId: string | undefined) => void;
  onSegmentClick?: (segId: string) => void;
}

export interface FilterBarOption {
  value: string;
  label: string;
  badge?: string | number;
  count?: number;
}

export interface FilterBarGroup {
  id: string;
  label?: string;
  value: string;
  options: FilterBarOption[];
  onChange?: (value: string) => void;
}

export interface FilterBarAction {
  id: string;
  label?: string;
  title?: string;
  icon?: IconResolvable;
  style?: "primary" | "destructive" | "danger" | "secondary" | string;
  badge?: string | number;
  disabled?: boolean;
  onAction?: () => void;
}

export interface WizardStepItem {
  id?: string;
  step?: number;
  label: string;
  status: "done" | "active" | "pending" | string;
  onSelect?: () => void;
}

export interface FilterBarProps extends BaseProps {
  title?: string;
  wizardSteps?: WizardStepItem[];
  groups?: FilterBarGroup[];
  actions?: FilterBarAction[];
  summaryText?: string;
}

export type ViewNode = ViewDescriptor<any> | any;

export interface ListProps extends BaseProps {
  isLoading?: boolean;
  searchText?: string;
  searchBarPlaceholder?: string;
  onSearchTextChange?: (text: string) => void;
  navigationTitle?: string;
  isShowingDetail?: boolean;
  selectedItemId?: string;
  onSelectionChange?: (id: string | null) => void;
  searchBarAccessory?: ViewDescriptor | any;
  header?: ViewDescriptor[] | any;
  metricGrid?: ViewDescriptor | MetricGridProps | any;
  distributionBar?: DistributionBarProps | ViewDescriptor;
  segmentedControl?: ViewDescriptor | SegmentedControlProps | any;
  filterBar?: FilterBarProps | ViewDescriptor;
  actions?: ViewDescriptor | any;
  children?: any;
}

// -------------------------------------------------------------
// Detail 相关接口定义
// -------------------------------------------------------------
export interface DetailMetadataLabelProps extends BaseProps {
  title: string;
  text?: string;
  icon?: IconResolvable;
}

export interface DetailMetadataTagListItemProps extends BaseProps {
  text?: string;
  color?: ColorResolvable;
  icon?: IconResolvable;
}

export interface DetailMetadataTagListProps extends BaseProps {
  title: string;
  children?: any;
}

export interface DetailMetadataLinkProps extends BaseProps {
  title: string;
  target: string;
  text: string;
}

export interface DetailMetadataProps extends BaseProps {
  children?: any;
}

export interface DetailProps extends BaseProps {
  markdown?: string;
  navigationTitle?: string;
  isLoading?: boolean;
  actions?: ViewDescriptor | any;
  metadata?: ViewDescriptor | any;
}

// -------------------------------------------------------------
// Form 相关接口定义
// -------------------------------------------------------------
export interface FormTextFieldProps extends BaseProps {
  id: string;
  title?: string;
  placeholder?: string;
  defaultValue?: string;
  value?: string;
  onChange?: (val: string) => void;
  error?: string;
  info?: string;
  autoFocus?: boolean;
}

export interface FormTextAreaProps extends BaseProps {
  id: string;
  title?: string;
  placeholder?: string;
  defaultValue?: string;
  value?: string;
  onChange?: (val: string) => void;
  error?: string;
  info?: string;
}

export interface FormCheckboxProps extends BaseProps {
  id: string;
  title?: string;
  label: string;
  defaultValue?: boolean;
  value?: boolean;
  onChange?: (val: boolean) => void;
}

export interface FormDropdownItemProps extends BaseProps {
  title: string;
  value: string;
  icon?: IconResolvable;
}

export interface FormDropdownProps extends BaseProps {
  id: string;
  title?: string;
  defaultValue?: string;
  value?: string;
  onChange?: (val: string) => void;
  error?: string;
  info?: string;
  children?: any;
}

export interface FormDescriptionProps extends BaseProps {
  title?: string;
  text: string;
}

export interface FormPasswordFieldProps extends FormTextFieldProps {}

export interface MetricCardProps extends BaseProps {
  id?: string;
  label: string;
  value: string | number;
  subValue?: string;
  subtitle?: string;
  icon?: IconResolvable;
  progress?: number;
  trend?: "up" | "down" | "stable";
  status?: "normal" | "warning" | "danger" | "success";
  color?: ColorResolvable;
}

export interface MetricGridProps extends BaseProps {
  columns?: number;
  items?: MetricCardProps[];
  children?: any;
}

export interface SegmentedControlOption {
  value: string;
  label: string;
  icon?: IconResolvable;
  badge?: number | string;
}

export interface SegmentedControlProps extends BaseProps {
  value: string;
  options: SegmentedControlOption[];
  onChange?: (value: string) => void;
}

export interface FormProps extends BaseProps {
  navigationTitle?: string;
  isLoading?: boolean;
  actions?: ViewDescriptor | any;
  children?: any;
}

// -------------------------------------------------------------
// 全局 JSX 命名空间支持
// -------------------------------------------------------------
declare global {
  namespace JSX {
    interface Element extends ViewDescriptor<any> {}
    interface ElementClass {
      render(): any;
    }
    interface IntrinsicElements {
      [elemName: string]: any;
    }
    interface IntrinsicAttributes {
      key?: string | number | null;
    }
  }
}
