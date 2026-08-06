// CoordinateAdapter(Phase 3 §任务5):世界坐标 / Canvas 坐标 / 屏幕坐标转换。
//
// 策略层通过它做坐标换算,不再直接引用 canvas/viewParams/worldToScreen。
// 依赖(世界坐标 → 屏幕)由调用方注入,便于在 fixture 中替换。
//
// 双用途模块(同 src/shared/ids.js):
//   1) 测试直接 import;
//   2) 由 scripts/build.mjs 提取函数体内联进 pageMain。
export function gameScreenCenter(rect, screenCenter) {
  if (typeof screenCenter === "function") {
    try {
      const point = screenCenter();
      const x = Number(point && point.x);
      const y = Number(point && point.y);
      if (Number.isFinite(x) && Number.isFinite(y)) {
        return { x: rect.left + x, y: rect.top + y };
      }
    } catch (_) {}
  }
  const reservedLeft = window.matchMedia("(max-aspect-ratio: 1/1)").matches
    ? 0
    : Math.min(368, Math.max(0, rect.width - 320));
  return {
    x: rect.left + reservedLeft + (rect.width - reservedLeft) / 2,
    y: rect.top + rect.height / 2
  };
}

export function gameCameraCenter(me, localVisual) {
  const visual = localVisual;
  if (visual && Number.isFinite(Number(visual.x)) && Number.isFinite(Number(visual.y))) {
    return { x: Number(visual.x), y: Number(visual.y) };
  }
  return {
    x: me ? Number(me.x) : 0,
    y: me ? Number(me.y) : 0
  };
}

export function fallbackWorldToClient(me, rect, viewRadiusCm, localVisual) {
  const shortSide = Math.max(1, Math.min(rect.width, rect.height));
  const viewRadius = Number(viewRadiusCm);
  const units = Number.isFinite(viewRadius) && viewRadius > 0
    ? (viewRadius * 2) / shortSide
    : (50000 * 2) / shortSide;
  const origin = gameScreenCenter(rect);
  const camera = gameCameraCenter(me, localVisual);
  return point => ({
    x: origin.x + (Number(point.x) - camera.x) / units,
    y: origin.y + (Number(point.y) - camera.y) / units
  });
}

export function worldToClientFactory(me, rootRect, deps) {
  const rect = deps && deps.canvasRect ? deps.canvasRect() : null;
  if (typeof deps.viewParams === "function" && typeof deps.worldToScreen === "function") {
    try {
      const view = deps.viewParams();
      return point => {
        const screenPoint = deps.worldToScreen(Number(point.x), Number(point.y), view);
        return {
          x: (rect ? rect.left : 0) + Number(screenPoint.x),
          y: (rect ? rect.top : 0) + Number(screenPoint.y)
        };
      };
    } catch (_) {}
  }
  if (!rect || rect.width <= 0 || rect.height <= 0) {
    return fallbackWorldToClient(me, deps.overlayRect || rootRect, deps.viewRadiusCm, deps.localVisual);
  }
  return fallbackWorldToClient(me, rect, deps.viewRadiusCm, deps.localVisual);
}