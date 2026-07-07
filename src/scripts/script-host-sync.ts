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

export function isSyncHostMethod(targetId: string, method: string): boolean {
  if (targetId.startsWith('canvas:')) {
    return CANVAS_METHODS.has(method);
  }
  if (targetId.startsWith('canvas-context:')) {
    return CONTEXT2D_METHODS.has(method);
  }
  return false;
}

export function isSyncModuleFunction(moduleId: string, functionName: string): boolean {
  return moduleId === 'module:canvas' && CANVAS_MODULE_SYNC_FUNCTIONS.has(functionName);
}
