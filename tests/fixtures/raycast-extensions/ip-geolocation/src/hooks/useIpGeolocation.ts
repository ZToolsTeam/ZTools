import { useCachedPromise } from "@raycast/utils";

export async function mockFetchIpInfo(ip: string): Promise<[string, string][]> {
  const target = ip.trim() || "1.1.1.1";
  return [
    ["IP", target],
    ["Country", "United States"],
    ["Region", "California"],
    ["City", "San Jose"],
    ["ISP", "Cloudflare, Inc."],
    ["GeoCoordinates", "37.3382, -121.8863"],
    ["Timezone", "America/Los_Angeles"]
  ];
}

export function useIpGeolocation(searchContent: string) {
  return useCachedPromise(
    async (query: string) => {
      return mockFetchIpInfo(query);
    },
    [searchContent]
  );
}
