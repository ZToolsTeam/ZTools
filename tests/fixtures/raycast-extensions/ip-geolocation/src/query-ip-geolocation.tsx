import { Action, ActionPanel, List } from "@raycast/api";
import { useMemo, useState } from "react";
import { useIpGeolocation } from "./hooks/useIpGeolocation";

interface IpArgument {
  ipAddress?: string;
}

export default function QueryIpGeolocation(props: { arguments?: IpArgument }) {
  const ipAddress = props?.arguments?.ipAddress || "";
  const [searchContent, setSearchContent] = useState<string>(ipAddress.trim());
  const { data, isLoading } = useIpGeolocation(searchContent);

  const ipGeolocation = useMemo(() => {
    return data || [];
  }, [data]);

  return (
    <List
      isLoading={isLoading}
      searchBarPlaceholder="Query geolocation of IP or domain"
      searchText={searchContent}
      onSearchTextChange={setSearchContent}
      throttle={true}
    >
      {ipGeolocation.map((value, index) => (
        <List.Item
          key={index}
          title={value[0]}
          subtitle={value[1]}
          actions={
            <ActionPanel>
              <Action.CopyToClipboard title={`Copy ${value[0]}`} content={value[1]} />
              <Action.CopyToClipboard
                title="Copy All Info"
                content={JSON.stringify(Object.fromEntries(ipGeolocation), null, 2)}
              />
            </ActionPanel>
          }
        />
      ))}
    </List>
  );
}
