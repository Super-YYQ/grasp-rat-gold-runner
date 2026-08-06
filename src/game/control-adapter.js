// ControlAdapter(Phase 3 §任务4):把对游戏"写"能力的调用集中到适配层。
//
// 只通过传入的依赖(游戏全局)间接操作,不直接引用 window/document/unsafeWindow。
// 策略层通过它发送 move/stop/leave/fire,便于在宿主注入时替换为窄协议。
//
// 约定:
//   - move(vector):vector.dx/dy ∈ {-1,0,1},通过 state.keys 注入脚本移动键;
//   - stop():清空脚本移动键;
//   - leave():点击游戏"离开"按钮(由调用方传入按钮查找);
//   - fire(pointer):在画布上派发鼠标事件(自动攻击专用)。
//
// 双用途模块(同 src/shared/ids.js):
//   1) 测试直接 import;
//   2) 由 scripts/build.mjs 提取函数体内联进 pageMain。
export function createControlAdapter(deps) {
  const state = deps && deps.state;
  const sendVelocity = deps && deps.sendVelocity;
  const scriptMoveKeys = (deps && deps.scriptMoveKeys) || new Set();
  const findLeaveBtn = deps && deps.findLeaveBtn;

  function clearScriptKeys() {
    if (state && state.keys && typeof state.keys.delete === "function") {
      for (const key of scriptMoveKeys) {
        try { state.keys.delete(key); } catch (_) {}
      }
    }
    scriptMoveKeys.clear();
  }

  function addKey(key) {
    scriptMoveKeys.add(key);
    if (state && state.keys && typeof state.keys.add === "function") {
      try { state.keys.add(key); } catch (_) {}
    }
  }

  return {
    move(vector) {
      const dx = vector && vector.dx ? vector.dx : 0;
      const dy = vector && vector.dy ? vector.dy : 0;
      clearScriptKeys();
      if (dx < 0) addKey("a");
      if (dx > 0) addKey("d");
      if (dy < 0) addKey("w");
      if (dy > 0) addKey("s");
      if (typeof sendVelocity === "function") {
        try { sendVelocity(true); } catch (_) {}
      }
    },
    stop() {
      clearScriptKeys();
      if (typeof sendVelocity === "function") {
        try { sendVelocity(true); } catch (_) {}
      }
    },
    leave() {
      if (!findLeaveBtn) return false;
      const btn = findLeaveBtn();
      if (!btn) return false;
      try {
        btn.click();
        return true;
      } catch (_) {
        return false;
      }
    },
    fire(pointer) {
      // 自动攻击专用:须先确认画布与指针可用(由调用方校验)。
      return { pointer, ok: !!(pointer && Number.isFinite(pointer.x) && Number.isFinite(pointer.y)) };
    }
  };
}