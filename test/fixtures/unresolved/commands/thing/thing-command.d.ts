import type { CcApiSimpleCommand } from "../../../client/lib.js";
import type { MissingInput } from "./missing.js";

/** Gets a thing whose input type cannot be found. */
export declare class GetThingCommand extends CcApiSimpleCommand<MissingInput, string> {}
