import { normalizeScopedStorageKey } from './variable-keys.js';

/**
 * Which stored variables a script can read through its `variables` object.
 *
 * `buildScriptVariables` used to fetch the global variables and one value per
 * declared scoped variable (one HTTP call each) before every run, even for a
 * script that never touches `variables`. This reads the script text to find
 * out what it cites. Anything it cannot prove (a dynamic key, `variables`
 * passed around or enumerated, `eval`, a saved function called through `fn`)
 * falls back to loading everything, which is the previous behaviour.
 */
export type ScriptVariableNeeds =
  | { all: true }
  | {
      all: false;
      /** The script reads `variables` at all (globals are then loaded). */
      usesVariables: boolean;
      /** Storage keys cited as `variables.key` or `variables['key']`. */
      keys: Set<string>;
    };

const EVERYTHING: ScriptVariableNeeds = { all: true };

/** Code that can reach `variables` without the identifier appearing as such. */
const DYNAMIC_ACCESS =
  /\b(?:eval|Function|globalThis|Reflect|constructor|with)\b|\bfn\s*(?:\?\.|\.|\[)|\bimport\s*\(/;

const VARIABLES_IDENTIFIER = /(?<![\w$])variables(?![\w$])/g;

export function analyzeScriptVariableNeeds(script: string | undefined): ScriptVariableNeeds {
  if (typeof script !== 'string') {
    return EVERYTHING;
  }
  if (DYNAMIC_ACCESS.test(script)) {
    return EVERYTHING;
  }

  const keys = new Set<string>();
  let usesVariables = false;

  for (const match of script.matchAll(VARIABLES_IDENTIFIER)) {
    usesVariables = true;
    const rest = script.slice(match.index + match[0].length);

    // variables.key / variables?.key
    const dotted = /^\s*\??\.\s*([A-Za-z_$][\w$]*)/.exec(rest);
    if (dotted) {
      keys.add(normalizeScopedStorageKey(dotted[1]!));
      continue;
    }
    // variables['key'] / variables?.['key'] / variables["key"]
    const bracketed = /^\s*(?:\?\.\s*)?\[\s*(['"])([^'"\\\n]*)\1\s*\]/.exec(rest);
    if (bracketed) {
      keys.add(normalizeScopedStorageKey(bracketed[2]!));
      continue;
    }
    // Anything else: passed as a value, destructured, enumerated, computed key.
    return EVERYTHING;
  }

  return { all: false, usesVariables, keys };
}

/**
 * Whether a scoped definition has to be loaded for [needs]. Cited keys are
 * stored without their `bc_` prefix, so both spellings match.
 */
export function needsScopedDefinition(needs: ScriptVariableNeeds, storageKey: string): boolean {
  if (needs.all) {
    return true;
  }
  if (!needs.usesVariables) {
    return false;
  }
  const normalized = normalizeScopedStorageKey(storageKey);
  return needs.keys.has(normalized);
}
