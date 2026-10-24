import { Action, ActionPanel, Icon, List, showToast, Toast } from "@raycast/api";
import { useState } from "react";
import { usePromise } from "@raycast/utils";

interface Story {
  id: string;
  title: string;
  creator: string;
  points: number;
  url: string;
}

const SAMPLE_STORIES: Story[] = [
  {
    id: "1",
    title: "Show HN: Modern Declarative UI Engine for ZTools",
    creator: "ztools_fan",
    points: 342,
    url: "https://news.ycombinator.com/item?id=1"
  },
  {
    id: "2",
    title: "DeepSeek R1 and Local AI Acceleration on Windows",
    creator: "ai_geek",
    points: 512,
    url: "https://news.ycombinator.com/item?id=2"
  },
  {
    id: "3",
    title: "Why Declarative Views Beat Unchecked DOM in Extension Hosts",
    creator: "arch_expert",
    points: 219,
    url: "https://news.ycombinator.com/item?id=3"
  }
];

export async function fetchStories(category: string): Promise<Story[]> {
  return SAMPLE_STORIES.filter(s => s.title.toLowerCase().includes(category === "all" ? "" : category));
}

export default function Command() {
  const [category, setCategory] = useState<string>("all");
  const { data, isLoading } = usePromise(fetchStories, [category]);

  const handleCopy = async (story: Story) => {
    await showToast({
      style: Toast.Style.Success,
      title: "Story Copied",
      message: story.title
    });
  };

  return (
    <List
      isLoading={isLoading}
      searchBarPlaceholder="Filter stories..."
      searchBarAccessory={
        <List.Dropdown tooltip="Category" onChange={(val) => setCategory(val)}>
          <List.Dropdown.Item title="All Stories" value="all" />
          <List.Dropdown.Item title="Show HN" value="show" />
          <List.Dropdown.Item title="AI" value="ai" />
        </List.Dropdown>
      }
    >
      {data?.map((story) => (
        <List.Item
          key={story.id}
          icon={Icon.Document}
          title={story.title}
          subtitle={`by ${story.creator}`}
          accessories={[{ text: `${story.points} pts` }]}
          actions={
            <ActionPanel title={story.title}>
              <Action.OpenInBrowser url={story.url} />
              <Action.CopyToClipboard
                title="Copy Story Link"
                content={story.url}
                shortcut={{ modifiers: ["cmd"], key: "." }}
              />
              <Action
                title="Copy and Notify"
                onAction={() => handleCopy(story)}
              />
            </ActionPanel>
          }
        />
      ))}
    </List>
  );
}
