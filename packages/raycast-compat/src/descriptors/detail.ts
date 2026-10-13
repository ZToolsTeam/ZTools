import { createDescriptor } from "./factory.js";
import {
  DetailProps,
  DetailMetadataProps,
  DetailMetadataLabelProps,
  DetailMetadataTagListProps,
  DetailMetadataTagListItemProps,
  DetailMetadataLinkProps,
  ViewDescriptor
} from "./types.js";

/**
 * Detail 详情组件
 */
export function Detail(
  props?: DetailProps,
  ...children: any[]
): ViewDescriptor<DetailProps> {
  return createDescriptor("Detail", props, ...children);
}

const MetadataComponent = function DetailMetadata(
  props?: DetailMetadataProps,
  ...children: any[]
): ViewDescriptor<DetailMetadataProps> {
  return createDescriptor("Detail.Metadata", props, ...children);
};

MetadataComponent.Label = function DetailMetadataLabel(
  props: DetailMetadataLabelProps
): ViewDescriptor<DetailMetadataLabelProps> {
  return createDescriptor("Detail.Metadata.Label", props);
};

const TagListComponent = function DetailMetadataTagList(
  props: DetailMetadataTagListProps,
  ...children: any[]
): ViewDescriptor<DetailMetadataTagListProps> {
  return createDescriptor("Detail.Metadata.TagList", props, ...children);
};

TagListComponent.Item = function DetailMetadataTagListItem(
  props: DetailMetadataTagListItemProps
): ViewDescriptor<DetailMetadataTagListItemProps> {
  return createDescriptor("Detail.Metadata.TagList.Item", props);
};

MetadataComponent.TagList = TagListComponent;

MetadataComponent.Separator = function DetailMetadataSeparator(): ViewDescriptor {
  return createDescriptor("Detail.Metadata.Separator", {});
};

MetadataComponent.Link = function DetailMetadataLink(
  props: DetailMetadataLinkProps
): ViewDescriptor<DetailMetadataLinkProps> {
  return createDescriptor("Detail.Metadata.Link", props);
};

Detail.Metadata = MetadataComponent;
