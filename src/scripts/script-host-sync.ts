const CANVAS_METHODS = new Set([
  'getContext',
  'toBuffer',
  'toDataURL',
  'createPNGStream',
  'createJPEGStream',
  'createPDFStream',
]);

const CONTEXT2D_METHODS = new Set([
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
]);

const CANVAS_MODULE_SYNC_FUNCTIONS = new Set([
  'createCanvas',
  'registerFont',
  'createImageData',
]);

const VOICE_CONNECTION_METHODS = new Set([
  'subscribe',
  'destroy',
  'rejoin',
  'setSpeaking',
  'on',
  'off',
]);

const AUDIO_PLAYER_METHODS = new Set([
  'play',
  'pause',
  'unpause',
  'stop',
  'on',
  'off',
]);

const VOICE_MODULE_SYNC_FUNCTIONS = new Set([
  'joinVoiceChannel',
  'createAudioPlayer',
  'getVoiceConnection',
  'generateDependencyReport',
  'validateDiscordOpusHead',
]);

export function isSyncHostMethod(targetId: string, method: string): boolean {
  if (targetId.startsWith('canvas:')) {
    return CANVAS_METHODS.has(method);
  }
  if (targetId.startsWith('canvas-context:')) {
    return CONTEXT2D_METHODS.has(method);
  }
  if (targetId.startsWith('voice-connection:')) {
    return VOICE_CONNECTION_METHODS.has(method);
  }
  if (targetId.startsWith('audio-player:')) {
    return AUDIO_PLAYER_METHODS.has(method);
  }
  return false;
}

export function isSyncModuleFunction(moduleId: string, functionName: string): boolean {
  if (moduleId === 'module:canvas') {
    return CANVAS_MODULE_SYNC_FUNCTIONS.has(functionName);
  }
  if (moduleId === 'module:voice') {
    return VOICE_MODULE_SYNC_FUNCTIONS.has(functionName);
  }
  return false;
}
