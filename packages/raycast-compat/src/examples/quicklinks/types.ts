export interface Quicklink {
  id: string;
  title: string;
  link: string;
  keyword?: string;
  description?: string;
  icon?: string;
  defaultArgument?: string;
  openCount?: number;
  createdAt: number;
  updatedAt: number;
}

export interface QuicklinkInput {
  title: string;
  link: string;
  keyword?: string;
  description?: string;
  defaultArgument?: string;
  icon?: string;
}

export interface QuicklinkResolved {
  url: string;
  hasQuery: boolean;
  queryParam?: string;
  needsArgument?: boolean;
}
