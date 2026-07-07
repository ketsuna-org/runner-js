import type { ScriptExecutionContext } from './script-context.js';
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
  syncFunctions: ['createCanvas', 'registerFont', 'createImageData'],
};

const VOICE_SPEC = {
  name: '@discordjs/voice',
  id: 'module:voice',
  functions: [
    'joinVoiceChannel',
    'createAudioPlayer',
    'createAudioResource',
    'getVoiceConnection',
    'entersState',
    'demuxProbe',
    'generateDependencyReport',
    'validateDiscordOpusHead',
  ],
  syncFunctions: [
    'joinVoiceChannel',
    'createAudioPlayer',
    'createAudioResource',
    'getVoiceConnection',
    'generateDependencyReport',
    'validateDiscordOpusHead',
  ],
};

export function createScriptModuleRegistry(context: ScriptExecutionContext): {
  moduleRegistry: ModuleRegistry;
  moduleSpecs: ModuleSpec[];
} {
  const moduleRegistry = createModuleRegistry();
  const registered = registerAllowedModuleTargets(context, moduleRegistry);

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

  return { moduleRegistry, moduleSpecs };
}
