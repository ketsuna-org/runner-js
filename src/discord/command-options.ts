import type { APIApplicationCommandOption, AutocompleteInteraction } from 'discord.js';

export interface AutocompleteBinding {
  commandName: string;
  optionPath: string[];
  optionName: string;
  config: Record<string, unknown>;
}

const OPTION_TYPE_MAP: Record<string, number> = {
  subcommand: 1,
  subcommandgroup: 2,
  string: 3,
  integer: 4,
  boolean: 5,
  user: 6,
  channel: 7,
  role: 8,
  mentionable: 9,
  number: 10,
  attachment: 11,
};

export function transformCommandOptionsForDiscord(
  options: Array<Record<string, unknown>>,
): APIApplicationCommandOption[] {
  return options.map((option) => transformCommandOption(option));
}

export function collectAutocompleteBindings(
  commandName: string,
  options: Array<Record<string, unknown>>,
  optionPath: string[] = [],
): AutocompleteBinding[] {
  const bindings: AutocompleteBinding[] = [];

  for (const option of options) {
    const type = normalizeOptionType(option.type);
    const name = String(option.name ?? '').trim();
    if (!name) {
      continue;
    }

    if (type === 1 || type === 2) {
      const nested = option.options;
      if (Array.isArray(nested)) {
        bindings.push(
          ...collectAutocompleteBindings(
            commandName,
            nested.filter((entry): entry is Record<string, unknown> => typeof entry === 'object' && entry !== null),
            [...optionPath, name],
          ),
        );
      }
      continue;
    }

    const autocomplete = readAutocompleteConfig(option);
    if (!autocomplete) {
      continue;
    }

    bindings.push({
      commandName,
      optionPath,
      optionName: name,
      config: autocomplete,
    });
  }

  return bindings;
}

export function findAutocompleteBinding(
  commandName: string,
  optionPath: string[],
  optionName: string,
  bindings: AutocompleteBinding[],
): AutocompleteBinding | undefined {
  return bindings.find(
    (binding) =>
      binding.commandName === commandName &&
      binding.optionName === optionName &&
      pathsEqual(binding.optionPath, optionPath),
  );
}

export function resolveInteractionOptionPath(
  interaction: AutocompleteInteraction,
): string[] {
  const path: string[] = [];
  const group = interaction.options.getSubcommandGroup(false);
  if (group) {
    path.push(group);
  }
  const subcommand = interaction.options.getSubcommand(false);
  if (subcommand) {
    path.push(subcommand);
  }
  return path;
}

export function filterStaticAutocompleteChoices(
  config: Record<string, unknown>,
  query: string,
): Array<{ name: string; value: string }> {
  const rawChoices = config.staticChoices;
  if (!Array.isArray(rawChoices)) {
    return [];
  }

  const normalizedQuery = query.trim().toLowerCase();
  const results: Array<{ name: string; value: string }> = [];

  for (const raw of rawChoices) {
    if (typeof raw !== 'object' || raw === null) {
      continue;
    }
    const choice = raw as Record<string, unknown>;
    const name = String(choice.name ?? choice.label ?? '').trim();
    const value = String(choice.value ?? choice.name ?? '').trim();
    if (!name || !value) {
      continue;
    }
    if (
      normalizedQuery.length === 0 ||
      name.toLowerCase().includes(normalizedQuery) ||
      value.toLowerCase().includes(normalizedQuery)
    ) {
      results.push({ name: name.slice(0, 100), value: value.slice(0, 100) });
    }
    if (results.length >= 25) {
      break;
    }
  }

  return results;
}

function transformCommandOption(option: Record<string, unknown>): APIApplicationCommandOption {
  const type = normalizeOptionType(option.type);
  const name = String(option.name ?? '').trim();
  const description = String(option.description ?? name).slice(0, 100);
  const autocomplete = readAutocompleteConfig(option);

  const transformed = {
    type,
    name,
    description,
    required: option.required === true,
  } as APIApplicationCommandOption;

  if (type === 1 || type === 2) {
    const nested = option.options;
    if (Array.isArray(nested)) {
      (transformed as APIApplicationCommandOption & {
        options?: APIApplicationCommandOption[];
      }).options = nested
        .filter((entry): entry is Record<string, unknown> => typeof entry === 'object' && entry !== null)
        .map((entry) => transformCommandOption(entry));
    }
    return transformed;
  }

  if (autocomplete) {
    (transformed as APIApplicationCommandOption & { autocomplete?: boolean }).autocomplete = true;
    return transformed;
  }

  const choices = option.choices;
  if (Array.isArray(choices) && choices.length > 0) {
    (transformed as APIApplicationCommandOption & {
      choices?: Array<{ name: string; value: string | number }>;
    }).choices = choices
      .filter((entry): entry is Record<string, unknown> => typeof entry === 'object' && entry !== null)
      .map((choice) => ({
        name: String(choice.name ?? '').slice(0, 100),
        value: choice.value as string | number,
      }))
      .filter((choice) => choice.name.length > 0);
  }

  if (option.minValue != null) {
    (transformed as APIApplicationCommandOption & { min_value?: number }).min_value =
      option.minValue as number;
  }
  if (option.maxValue != null) {
    (transformed as APIApplicationCommandOption & { max_value?: number }).max_value =
      option.maxValue as number;
  }

  return transformed;
}

function readAutocompleteConfig(option: Record<string, unknown>): Record<string, unknown> | null {
  const autocomplete = option.autocomplete;
  if (typeof autocomplete !== 'object' || autocomplete === null) {
    return null;
  }
  const config = autocomplete as Record<string, unknown>;
  return config.enabled === true ? config : null;
}

function normalizeOptionType(raw: unknown): number {
  if (typeof raw === 'number' && Number.isInteger(raw)) {
    return raw;
  }
  const normalized = String(raw ?? 'string').trim().toLowerCase();
  return OPTION_TYPE_MAP[normalized] ?? 3;
}

function pathsEqual(left: string[], right: string[]): boolean {
  if (left.length !== right.length) {
    return false;
  }
  return left.every((segment, index) => segment === right[index]);
}
