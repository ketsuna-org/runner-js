import type { ScriptExecutionContext, ScriptLogger } from './script-context.js';
import {
  getDiscordJsBuilderFunctionNames,
  getDiscordJsDeniedFunctionNames,
  getDiscordJsModuleConstants,
} from './script-host-discordjs.js';
import { getUtilModuleConstants } from './script-host-util.js';
import type { VoiceSessionCleanup } from './script-host-voice-session.js';
import {
  createModuleRegistry,
  getCanvasModuleConstants,
  getVoiceModuleConstants,
  registerAllowedModuleTargets,
  type ModuleRegistry,
} from './script-host-modules.js';

export interface ModuleSpec {
  name: string;
  id: string;
  functions: string[];
  syncFunctions?: string[];
  constants: Record<string, unknown>;
}

const CANVAS_SPEC = {
  name: 'canvas',
  id: 'module:canvas',
  functions: ['createCanvas', 'loadImage', 'registerFont', 'createImageData'],
  syncFunctions: ['createCanvas', 'createImageData'],
};

const VOICE_SPEC = {
  name: '@discordjs/voice',
  id: 'module:voice',
  functions: [
    'joinVoiceChannel',
    'joinVoiceChannelReady',
    'createAudioPlayer',
    'createAudioResource',
    'playAudio',
    'getVoiceConnection',
    'entersState',
    'demuxProbe',
    'generateDependencyReport',
    'validateDiscordOpusHead',
  ],
  syncFunctions: [
    'createAudioPlayer',
    'getVoiceConnection',
    'generateDependencyReport',
    'validateDiscordOpusHead',
  ],
};

const CRYPTO_FUNCTIONS = [
  'randomBytes',
  'randomUUID',
  'randomInt',
  'createHash',
  'createHmac',
  'timingSafeEqual',
] as const;

const CRYPTO_SYNC_FUNCTIONS = [
  'randomBytes',
  'randomUUID',
  'randomInt',
  'createHash',
  'createHmac',
  'timingSafeEqual',
] as const;

const UTIL_FUNCTIONS = [
  'inspect',
  'format',
  'formatWithOptions',
  ...Object.keys(getUtilModuleConstants().types ?? {}),
] as const;

const URL_FUNCTIONS = ['URL', 'URLSearchParams'] as const;

const QUERYSTRING_FUNCTIONS = ['parse', 'stringify'] as const;

function createCryptoSpec(name: string): ModuleSpec {
  return {
    name,
    id: 'module:crypto',
    functions: [...CRYPTO_FUNCTIONS],
    syncFunctions: [...CRYPTO_SYNC_FUNCTIONS],
    constants: {},
  };
}

function createUtilSpec(name: string): ModuleSpec {
  return {
    name,
    id: 'module:util',
    functions: [...UTIL_FUNCTIONS],
    syncFunctions: [...UTIL_FUNCTIONS],
    constants: getUtilModuleConstants(),
  };
}

function createUrlSpec(name: string): ModuleSpec {
  return {
    name,
    id: 'module:url',
    functions: [...URL_FUNCTIONS],
    syncFunctions: [...URL_FUNCTIONS],
    constants: {},
  };
}

function createQuerystringSpec(name: string): ModuleSpec {
  return {
    name,
    id: 'module:querystring',
    functions: [...QUERYSTRING_FUNCTIONS],
    syncFunctions: [...QUERYSTRING_FUNCTIONS],
    constants: {},
  };
}

function createDiscordJsSpec(): ModuleSpec {
  const builders = getDiscordJsBuilderFunctionNames();
  const denied = getDiscordJsDeniedFunctionNames();
  return {
    name: 'discord.js',
    id: 'module:discordjs',
    functions: [...builders, ...denied],
    syncFunctions: [...builders, ...denied],
    constants: getDiscordJsModuleConstants(),
  };
}

export function createScriptModuleRegistry(
  context: ScriptExecutionContext,
  voiceSession?: VoiceSessionCleanup,
  voiceLog?: ScriptLogger,
): {
  moduleRegistry: ModuleRegistry;
  moduleSpecs: ModuleSpec[];
} {
  const moduleRegistry = createModuleRegistry();
  moduleRegistry.voiceSession = voiceSession;
  const registered = registerAllowedModuleTargets(context, moduleRegistry, voiceSession, voiceLog);

  const moduleSpecs: ModuleSpec[] = [];

  if (registered.includes('canvas')) {
    try {
      moduleSpecs.push({
        ...CANVAS_SPEC,
        constants: getCanvasModuleConstants(),
      });
    } catch {
      // Ignore missing native canvas bindings.
    }
  }

  if (registered.includes('@discordjs/voice')) {
    try {
      moduleSpecs.push({
        ...VOICE_SPEC,
        constants: getVoiceModuleConstants(),
      });
    } catch {
      // Ignore missing voice dependencies.
    }
  }

  if (registered.includes('node:crypto') || registered.includes('crypto')) {
    moduleSpecs.push(createCryptoSpec('node:crypto'));
    moduleSpecs.push(createCryptoSpec('crypto'));
  }

  if (registered.includes('node:util') || registered.includes('util')) {
    moduleSpecs.push(createUtilSpec('node:util'));
    moduleSpecs.push(createUtilSpec('util'));
  }

  if (registered.includes('discord.js')) {
    try {
      moduleSpecs.push(createDiscordJsSpec());
    } catch {
      // Ignore missing discord.js builders.
    }
  }

  if (registered.includes('node:url') || registered.includes('url')) {
    moduleSpecs.push(createUrlSpec('node:url'));
    moduleSpecs.push(createUrlSpec('url'));
  }

  if (registered.includes('node:querystring') || registered.includes('querystring')) {
    moduleSpecs.push(createQuerystringSpec('node:querystring'));
    moduleSpecs.push(createQuerystringSpec('querystring'));
  }

  return { moduleRegistry, moduleSpecs };
}
