export interface CatalogParam {
  type: string;
  required: boolean;
  description?: string;
}

export interface CatalogEntry {
  className: string;
  category: string;
  description: string;
  endpoints: string[];
  isStream: boolean;
  params: Record<string, CatalogParam>;
  /** On top of the required params, at least one of these sets must be provided */
  requiredAnyOf?: string[][];
  /** Definitions of the named types the params refer to */
  types?: Record<string, string>;
}
