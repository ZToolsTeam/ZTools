import { createDescriptor } from "./factory.js";
/**
 * Detail 详情组件
 */
export function Detail(props, ...children) {
    return createDescriptor("Detail", props, ...children);
}
const MetadataComponent = function DetailMetadata(props, ...children) {
    return createDescriptor("Detail.Metadata", props, ...children);
};
MetadataComponent.Label = function DetailMetadataLabel(props) {
    return createDescriptor("Detail.Metadata.Label", props);
};
const TagListComponent = function DetailMetadataTagList(props, ...children) {
    return createDescriptor("Detail.Metadata.TagList", props, ...children);
};
TagListComponent.Item = function DetailMetadataTagListItem(props) {
    return createDescriptor("Detail.Metadata.TagList.Item", props);
};
MetadataComponent.TagList = TagListComponent;
MetadataComponent.Separator = function DetailMetadataSeparator() {
    return createDescriptor("Detail.Metadata.Separator", {});
};
MetadataComponent.Link = function DetailMetadataLink(props) {
    return createDescriptor("Detail.Metadata.Link", props);
};
Detail.Metadata = MetadataComponent;
