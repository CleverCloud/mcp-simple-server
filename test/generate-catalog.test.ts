import assert from "node:assert/strict";
import path from "node:path";
import { describe, test } from "node:test";

import { buildCatalog } from "../scripts/generate-catalog.ts";

const commandsOf = (fixture: string) => path.join(import.meta.dirname, "fixtures", fixture, "commands");

describe("buildCatalog", () => {
  const commands = buildCatalog(commandsOf("client"));
  const entry = (className: string) => {
    const command = commands.find((command) => command.entry.className === className);
    assert.ok(command, `${className} is missing from the catalog`);
    return command.entry;
  };

  test("lists the exported commands, without inner or abstract ones", () => {
    assert.deepEqual(commands.map(({ entry }) => entry.className).sort(), [
      "BoxThingCommand",
      "CreateThingCommand",
      "GetCurrentThingCommand",
      "GetThingCommand",
      "ListThingCommand",
      "PickThingCommand",
      "ReadThingCommand",
      "StreamThingCommand",
    ]);
    assert.ok(commands.every(({ modulePath }) => modulePath === "thing/thing-command.js"));
  });

  test("describes a command from its JSDoc and resolves aliased inputs", () => {
    assert.deepEqual(entry("GetThingCommand"), {
      className: "GetThingCommand",
      category: "thing",
      description: "Gets a thing.",
      endpoints: ["[GET] /v2/things/:XXX", "[GET] /v2/things/:XXX/details"],
      isStream: false,
      params: {
        applicationId: { type: "string", required: true },
        ownerId: { type: "string", required: false },
      },
    });
  });

  test("turns the variants of a union input into alternative required params", () => {
    const { params, requiredAnyOf } = entry("ReadThingCommand");
    assert.deepEqual(requiredAnyOf, [["applicationId"], ["addonId"]]);
    assert.equal(params.applicationId?.required, false);
    assert.deepEqual(params.verbose, {
      type: "boolean",
      required: false,
      description: "Whether to read everything.",
    });
  });

  test("keeps the params common to every variant required, and merges their descriptions", () => {
    const { params, requiredAnyOf } = entry("CreateThingCommand");
    assert.deepEqual(params.name, {
      type: "string",
      required: true,
      description: "Name of the thing. / Name of the company thing.",
    });
    assert.deepEqual(requiredAnyOf, [["config"], ["company", "vat"]]);
  });

  test("keeps only the minimal alternatives, a superset being satisfied by its subset", () => {
    assert.deepEqual(entry("PickThingCommand").requiredAnyOf, [["first"], ["third"]]);
  });

  test("renders nested types in full and defines the named types params refer to", () => {
    const { params, types } = entry("CreateThingCommand");
    assert.equal(params.config?.type, "{ production: { url: string; }; }");
    assert.equal(params.kind?.type, "ThingKind");
    assert.equal(params.variables?.type, "ThingVariable[]");
    assert.match(types?.ThingKind ?? "", /^"ALPHA_KIND" \| .* \| "ROMEO_KIND"$/);
    assert.equal(types?.ThingVariable, "{ name: string; value?: ThingValue; }");
    assert.equal(types?.ThingValue, "{ text: string; }");
  });

  test("names the type parameters of generic named types", () => {
    const { params, types } = entry("BoxThingCommand");
    assert.equal(params.box?.type, "Box<string>");
    assert.deepEqual(types, { "Box<T>": "{ value: T; }" });
  });

  test("requires nothing from inputs that can be void", () => {
    assert.deepEqual(entry("ListThingCommand").params, { tag: { type: "string", required: false } });
    assert.equal(entry("ListThingCommand").requiredAnyOf, undefined);
    assert.deepEqual(entry("GetCurrentThingCommand").params, {});
  });

  test("flags stream commands", () => {
    assert.equal(entry("StreamThingCommand").isStream, true);
  });

  test("fails on an input type that cannot be resolved", () => {
    assert.throws(
      () => buildCatalog(commandsOf("unresolved")),
      /GetThingCommand: The input type cannot be resolved/,
    );
  });

  test("fails on an input type that is not an object", () => {
    assert.throws(() => buildCatalog(commandsOf("unsupported")), /GetThingCommand: Unsupported input type: unknown/);
  });

  test("fails when two different types the params refer to share a name", () => {
    assert.throws(() => buildCatalog(commandsOf("homonyms")), /GetThingCommand: Two different types are named Target/);
  });
});
