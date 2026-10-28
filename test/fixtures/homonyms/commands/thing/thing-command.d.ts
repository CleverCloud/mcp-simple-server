import type { CcApiSimpleCommand } from "../../../client/lib.js";
import type { WithFirst } from "./first.js";
import type { WithSecond } from "./second.js";

/** Gets a thing whose params refer to two types of the same name. */
export declare class GetThingCommand extends CcApiSimpleCommand<WithFirst & WithSecond, string> {}
