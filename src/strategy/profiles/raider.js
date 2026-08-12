// Raider（掠夺）模式纯策略：把金币路线与击杀收益放进同一个评分池。
// 本模块不依赖 DOM/游戏全局，既供测试直接 import，也会在构建时内联进 userscript。

export const RAIDER_DEFAULTS = {
  stillMs: 8000,
  recentMoveMs: 10000,
  minAfkDrop: 1,
  minActiveDrop: 3,
  activeHpRatio: 0.78,
  activeHighDrop: 15,
  activeHighDropHpSlack: 5,
  minSelfHp: 45,
  fireRangeCm: 15000,
  holdRangeCm: 14000,
  maxPursuitCm: 50000,
  damagePerShot: 3,
  shotStaminaMs: 500,
  shotIntervalMs: 100,
  reserveShots: 2,
  minBurstShots: 5,
  switchFactor: 1.15,
  killBias: 1.18
};

export function raidEntityInvincible(entity, now) {
  if (!entity) return false;
  const absolute = Number(entity.invincible_until ?? entity.invulnerable_until ?? entity.invulnerable_until_ms);
  if (Number.isFinite(absolute) && absolute > Number(now || Date.now())) return true;
  const remaining = Number(entity.invuln_remaining_ms ?? entity.invincible_remaining_ms ?? entity.inv);
  return Number.isFinite(remaining) && remaining > 0;
}

export function classifyRaidCandidate(enemy, motion, me, now, options) {
  const cfg = { ...RAIDER_DEFAULTS, ...(options || {}) };
  const hp = Number(enemy && enemy.hpForFire);
  const drop = Number(enemy && (enemy.dropForAvoid ?? enemy.drop ?? enemy.death_reward_preview ?? enemy.death_drop_coins));
  const dist = Number(enemy && enemy.dist);
  const selfHp = Number(me && me.hp);
  const base = {
    ...(enemy || {}),
    hpForFire: hp,
    dropForAvoid: Number.isFinite(drop) ? drop : 0,
    dist,
    eligible: false,
    kind: "blocked",
    stationaryMs: 0,
    reason: "invalid"
  };
  if (!enemy || enemy.life !== "Alive") return { ...base, reason: "not-alive" };
  if (!(hp > 0) || !(drop > 0) || !Number.isFinite(dist) || dist > cfg.maxPursuitCm) {
    return { ...base, reason: "no-value-or-out-of-range" };
  }
  if (raidEntityInvincible(enemy, now)) return { ...base, reason: "invincible" };

  const firstSeenAt = Number(motion && motion.firstSeenAt);
  const lastMovedAt = Number(motion && motion.lastMovedAt);
  const stationarySince = Math.max(
    Number.isFinite(firstSeenAt) && firstSeenAt > 0 ? firstSeenAt : Number(now || 0),
    Number.isFinite(lastMovedAt) && lastMovedAt > 0 ? lastMovedAt : 0
  );
  const stationaryMs = Math.max(0, Number(now || 0) - stationarySince);
  if (stationaryMs >= cfg.stillMs && drop >= cfg.minAfkDrop) {
    return { ...base, eligible: true, kind: "afk", stationaryMs, reason: "stationary-drop" };
  }

  const favorableHp = Number.isFinite(selfHp)
    && selfHp >= cfg.minSelfHp
    && (hp <= selfHp * cfg.activeHpRatio || (drop >= cfg.activeHighDrop && hp <= selfHp + cfg.activeHighDropHpSlack));
  if (drop >= cfg.minActiveDrop && favorableHp) {
    return { ...base, eligible: true, kind: "finish", stationaryMs, reason: "favorable-finish" };
  }
  return { ...base, stationaryMs, reason: "active-risk" };
}

export function scoreRaidCandidate(me, target, options) {
  const cfg = { ...RAIDER_DEFAULTS, ...(options || {}) };
  if (!target || target.eligible === false) return null;
  const hp = Number(target.hpForFire);
  const reward = Number(target.dropForAvoid ?? target.drop);
  const dist = Number(target.dist);
  if (!(hp > 0) || !(reward > 0) || !Number.isFinite(dist)) return null;

  const shots = Math.max(1, Math.ceil(hp / cfg.damagePerShot));
  const approachCm = Math.max(0, dist - cfg.holdRangeCm);
  const pickupCm = Math.min(cfg.holdRangeCm, Math.max(0, dist - approachCm));
  const fireStaminaMs = shots * cfg.shotStaminaMs;
  const totalStaminaMs = approachCm + pickupCm + fireStaminaMs;
  const stamina5s = Number(me && me.stamina_5s_remaining_milli);
  const minimumBurstBudget = (cfg.minBurstShots + cfg.reserveShots) * cfg.shotStaminaMs;
  if (!Number.isFinite(stamina5s) || stamina5s < minimumBurstBudget) return null;
  const stamina1h = Number(me && me.stamina_1h_remaining_milli);
  if (Number.isFinite(stamina1h) && stamina1h < totalStaminaMs + cfg.reserveShots * cfg.shotStaminaMs) return null;

  const approachSeconds = approachCm / 1000;
  const fireSeconds = shots * cfg.shotIntervalMs / 1000;
  const pickupSeconds = pickupCm / 1000;
  const riskFactor = target.kind === "finish" ? 0.82 : 1;
  const score = reward / (approachSeconds + fireSeconds + pickupSeconds + 1.4) * riskFactor * cfg.killBias;
  return {
    kind: "kill",
    id: String(target.user_id ?? target.id ?? ""),
    score,
    reward,
    shots,
    totalStaminaMs,
    approachCm,
    pickupCm,
    target
  };
}

export function chooseProfileOpportunity(coin, kill, held, now, options) {
  const cfg = { ...RAIDER_DEFAULTS, ...(options || {}) };
  const candidates = [coin, kill].filter(item => item && Number.isFinite(Number(item.score)));
  if (!candidates.length) return null;
  candidates.sort((a, b) => Number(b.score) - Number(a.score)
    || (a.kind === "kill" ? -1 : 1));
  const best = candidates[0];
  if (!held) return { ...best, adoptedAt: Number(now || Date.now()) };
  const heldFresh = candidates.find(item => item.kind === held.kind && String(item.id) === String(held.id));
  if (!heldFresh) return { ...best, adoptedAt: Number(now || Date.now()) };
  if (best.kind === heldFresh.kind && String(best.id) === String(heldFresh.id)) {
    return { ...heldFresh, adoptedAt: held.adoptedAt || Number(now || Date.now()) };
  }
  if (Number(best.score) < Number(heldFresh.score) * cfg.switchFactor) {
    return { ...heldFresh, adoptedAt: held.adoptedAt || Number(now || Date.now()) };
  }
  return { ...best, adoptedAt: Number(now || Date.now()) };
}

export function raidShouldAbort(me, target, engagementHp, options) {
  const cfg = { ...RAIDER_DEFAULTS, ...(options || {}) };
  const hp = Number(me && me.hp);
  const targetHp = Number(target && target.hpForFire);
  if (!Number.isFinite(hp) || hp <= 0) return { abort: true, reason: "self-dead" };
  if (hp <= 25) return { abort: true, reason: "critical-hp" };
  if (Number.isFinite(engagementHp) && engagementHp - hp >= 18) return { abort: true, reason: "damage-budget" };
  if (target && target.kind === "finish" && Number.isFinite(targetHp) && targetHp > hp * 1.15) {
    return { abort: true, reason: "hp-disadvantage" };
  }
  if (Number(me && me.stamina_5s_remaining_milli) < (cfg.reserveShots + 1) * cfg.shotStaminaMs) {
    return { abort: true, reason: "stamina-reserve" };
  }
  return { abort: false, reason: "ok" };
}
