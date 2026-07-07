import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

import type { ScriptExecutionContext } from './script-context.js';
import {
  asDynamicDescriptor,
} from './script-host-dynamic.js';
import {
  HostObjectRegistry,
  type HostProxyDescriptor,
  isHostArgRef,
  isHostProxyDescriptor,
} from './script-host-registry.js';

const moduleRequire = createRequire(fileURLToPath(import.meta.url));

type CanvasModule = typeof import('canvas');
type VoiceModule = typeof import('@discordjs/voice');

let canvasLib: CanvasModule | null = null;
let voiceLib: VoiceModule | null = null;

function getCanvas(): CanvasModule {
  canvasLib ??= moduleRequire('canvas') as CanvasModule;
  return canvasLib;
}

function getVoice(): VoiceModule {
  voiceLib ??= moduleRequire('@discordjs/voice') as VoiceModule;
  return voiceLib;
}

const ALLOWED_MODULES = new Set(['canvas', '@discordjs/voice']);

export function getCanvasModuleConstants(): Record<string, unknown> {
  const canvas = getCanvas();
  return {
    PNG_NO_FILTERS: canvas.Canvas.PNG_NO_FILTERS,
    PNG_ALL_FILTERS: canvas.Canvas.PNG_ALL_FILTERS,
    PNG_FILTER_NONE: canvas.Canvas.PNG_FILTER_NONE,
    PNG_FILTER_SUB: canvas.Canvas.PNG_FILTER_SUB,
    PNG_FILTER_UP: canvas.Canvas.PNG_FILTER_UP,
    PNG_FILTER_AVG: canvas.Canvas.PNG_FILTER_AVG,
    PNG_FILTER_PAETH: canvas.Canvas.PNG_FILTER_PAETH,
  };
}

export function getVoiceModuleConstants(): Record<string, unknown> {
  const voice = getVoice();
  return {
    version: voice.version,
    AudioPlayerStatus: voice.AudioPlayerStatus,
    VoiceConnectionStatus: voice.VoiceConnectionStatus,
    StreamType: voice.StreamType,
    NoSubscriberBehavior: voice.NoSubscriberBehavior,
    VoiceConnectionDisconnectReason: voice.VoiceConnectionDisconnectReason,
    EndBehaviorType: voice.EndBehaviorType,
  };
}

const CANVAS_METHODS = [
  'getContext',
  'toBuffer',
  'toDataURL',
  'createPNGStream',
  'createJPEGStream',
  'createPDFStream',
] as const;

const CONTEXT2D_METHODS = [
  'fillRect',
  'strokeRect',
  'clearRect',
  'fillText',
  'strokeText',
  'measureText',
  'beginPath',
  'closePath',
  'moveTo',
  'lineTo',
  'arc',
  'fill',
  'stroke',
  'clip',
  'save',
  'restore',
  'translate',
  'rotate',
  'scale',
  'drawImage',
  'setTransform',
  'resetTransform',
  'rect',
  'quadraticCurveTo',
  'bezierCurveTo',
] as const;

const CANVAS_IMAGE_METHODS = ['width', 'height'] as const;

const VOICE_CONNECTION_METHODS = [
  'subscribe',
  'destroy',
  'rejoin',
  'setSpeaking',
  'on',
  'off',
] as const;

const AUDIO_PLAYER_METHODS = [
  'play',
  'pause',
  'unpause',
  'stop',
  'on',
  'off',
] as const;

const AUDIO_RESOURCE_METHODS = [] as const;

export function registerAllowedModuleTargets(
  context: ScriptExecutionContext,
  moduleRegistry: ModuleRegistry,
): string[] {
  const registered: string[] = [];
  const { wrapHostResult } = moduleRegistry;

  try {
    const canvas = getCanvas();
    const canvasModule = buildCanvasModule(context, canvas, wrapHostResult);
    moduleRegistry.registerModule('canvas', canvasModule);
    moduleRegistry.registerInvokeTarget('module:canvas', canvasModule);
    registered.push('canvas');
  } catch {
    // Canvas native bindings are unavailable in this environment.
  }

  try {
    const voice = getVoice();
    const voiceModule = buildVoiceModule(context, voice, moduleRegistry, wrapHostResult);
    moduleRegistry.registerModule('@discordjs/voice', voiceModule);
    moduleRegistry.registerInvokeTarget('module:voice', voiceModule);
    registered.push('@discordjs/voice');
  } catch {
    // Voice dependencies are unavailable in this environment.
  }

  return registered;
}

function buildCanvasModule(
  _context: ScriptExecutionContext,
  canvas: CanvasModule,
  wrapHostResult: ModuleRegistry['wrapHostResult'],
) {
  return {
    createCanvas: (width: number, height: number, type?: string) =>
      wrapHostResult(
        canvas.createCanvas(width, height, type as never),
        'canvas',
        CANVAS_METHODS,
        (value) => ({
          width: (value as InstanceType<CanvasModule['Canvas']>).width,
          height: (value as InstanceType<CanvasModule['Canvas']>).height,
          type: (value as InstanceType<CanvasModule['Canvas']>).type,
        }),
      ),
    loadImage: async (source: string | Buffer) =>
      wrapHostResult(
        await loadCanvasImage(canvas, source),
        'canvas-image',
        CANVAS_IMAGE_METHODS,
        (value) => ({
          width: (value as InstanceType<CanvasModule['Image']>).width,
          height: (value as InstanceType<CanvasModule['Image']>).height,
        }),
      ),
    createImageData: (array: Uint8ClampedArray, width: number, height?: number) =>
      wrapHostResult(canvas.createImageData(array, width, height)),
    registerFont: (path: string, options: { family: string }) => canvas.registerFont(path, options),
    PNG_NO_FILTERS: canvas.Canvas.PNG_NO_FILTERS,
    PNG_ALL_FILTERS: canvas.Canvas.PNG_ALL_FILTERS,
    PNG_FILTER_NONE: canvas.Canvas.PNG_FILTER_NONE,
    PNG_FILTER_SUB: canvas.Canvas.PNG_FILTER_SUB,
    PNG_FILTER_UP: canvas.Canvas.PNG_FILTER_UP,
    PNG_FILTER_AVG: canvas.Canvas.PNG_FILTER_AVG,
    PNG_FILTER_PAETH: canvas.Canvas.PNG_FILTER_PAETH,
  };
}

async function loadCanvasImage(
  canvas: CanvasModule,
  source: string | Buffer,
): Promise<InstanceType<CanvasModule['Image']>> {
  if (Buffer.isBuffer(source)) {
    return canvas.loadImage(source);
  }

  const url = normalizeCanvasImageUrl(String(source));
  try {
    return await canvas.loadImage(url);
  } catch {
    const response = await fetch(url);
    if (!response.ok) {
      throw new Error(`Failed to fetch image (${response.status} ${response.statusText}).`);
    }
    const buffer = Buffer.from(await response.arrayBuffer());
    return canvas.loadImage(buffer);
  }
}

function normalizeCanvasImageUrl(url: string): string {
  return url
    .replace(/\.webp(\?|$)/i, '.png$1')
    .replace(/([?&])format=webp(&|$)/i, '$1format=png$2')
    .replace(/([?&])extension=webp(&|$)/i, '$1extension=png$2');
}

function buildVoiceModule(
  context: ScriptExecutionContext,
  voice: VoiceModule,
  moduleRegistry: ModuleRegistry,
  wrapHostResult: ModuleRegistry['wrapHostResult'],
) {
  return {
    joinVoiceChannel: (options: Record<string, unknown>) => {
      const guildId = String(options.guildId ?? '');
      const channelId = String(options.channelId ?? '');
      let adapterCreator = options.adapterCreator;

      if (adapterCreator == null && context.client && guildId) {
        const guild = context.client.guilds.cache.get(guildId);
        adapterCreator = guild?.voiceAdapterCreator;
      }

      if (adapterCreator == null) {
        throw new Error(
          'joinVoiceChannel: missing adapterCreator — provide guildId from a connected guild.',
        );
      }

      return wrapHostResult(
        voice.joinVoiceChannel({
          ...(options as Record<string, unknown>),
          guildId,
          channelId,
          adapterCreator: adapterCreator as never,
        } as never),
        'voice-connection',
        VOICE_CONNECTION_METHODS,
        (value) => ({
          joinConfig: (value as InstanceType<VoiceModule['VoiceConnection']>).joinConfig,
        }),
      );
    },
    createAudioPlayer: (options?: Record<string, unknown>) =>
      wrapHostResult(
        voice.createAudioPlayer(options as never),
        'audio-player',
        AUDIO_PLAYER_METHODS,
        () => ({}),
      ),
    createAudioResource: (input: unknown, options?: Record<string, unknown>) =>
      wrapHostResult(
        voice.createAudioResource(input as never, options as never),
        'audio-resource',
        AUDIO_RESOURCE_METHODS,
        () => ({}),
      ),
    getVoiceConnection: (guildId: string) => {
      const connection = voice.getVoiceConnection(guildId);
      if (!connection) {
        return null;
      }
      return wrapHostResult(
        connection,
        'voice-connection',
        VOICE_CONNECTION_METHODS,
        (value) => ({
          joinConfig: (value as InstanceType<VoiceModule['VoiceConnection']>).joinConfig,
        }),
      );
    },
    entersState: async (
      target: unknown,
      status: unknown,
      timeoutOrSignal?: unknown,
    ) => {
      const resolvedTarget = resolveHostArg(moduleRegistry.registry, target);
      const result = await voice.entersState(
        resolvedTarget as never,
        status as never,
        timeoutOrSignal as never,
      );
      if (result instanceof voice.VoiceConnection) {
        return wrapHostResult(
          result,
          'voice-connection',
          VOICE_CONNECTION_METHODS,
          (value) => ({
            joinConfig: (value as InstanceType<VoiceModule['VoiceConnection']>).joinConfig,
          }),
        );
      }
      if (result && typeof result === 'object' && 'play' in result) {
        return wrapHostResult(result, 'audio-player', AUDIO_PLAYER_METHODS, () => ({}));
      }
      return wrapHostResult(result);
    },
    demuxProbe: async (stream: unknown, probeSize?: number) => {
      const result = await voice.demuxProbe(stream as never, probeSize);
      return wrapHostResult(result);
    },
    generateDependencyReport: () => voice.generateDependencyReport(),
    validateDiscordOpusHead: (head: Buffer) => voice.validateDiscordOpusHead(head),
    version: voice.version,
    AudioPlayerStatus: voice.AudioPlayerStatus,
    VoiceConnectionStatus: voice.VoiceConnectionStatus,
    StreamType: voice.StreamType,
    NoSubscriberBehavior: voice.NoSubscriberBehavior,
    VoiceConnectionDisconnectReason: voice.VoiceConnectionDisconnectReason,
    EndBehaviorType: voice.EndBehaviorType,
  };
}

export function isAllowedModule(name: string): boolean {
  return ALLOWED_MODULES.has(name.trim());
}

export function createHostResultWrapper(registry: HostObjectRegistry) {
  const wrap = (
    value: unknown,
    prefix?: string,
    methods?: readonly string[],
    snapshot?: (value: unknown) => Record<string, unknown>,
  ): unknown => {
    if (value == null) {
      return copySerializable(value);
    }

    if (isHostProxyDescriptor(value)) {
      return value;
    }

    let canvas: CanvasModule | null = null;
    let voice: VoiceModule | null = null;
    try {
      canvas = getCanvas();
      voice = getVoice();
    } catch {
      return copySerializable(value);
    }

    if (value instanceof canvas.Canvas) {
      return asDynamicDescriptor(descriptor(
        registry,
        prefix ?? 'canvas',
        methods ?? CANVAS_METHODS,
        snapshot?.(value) ?? {
          width: value.width,
          height: value.height,
          type: value.type,
        },
        value,
      ));
    }

    if (value instanceof canvas.CanvasRenderingContext2D) {
      return asDynamicDescriptor(descriptor(registry, 'canvas-context', CONTEXT2D_METHODS, {
        canvas: { width: value.canvas.width, height: value.canvas.height },
      }, value));
    }

    if (value instanceof canvas.Image) {
      return asDynamicDescriptor(descriptor(
        registry,
        prefix ?? 'canvas-image',
        methods ?? CANVAS_IMAGE_METHODS,
        snapshot?.(value) ?? {
          width: value.width,
          height: value.height,
        },
        value,
      ));
    }

    if (value instanceof voice.VoiceConnection) {
      return asDynamicDescriptor(descriptor(
        registry,
        prefix ?? 'voice-connection',
        methods ?? VOICE_CONNECTION_METHODS,
        snapshot?.(value) ?? {
          joinConfig: value.joinConfig,
        },
        value,
      ));
    }

    if (value instanceof voice.AudioPlayer) {
      return asDynamicDescriptor(descriptor(
        registry,
        prefix ?? 'audio-player',
        methods ?? AUDIO_PLAYER_METHODS,
        snapshot?.(value) ?? {},
        value,
      ));
    }

    if (value instanceof voice.AudioResource) {
      return asDynamicDescriptor(descriptor(
        registry,
        prefix ?? 'audio-resource',
        methods ?? AUDIO_RESOURCE_METHODS,
        snapshot?.(value) ?? {},
        value,
      ));
    }

    if (Array.isArray(value)) {
      return value.map((entry) => wrap(entry));
    }

    if (prefix != null && methods != null && (typeof value === 'object' || typeof value === 'function')) {
      return asDynamicDescriptor(descriptor(registry, prefix, methods, snapshot?.(value) ?? {}, value));
    }

    if (typeof value === 'object' && !Array.isArray(value)) {
      return asDynamicDescriptor(descriptor(registry, 'host', [], {}, value));
    }

    return copySerializable(value);
  };

  return wrap;
}

function descriptor(
  registry: HostObjectRegistry,
  prefix: string,
  methods: readonly string[],
  snapshot: Record<string, unknown>,
  target: unknown,
): HostProxyDescriptor {
  return {
    id: registry.register(prefix, target),
    snapshot: copySerializable(snapshot) as Record<string, unknown>,
    methods: [...methods],
  };
}

export function resolveHostArg(registry: HostObjectRegistry, value: unknown): unknown {
  if (isHostProxyDescriptor(value) || isHostArgRef(value)) {
    return registry.resolve(isHostArgRef(value) ? value.__hostArgRef : value.id);
  }

  if (Array.isArray(value)) {
    return value.map((entry) => resolveHostArg(registry, entry));
  }

  if (value != null && typeof value === 'object') {
    const output: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
      output[key] = resolveHostArg(registry, entry);
    }
    return output;
  }

  return value;
}

function copySerializable(value: unknown): unknown {
  if (value == null) {
    return value;
  }

  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
    return value;
  }

  if (typeof value === 'bigint') {
    return value.toString();
  }

  if (Buffer.isBuffer(value)) {
    return value.toString('base64');
  }

  if (value instanceof Date) {
    return value.toISOString();
  }

  if (Array.isArray(value)) {
    return value.map((entry) => copySerializable(entry));
  }

  if (typeof value === 'object') {
    const output: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
      if (typeof entry === 'function') {
        continue;
      }
      try {
        output[key] = copySerializable(entry);
      } catch {
        // Skip non-serializable fields.
      }
    }
    return output;
  }

  return String(value);
}

export type RegisteredModule = Record<string, unknown>;

export interface ModuleRegistry {
  registerModule: (name: string, exports: RegisteredModule) => void;
  getModule: (name: string) => RegisteredModule | null;
  registerInvokeTarget: (id: string, target: RegisteredModule) => void;
  getInvokeTarget: (id: string) => RegisteredModule | null;
  registry: HostObjectRegistry;
  wrapHostResult: ReturnType<typeof createHostResultWrapper>;
}

export function createModuleRegistry(): ModuleRegistry {
  const registry = new HostObjectRegistry();
  const modules = new Map<string, RegisteredModule>();
  const invokeTargets = new Map<string, RegisteredModule>();
  const wrapHostResult = createHostResultWrapper(registry);

  return {
    registry,
    wrapHostResult,
    registerModule(name, exports) {
      modules.set(name, exports);
    },
    getModule(name) {
      return modules.get(name) ?? null;
    },
    registerInvokeTarget(id, target) {
      invokeTargets.set(id, target);
    },
    getInvokeTarget(id) {
      return invokeTargets.get(id) ?? null;
    },
  };
}
