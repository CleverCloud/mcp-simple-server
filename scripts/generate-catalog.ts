import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { API, NodeBuilderFlags, SignatureKind, SymbolFlags, TypeFlags } from "typescript/unstable/sync";
import type { Project, Symbol, Type, TypeReference } from "typescript/unstable/sync";

import type { CatalogEntry, CatalogParam } from "../src/catalog/catalog.ts";

const COMMANDS_DIR = path.resolve("node_modules/@clevercloud/client/dist/src/clients/cc-api/commands");
const CATALOG_OUT = path.resolve("src/catalog/command-catalog.json");
const REGISTRY_OUT = path.resolve("src/commands/command-registry.ts");

export interface GeneratedCommand {
  entry: CatalogEntry;
  /** Path of the command's module, relative to the commands directory */
  modulePath: string;
}

interface NamedType {
  symbolId: number;
  /** The name, with its type parameters if any */
  label: string;
  definition: string;
}

/**
 * Builds the catalog from the client's type declarations. Command inputs are
 * declared as interfaces, aliases, unions, intersections and generics, so they
 * are resolved by the TypeScript checker rather than parsed by hand.
 *
 * @param commandsDir holds one directory per category, of `*-command.d.ts` files
 */
export function buildCatalog(commandsDir: string): GeneratedCommand[] {
  const modulePaths = fs
    .readdirSync(commandsDir)
    .sort()
    .flatMap((category) =>
      fs
        .readdirSync(path.join(commandsDir, category))
        .filter((file) => file.endsWith("-command.d.ts") && !file.startsWith("abstract-"))
        .sort()
        .map((file) => `${category}/${file}`),
    );

  return withProject(
    modulePaths.map((modulePath) => path.join(commandsDir, modulePath)),
    (project) => {
      const { program, checker } = project;
      const commands: GeneratedCommand[] = [];
      for (const modulePath of modulePaths) {
        const file = path.join(commandsDir, modulePath);
        const sourceFile = program.getSourceFile(file);
        const moduleSymbol = sourceFile && checker.getSymbolAtLocation(sourceFile);
        if (!moduleSymbol) throw new Error(`Cannot load ${file}`);

        const commandSymbols = checker
          .getExportsOfModule(moduleSymbol)
          .filter(
            (symbol) =>
              symbol.flags & SymbolFlags.Class &&
              symbol.name.endsWith("Command") &&
              !symbol.name.includes("Inner") &&
              !isAbstract(project, symbol),
          );
        if (commandSymbols.length === 0) throw new Error(`No command class exported by ${file}`);

        const [category] = modulePath.split("/");
        for (const symbol of commandSymbols) {
          if (commands.some(({ entry }) => entry.className === symbol.name)) {
            throw new Error(`${symbol.name} is exported by several modules`);
          }
          try {
            commands.push({
              entry: describeCommand(project, symbol, category!),
              modulePath: modulePath.replace(/\.d\.ts$/, ".js"),
            });
          } catch (error) {
            throw new Error(`${symbol.name}: ${(error as Error).message}`, { cause: error });
          }
        }
      }

      const truncated = JSON.stringify(commands).match(/\.\.\. \d+ more \.\.\./);
      if (truncated) throw new Error(`A type was rendered truncated: "${truncated[0]}"`);
      return commands;
    },
  );
}

function withProject<T>(files: string[], use: (project: Project) => T): T {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "generate-catalog-"));
  let api: API | undefined;
  try {
    const tsconfig = path.join(tmpDir, "tsconfig.json");
    fs.writeFileSync(
      tsconfig,
      JSON.stringify({ compilerOptions: { module: "nodenext", strict: true, types: [] }, files }),
    );
    api = new API({ cwd: tmpDir });
    const project = api.updateSnapshot({ openProjects: [tsconfig] }).getProject(tsconfig);
    if (!project) throw new Error("Cannot open the TypeScript project of the client declarations");
    return use(project);
  } finally {
    api?.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

function isAbstract({ checker }: Project, classSymbol: Symbol): boolean {
  const constructorType = checker.getTypeOfSymbol(classSymbol);
  return (
    constructorType !== undefined &&
    checker.getSignaturesOfType(constructorType, SignatureKind.Construct).some((signature) => signature.isAbstract)
  );
}

function describeCommand(project: Project, symbol: Symbol, category: string): CatalogEntry {
  const { checker } = project;
  // The input type is the first type argument of the base command class, or the
  // constraint of the class's own type parameter when it forwards one
  const classType = checker.getDeclaredTypeOfSymbol(symbol);
  const [baseType] = classType.isClassOrInterface() ? checker.getBaseTypes(classType) : [];
  const [inputArgument] = baseType ? checker.getTypeArguments(baseType as TypeReference) : [];
  const inputType = inputArgument?.isTypeParameter()
    ? checker.getConstraintOfTypeParameter(inputArgument)
    : inputArgument;
  if (!baseType || !inputType) throw new Error("Cannot find the input type");

  return {
    className: symbol.name,
    category,
    // The first paragraph is the summary, the next ones are details
    description: normalize(symbol.getDocumentationComment(checker).split(/\n\s*\n/)[0]),
    endpoints: symbol
      .getJsDocTags(checker)
      .filter((tag) => tag.name === "endpoint")
      .map((tag) => normalize(tag.text)),
    isStream: /Stream/.test(baseType.getSymbol()?.name ?? ""),
    ...describeInput(project, inputType),
  };
}

function describeInput(
  project: Project,
  inputType: Type,
): Pick<CatalogEntry, "params" | "requiredAnyOf" | "types"> {
  const { checker } = project;
  if (inputType.isErrorType()) throw new Error("The input type cannot be resolved");

  // A union only exposes its common properties: describe every variant instead.
  // A `void` variant means the command can also be called without params.
  const variants = inputType.isUnionType() ? (inputType.getTypes() ?? []) : [inputType];
  const isVoid = (type: Type) => (type.flags & (TypeFlags.Void | TypeFlags.Undefined)) !== 0;
  const objectVariants = variants.filter((variant) => !isVoid(variant));
  const callableWithoutParams = objectVariants.length < variants.length;
  for (const variant of objectVariants) {
    if (!variant.isObjectType() && !variant.isIntersectionType()) {
      throw new Error(`Unsupported input type: ${checker.typeToString(variant)}`);
    }
  }

  const found = new Map<string, { types: Set<string>; descriptions: Set<string> }>();
  const types = new Map<string, NamedType>();
  const requiredByVariant = objectVariants.map((variant) => {
    const required = new Set<string>();
    for (const prop of checker.getPropertiesOfType(variant)) {
      if (!isOptional(prop)) required.add(prop.name);

      const param = found.get(prop.name) ?? { types: new Set(), descriptions: new Set() };
      found.set(prop.name, param);
      const rendered = renderPropType(project, prop);
      param.types.add(rendered);
      const description = normalize(prop.getDocumentationComment(checker));
      if (description) param.descriptions.add(description);

      defineNamedTypes(project, rendered, declarationFile(prop), types);
    }
    return required;
  });

  const commonRequired = callableWithoutParams
    ? new Set<string>()
    : requiredByVariant.reduce((common, required) => common.intersection(required));
  const params: Record<string, CatalogParam> = {};
  for (const [name, param] of found) {
    params[name] = {
      type: [...param.types].join(" | "),
      required: commonRequired.has(name),
      ...(param.descriptions.size > 0 && { description: [...param.descriptions].join(" / ") }),
    };
  }

  const requiredAnyOf = callableWithoutParams
    ? []
    : minimalSets(requiredByVariant.map((required) => required.difference(commonRequired)));
  return {
    params,
    ...(requiredAnyOf.length > 0 && { requiredAnyOf: requiredAnyOf.map((set) => [...set]) }),
    ...(types.size > 0 && {
      types: Object.fromEntries([...types.values()].map(({ label, definition }) => [label, definition])),
    }),
  };
}

/**
 * Reduces the param sets the variants require on top of the common ones to the
 * minimal alternatives. None is left when a variant requires nothing more.
 */
function minimalSets(sets: Set<string>[]): Set<string>[] {
  if (sets.some((set) => set.size === 0)) return [];
  const minimal: Set<string>[] = [];
  for (const set of sets.toSorted((a, b) => a.size - b.size)) {
    if (!minimal.some((kept) => kept.isSubsetOf(set))) minimal.push(set);
  }
  return minimal;
}

/**
 * Adds to `types` the definitions of the PascalCase type names a rendered type
 * mentions, then of the names those definitions mention, and so on. Names are
 * resolved from the file the rendered type comes from; the TypeScript lib
 * types, like `Record`, are left out.
 */
function defineNamedTypes(project: Project, rendered: string, file: string, types: Map<string, NamedType>): void {
  const { program, checker } = project;
  const withoutStringLiterals = rendered.replace(/"(?:[^"\\]|\\.)*"/g, "");
  for (const [name] of withoutStringLiterals.matchAll(/\b[A-Z]\w*/g)) {
    const symbol = checker.resolveName(name, SymbolFlags.Type, { document: file, position: 0 });
    const declared = symbol && symbol.flags & SymbolFlags.Alias ? checker.getAliasedSymbol(symbol) : symbol;
    const isLibType = declared?.declarations.some(
      (declaration) => program.getSourceFileMetadataByPath(declaration.path)?.isDefaultLibrary,
    );
    if (!declared || isLibType) continue;

    const known = types.get(name);
    if (known) {
      if (known.symbolId !== declared.id) throw new Error(`Two different types are named ${name}`);
      continue;
    }

    const type = checker.getDeclaredTypeOfSymbol(declared);
    const isAlias = (declared.flags & SymbolFlags.TypeAlias) !== 0;
    const typeParameters = isAlias
      ? type.getAliasTypeArguments()
      : type.isClassOrInterface()
        ? type.getTypeParameters()
        : [];
    const definition = isAlias
      ? checker.typeToString(type, undefined, NodeBuilderFlags.NoTruncation | NodeBuilderFlags.InTypeAlias)
      : `{ ${checker
          .getPropertiesOfType(type)
          .map((prop) => `${prop.name}${isOptional(prop) ? "?" : ""}: ${renderPropType(project, prop)};`)
          .join(" ")} }`;
    types.set(name, {
      symbolId: declared.id,
      label: typeParameters.length > 0
        ? `${name}<${typeParameters.map((parameter) => checker.typeToString(parameter)).join(", ")}>`
        : name,
      definition,
    });
    defineNamedTypes(project, definition, declarationFile(declared), types);
  }
}

/** Renders the type of a property; when optional, its `| undefined` is left out */
function renderPropType({ checker }: Project, prop: Symbol): string {
  const type = checker.getTypeOfSymbol(prop);
  if (!type || type.isErrorType()) throw new Error(`The type of ${prop.name} cannot be resolved`);
  const rendered = checker.typeToString(type, undefined, NodeBuilderFlags.NoTruncation);
  return isOptional(prop) ? rendered.replace(/ \| undefined$/, "") : rendered;
}

function isOptional(prop: Symbol): boolean {
  return (prop.flags & SymbolFlags.Optional) !== 0;
}

function declarationFile(symbol: Symbol): string {
  const [declaration] = symbol.declarations;
  if (!declaration) throw new Error(`${symbol.name} has no declaration`);
  return declaration.path;
}

function normalize(text: string | undefined): string {
  return (text ?? "").replace(/\s+/g, " ").trim();
}

function main() {
  const commands = buildCatalog(COMMANDS_DIR);

  const catalog = commands.map(({ entry }) => entry);
  fs.writeFileSync(CATALOG_OUT, `${JSON.stringify(catalog, null, 2)}\n`);
  console.log(`Generated catalog: ${commands.length} commands -> ${CATALOG_OUT}`);

  const imports = commands.map(
    ({ entry, modulePath }) =>
      `import { ${entry.className} } from "@clevercloud/client/cc-api-commands/${modulePath}";`,
  );
  const entries = commands.map(({ entry }) => `  ${entry.className},`);
  fs.writeFileSync(
    REGISTRY_OUT,
    `// Generated by scripts/generate-catalog.ts — do not edit manually
${imports.join("\n")}

export const commands: Record<string, new (params?: any) => any> = {
${entries.join("\n")}
};
`,
  );
  console.log(`Generated registry: ${commands.length} commands -> ${REGISTRY_OUT}`);
}

if (import.meta.main) main();
