import { createDescriptor } from "./factory.js";
import {
  SegmentedControlProps,
  DistributionBarProps,
  FilterBarProps,
  ViewDescriptor
} from "./types.js";

export function SegmentedControl(
  props: SegmentedControlProps
): ViewDescriptor<SegmentedControlProps> {
  return createDescriptor("SegmentedControl", props);
}

export function normalizeDistributionBarProps(
  props: DistributionBarProps
): DistributionBarProps {
  const rawSegments = Array.isArray(props.segments) ? props.segments : [];
  const computedTotal =
    typeof props.totalValue === "number" && props.totalValue > 0
      ? props.totalValue
      : rawSegments.reduce(
          (acc, s: any) => acc + Number(s.value ?? s.valueBytes ?? s.sizeBytes ?? s.bytes ?? 0),
          0
        );

  const segments = rawSegments.map((seg: any) => {
    const rawVal = Number(seg.value ?? seg.valueBytes ?? seg.sizeBytes ?? seg.bytes ?? 0);
    const pct =
      typeof seg.percent === "number"
        ? Number(seg.percent.toFixed(1))
        : typeof seg.percentage === "number"
          ? Number(seg.percentage.toFixed(1))
          : computedTotal > 0
            ? Number(((rawVal / computedTotal) * 100).toFixed(1))
            : 0;
    return {
      ...seg,
      percent: pct,
      valueText: seg.valueText ?? seg.formattedSize ?? seg.formattedValue
    };
  });

  return {
    ...props,
    segments,
    onSelectSegment:
      props.onSelectSegment ??
      (props.onSegmentClick ? (segId) => props.onSegmentClick!(segId || "ALL") : undefined)
  };
}

export function DistributionBar(
  props: DistributionBarProps
): ViewDescriptor<DistributionBarProps> {
  return createDescriptor("DistributionBar", normalizeDistributionBarProps(props));
}

export function normalizeFilterBarProps(props: FilterBarProps): FilterBarProps {
  return {
    ...props,
    summaryText: props.summaryText ?? props.title,
    wizardSteps: Array.isArray(props.wizardSteps)
      ? props.wizardSteps.map((st, idx) => ({
          ...st,
          id: st.id ?? String(st.step ?? idx + 1)
        }))
      : undefined,
    groups: Array.isArray(props.groups)
      ? props.groups.map((g) => ({
          ...g,
          options: Array.isArray(g.options)
            ? g.options.map((opt) => ({
                ...opt,
                badge: opt.badge ?? opt.count
              }))
            : []
        }))
      : undefined,
    actions: Array.isArray(props.actions)
      ? props.actions.map((act) => ({
          ...act,
          label: act.label ?? act.title ?? act.id,
          style: act.style === "danger" ? "destructive" : act.style
        }))
      : undefined
  };
}

export function FilterBar(
  props: FilterBarProps
): ViewDescriptor<FilterBarProps> {
  return createDescriptor("FilterBar", normalizeFilterBarProps(props));
}
