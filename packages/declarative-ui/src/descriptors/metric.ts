import { createDescriptor } from "./factory.js";
import { MetricGridProps, MetricCardProps, ViewDescriptor } from "./types.js";

function normalizeMetricCard(item: MetricCardProps): MetricCardProps {
  return {
    ...item,
    subValue: item.subValue ?? item.subtitle
  };
}

export function MetricCard(props: MetricCardProps): ViewDescriptor<MetricCardProps> {
  return createDescriptor("MetricCard", normalizeMetricCard(props));
}

export function MetricGrid(
  props?: MetricGridProps,
  ...children: any[]
): ViewDescriptor<MetricGridProps> {
  const normalizedProps = props
    ? {
        ...props,
        items: Array.isArray(props.items) ? props.items.map(normalizeMetricCard) : props.items
      }
    : props;
  return createDescriptor("MetricGrid", normalizedProps, ...children);
}

(MetricGrid as any).Card = MetricCard;
