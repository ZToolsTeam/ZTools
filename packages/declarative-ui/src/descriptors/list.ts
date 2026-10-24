import { createDescriptor } from "./factory.js";
import {
  ListProps,
  ListItemProps,
  ListSectionProps,
  ListDropdownProps,
  ListDropdownItemProps,
  ListDropdownSectionProps,
  ViewDescriptor
} from "./types.js";

import { Detail } from "./detail.js";

export interface ListDropdownComponent {
  (props?: ListDropdownProps, ...children: any[]): ViewDescriptor<ListDropdownProps>;
  Item: (props: ListDropdownItemProps) => ViewDescriptor<ListDropdownItemProps>;
  Section: (props?: ListDropdownSectionProps, ...children: any[]) => ViewDescriptor<ListDropdownSectionProps>;
}

export interface ListItemComponent {
  (props: ListItemProps): ViewDescriptor<ListItemProps>;
  Detail: any;
}

export interface ListComponent {
  (props?: ListProps, ...children: any[]): ViewDescriptor<ListProps>;
  Item: ListItemComponent;
  Section: (props?: ListSectionProps, ...children: any[]) => ViewDescriptor<ListSectionProps>;
  Dropdown: ListDropdownComponent;
}

const DropdownComponent: any = function ListDropdown(
  props?: ListDropdownProps,
  ...children: any[]
): ViewDescriptor<ListDropdownProps> {
  return createDescriptor("List.Dropdown", props, ...children);
};

DropdownComponent.Item = function ListDropdownItem(
  props: ListDropdownItemProps
): ViewDescriptor<ListDropdownItemProps> {
  return createDescriptor("List.Dropdown.Item", props);
};

DropdownComponent.Section = function ListDropdownSection(
  props?: ListDropdownSectionProps,
  ...children: any[]
): ViewDescriptor<ListDropdownSectionProps> {
  return createDescriptor("List.Dropdown.Section", props, ...children);
};

import { normalizeDistributionBarProps, normalizeFilterBarProps } from "./segmented.js";

/**
 * List 顶层列表容器
 */
export const List: ListComponent = function List(
  props?: ListProps,
  ...children: any[]
): ViewDescriptor<ListProps> {
  if (!props) {
    return createDescriptor("List", {} as ListProps, ...children);
  }
  const normalized: ListProps = { ...props };

  // 支持从 header 数组中自动提取 MetricGrid / DistributionBar / FilterBar / SegmentedControl
  if (Array.isArray(normalized.header)) {
    for (const node of normalized.header) {
      if (!node || typeof node !== "object") continue;
      if (node.type === "MetricGrid" && !normalized.metricGrid) {
        normalized.metricGrid = node;
      } else if (node.type === "DistributionBar" && !normalized.distributionBar) {
        normalized.distributionBar = node;
      } else if (node.type === "FilterBar" && !normalized.filterBar) {
        normalized.filterBar = node;
      } else if (node.type === "SegmentedControl" && !normalized.segmentedControl) {
        normalized.segmentedControl = node;
      }
    }
  }

  if (normalized.distributionBar && !(normalized.distributionBar as any).$$typeof) {
    normalized.distributionBar = normalizeDistributionBarProps(
      normalized.distributionBar as any
    );
  }
  if (normalized.filterBar && !(normalized.filterBar as any).$$typeof) {
    normalized.filterBar = normalizeFilterBarProps(normalized.filterBar as any);
  }

  return createDescriptor("List", normalized, ...children);
} as any;

const ListItemComponent: any = function ListItem(props: ListItemProps): ViewDescriptor<ListItemProps> {
  return createDescriptor("List.Item", props);
};

const ListItemDetailComponent: any = function ListItemDetail(
  props?: any,
  ...children: any[]
): ViewDescriptor<any> {
  return createDescriptor("List.Item.Detail", props, ...children);
};
ListItemDetailComponent.Metadata = Detail.Metadata;

ListItemComponent.Detail = ListItemDetailComponent;
List.Item = ListItemComponent;

List.Section = function ListSection(
  props?: ListSectionProps,
  ...children: any[]
): ViewDescriptor<ListSectionProps> {
  return createDescriptor("List.Section", props, ...children);
};

List.Dropdown = DropdownComponent;
