import type { AddonId, ApplicationId, CcApiSimpleCommand, CcApiStreamCommand } from "../../lib.js";

// Long enough to be truncated by the default type rendering
export type ThingKind =
  | "ALPHA_KIND" | "BRAVO_KIND" | "CHARLIE_KIND" | "DELTA_KIND" | "ECHO_KIND" | "FOXTROT_KIND"
  | "GOLF_KIND" | "HOTEL_KIND" | "INDIA_KIND" | "JULIETT_KIND" | "KILO_KIND" | "LIMA_KIND"
  | "MIKE_KIND" | "NOVEMBER_KIND" | "OSCAR_KIND" | "PAPA_KIND" | "QUEBEC_KIND" | "ROMEO_KIND";

export interface ThingVariable {
  name: string;
  value?: ThingValue;
}

export type ThingValue = { text: string };

/**
 * Gets a thing.
 *
 * Details that are not part of the summary.
 *
 * @endpoint [GET] /v2/things/:XXX
 * @endpoint [GET] /v2/things/:XXX/details
 */
export declare class GetThingCommand extends CcApiSimpleCommand<ApplicationId, string> {}

export declare class GetThingInnerCommand extends CcApiSimpleCommand<ApplicationId, string> {}

/** Reads a thing of an application or of an add-on. */
export declare class ReadThingCommand extends CcApiSimpleCommand<
  (ApplicationId | AddonId) & {
    /** Whether to read everything. */
    verbose?: boolean;
  },
  string
> {}

/** Creates a thing. */
export declare class CreateThingCommand extends CcApiSimpleCommand<
  | {
      /** Name of the thing. */
      name: string;
      config: { production: { url: string } };
      kind?: ThingKind;
      variables?: ThingVariable[];
    }
  | {
      /** Name of the company thing. */
      name: string;
      company: string;
      vat: string;
    },
  void
> {}

export type ListThingInput = void | { tag?: string };

/** Lists things. */
export declare class ListThingCommand<
  T extends ListThingInput = ListThingInput,
> extends CcApiSimpleCommand<T, string[]> {}

/** Gets the current thing. */
export declare class GetCurrentThingCommand extends CcApiSimpleCommand<void, string> {}

/** Streams things. */
export declare class StreamThingCommand extends CcApiStreamCommand<ApplicationId, unknown> {}

/** Shares what every thing command does. */
export declare abstract class BaseThingCommand extends CcApiSimpleCommand<{ id: string }, void> {}

export interface Box<T> {
  value: T;
}

/** Stores a boxed thing. */
export declare class BoxThingCommand extends CcApiSimpleCommand<{ box: Box<string> }, void> {}

/** Picks a thing. */
export declare class PickThingCommand extends CcApiSimpleCommand<
  { first: string } | { first: string; second: string } | { third: string },
  string
> {}
