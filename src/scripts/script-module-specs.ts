import type { ScriptExecutionContext, ScriptLogger } from './script-context.js';
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
    'joinVoiceChannel',
    'createAudioPlayer',
    'getVoiceConnection',
    'generateDependencyReport',
    'validateDiscordOpusHead',
  ],
};

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

  return { moduleRegistry, moduleSpecs };
}
