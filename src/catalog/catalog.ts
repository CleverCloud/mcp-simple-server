export interface CatalogEntry {
  className: string;
  category: string;
  importSubpath: string;
  description: string;
  params: Record<string, string>;
  requiredParams: string[];
  endpoints: string[];
  isStream: boolean;
}
