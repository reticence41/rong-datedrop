const { config } = require("./config");
const {
  getParticipantPool,
  getAllHistoricalPairs,
  getConsecutiveUnmatchedWeeks,
  replaceWeekMatches,
  listMatchesByWeek,
  findMutualCrushes,
  markCrushMatched
} = require("./db");

const GRADE_MAP = {
  "大一": 1,
  "大二": 2,
  "大三": 3,
  "大四": 4,
  "大四及以上": 4,
  "硕士": 5,
  "研一及以上": 5,
  "博士": 6,
  "已毕业校友": 100,
  "其他": 3
};

const ALL_SLIDER_KEYS = [
  "involution_self",
  "involution_partner",
  "city_path",
  "marriage_view",
  "kindness_priority",
  "ideal_sacrifice",
  "family_priority",
  "process_orientation",
  "rationality",
  "novelty",
  "schedule",
  "tidy_tolerance",
  "dining_style",
  "spicy_level",
  "date_scene",
  "together_time",
  "travel_style",
  "spending_style",
  "hobby_overlap",
  "smoking_self",
  "smoking_partner",
  "drinking_self",
  "drinking_partner",
  "message_anxiety",
  "social_self",
  "social_partner",
  "ritual_importance",
  "opposite_friend_accept",
  "relation_control",
  "care_style",
  "intimacy_timing",
  "conflict_resolution",
  "pda_willingness",
  "aura_self",
  "aura_partner",
  "appearance_care"
];

const CROSS_PAIR_KEYS = [
  ["involution_self", "involution_partner"],
  ["smoking_self", "smoking_partner"],
  ["drinking_self", "drinking_partner"],
  ["social_self", "social_partner"],
  ["aura_self", "aura_partner"]
];

const CROSS_SPECIAL_KEYS = new Set([
  "involution_self",
  "involution_partner",
  "smoking_self",
  "smoking_partner",
  "drinking_self",
  "drinking_partner",
  "social_self",
  "social_partner",
  "aura_self",
  "aura_partner",
  "care_style"
]);

const NON_CROSS_KEYS = ALL_SLIDER_KEYS.filter((k) => !CROSS_SPECIAL_KEYS.has(k));
const HABIT_KEYS = ["schedule", "dining_style", "spending_style"];
const DEFAULT_MATCH_MIN_SCORE = Number(config.matchMinScore || 25);

function clampSlider(v) {
  const n = Number(v);
  if (!Number.isFinite(n)) return 4;
  if (n < 1) return 1;
  if (n > 7) return 7;
  return n;
}

function sliderValue(sliders, key) {
  return clampSlider(sliders && Object.prototype.hasOwnProperty.call(sliders, key) ? sliders[key] : 4);
}

function sim7(a, b) {
  const diff = Math.min(6, Math.abs(clampSlider(a) - clampSlider(b)));
  return 1 - diff / 6;
}

function avg(nums) {
  if (!nums.length) return 0;
  return nums.reduce((sum, n) => sum + n, 0) / nums.length;
}

function orientationMatch(seeking, targetGender) {
  if (!seeking) return false;
  // "都可以" and "先交朋友" are legacy values; treat them as match-any for backward compatibility
  if (seeking === "都可以" || seeking === "先交朋友") return true;
  return seeking === targetGender;
}

function gradePreferenceMatch(seekingGrades, targetGrade) {
  if (!Array.isArray(seekingGrades) || seekingGrades.length === 0) return true;
  return seekingGrades.includes(targetGrade);
}

function basicCompatible(a, b) {
  if (!a.gender || !b.gender || !a.seeking || !b.seeking) return false;
  // 已毕业校友只与已毕业校友匹配
  const aAlumni = a.grade === "已毕业校友";
  const bAlumni = b.grade === "已毕业校友";
  if (aAlumni !== bAlumni) return false;
  // 年级偏好双向检查：双方都必须接受对方的年级
  if (!gradePreferenceMatch(a.seekingGrades, b.grade)) return false;
  if (!gradePreferenceMatch(b.seekingGrades, a.grade)) return false;
  return orientationMatch(a.seeking, b.gender) && orientationMatch(b.seeking, a.gender);
}

function jaccard(valuesA, valuesB) {
  const setA = new Set(valuesA || []);
  const setB = new Set(valuesB || []);
  const union = new Set([...setA, ...setB]);
  let inter = 0;
  for (const v of setA) {
    if (setB.has(v)) inter += 1;
  }
  return union.size ? inter / union.size : 0;
}

function gradeScore(a, b) {
  const ga = GRADE_MAP[a.grade] || 3;
  const gb = GRADE_MAP[b.grade] || 3;
  const diff = Math.abs(ga - gb);
  if (diff === 0) return 1;
  if (diff === 1) return 0.7;
  if (diff === 2) return 0.45;
  return 0.25;
}

function campusScore(a, b) {
  if (!a.campus || !b.campus) return 0.5;
  if (a.campus === b.campus) return 1;
  if (
    (a.campus === "望江" && b.campus === "华西") ||
    (a.campus === "华西" && b.campus === "望江")
  ) {
    return 0.75;
  }
  return 0.55;
}

function checkDealbreaker(a, b) {
  const aSmoke = sliderValue(a.sliders, "smoking_self");
  const bSmokeAccept = sliderValue(b.sliders, "smoking_partner");
  if (aSmoke >= 5 && bSmokeAccept <= 2) {
    return { incompatible: true, reason: "smoking_conflict_ab" };
  }
  const bSmoke = sliderValue(b.sliders, "smoking_self");
  const aSmokeAccept = sliderValue(a.sliders, "smoking_partner");
  if (bSmoke >= 5 && aSmokeAccept <= 2) {
    return { incompatible: true, reason: "smoking_conflict_ba" };
  }

  const aDrink = sliderValue(a.sliders, "drinking_self");
  const bDrinkAccept = sliderValue(b.sliders, "drinking_partner");
  if (aDrink >= 5 && bDrinkAccept <= 2) {
    return { incompatible: true, reason: "drinking_conflict_ab" };
  }
  const bDrink = sliderValue(b.sliders, "drinking_self");
  const aDrinkAccept = sliderValue(a.sliders, "drinking_partner");
  if (bDrink >= 5 && aDrinkAccept <= 2) {
    return { incompatible: true, reason: "drinking_conflict_ba" };
  }

  const marriageDiff = Math.abs(sliderValue(a.sliders, "marriage_view") - sliderValue(b.sliders, "marriage_view"));
  if (marriageDiff >= 5) {
    return { incompatible: true, reason: "marriage_view_conflict" };
  }
  const intimacyDiff = Math.abs(
    sliderValue(a.sliders, "intimacy_timing") - sliderValue(b.sliders, "intimacy_timing")
  );
  if (intimacyDiff >= 5) {
    return { incompatible: true, reason: "intimacy_timing_conflict" };
  }
  return { incompatible: false, reason: "" };
}

function crossPairScore(a, b, selfKey, partnerKey) {
  const aToB = sim7(sliderValue(a.sliders, selfKey), sliderValue(b.sliders, partnerKey));
  const bToA = sim7(sliderValue(b.sliders, selfKey), sliderValue(a.sliders, partnerKey));
  return (aToB + bToA) / 2;
}

function careComplementScore(a, b) {
  const av = sliderValue(a.sliders, "care_style");
  const bv = sliderValue(b.sliders, "care_style");
  // 互补优先：差值越大越好；但不过度惩罚相似（最低保底 0.5）
  return 0.5 + Math.abs(av - bv) / 12;
}

function computeSliderScore(a, b) {
  const crossScores = CROSS_PAIR_KEYS.map(([selfKey, partnerKey]) =>
    crossPairScore(a, b, selfKey, partnerKey)
  );
  crossScores.push(careComplementScore(a, b));
  const crossAvg = avg(crossScores);

  const restScores = NON_CROSS_KEYS.map((key) =>
    sim7(sliderValue(a.sliders, key), sliderValue(b.sliders, key))
  );
  const restAvg = avg(restScores);

  return {
    crossAvg,
    restAvg,
    total: crossAvg * 0.4 + restAvg * 0.6
  };
}

function lifeHabitScore(a, b) {
  return avg(HABIT_KEYS.map((key) => sim7(sliderValue(a.sliders, key), sliderValue(b.sliders, key))));
}

function marriageText(v) {
  if (v >= 5) return "偏向结婚";
  if (v <= 3) return "偏向不婚/谨慎婚姻";
  return "对婚姻态度中性";
}

function scheduleText(v) {
  if (v >= 5) return "早起规律型";
  if (v <= 3) return "夜猫子型";
  return "中间节律型";
}

function spendingText(v) {
  if (v >= 5) return "品质体验派";
  if (v <= 3) return "节俭务实派";
  return "平衡消费派";
}

function involutionText(v) {
  if (v >= 5) return "上进努力型";
  if (v <= 3) return "佛系躺平型";
  return "张弛有度型";
}

function socialText(v) {
  if (v >= 5) return "社牛外向型";
  if (v <= 3) return "安静内向型";
  return "内外兼修型";
}

function intimacyText(v) {
  if (v >= 5) return "热情快热型";
  if (v <= 3) return "稳重慢热型";
  return "节奏适中型";
}

function conflictText(v) {
  if (v >= 5) return "直接沟通型";
  if (v <= 3) return "冷静消化型";
  return "协商折衷型";
}

function buildReasons(a, b) {
  const reasons = [];

  // 1. Shared interest tags (more detailed)
  const shared = (a.values || []).filter((v) => (b.values || []).includes(v));
  if (shared.length >= 3) {
    reasons.push(`你们有${shared.length}个共同兴趣：${shared.slice(0, 3).join("、")}，话题天然丰富`);
  } else if (shared.length === 2) {
    reasons.push(`你们都喜欢${shared.join("和")}，这是很好的共同话题`);
  } else if (shared.length === 1) {
    reasons.push(`你们都关注「${shared[0]}」，可以从这里聊起`);
  }

  // 2. Marriage view alignment
  const marriageA = sliderValue(a.sliders, "marriage_view");
  const marriageB = sliderValue(b.sliders, "marriage_view");
  if (Math.abs(marriageA - marriageB) <= 1) {
    reasons.push(`婚恋观高度一致 — 双方都${marriageText((marriageA + marriageB) / 2)}，长远目标契合`);
  }

  // 3. Schedule alignment
  const scheduleA = sliderValue(a.sliders, "schedule");
  const scheduleB = sliderValue(b.sliders, "schedule");
  if (Math.abs(scheduleA - scheduleB) <= 1) {
    reasons.push(`作息节奏同步 — 都是${scheduleText((scheduleA + scheduleB) / 2)}，日常陪伴更自然`);
  }

  // 4. Care style complementarity
  const careComp = careComplementScore(a, b);
  if (careComp >= 0.75) {
    const careA = sliderValue(a.sliders, "care_style");
    const careB = sliderValue(b.sliders, "care_style");
    if (careA < careB) {
      reasons.push("照顾风格互补 — 你偏好被照顾，TA更喜欢照顾人，天然默契");
    } else {
      reasons.push("照顾风格互补 — 你偏好照顾人，TA乐于被关心，相处自然舒服");
    }
  }

  // 5. Spending style
  const spendingA = sliderValue(a.sliders, "spending_style");
  const spendingB = sliderValue(b.sliders, "spending_style");
  if (Math.abs(spendingA - spendingB) <= 1) {
    reasons.push(`消费观一致 — 都偏向${spendingText((spendingA + spendingB) / 2)}，在钱的事上少分歧`);
  }

  // 6. Social energy cross match
  const socialCross = crossPairScore(a, b, "social_self", "social_partner");
  if (socialCross >= 0.75) {
    reasons.push("社交能量匹配 — 你的社交风格恰好是TA期待的类型");
  }

  // 7. Involution/effort level match
  const invA = sliderValue(a.sliders, "involution_self");
  const invB = sliderValue(b.sliders, "involution_self");
  if (reasons.length < 5 && Math.abs(invA - invB) <= 1) {
    reasons.push(`努力程度相近 — 都是${involutionText((invA + invB) / 2)}，步调容易一致`);
  }

  // 8. Intimacy timing alignment
  const intimA = sliderValue(a.sliders, "intimacy_timing");
  const intimB = sliderValue(b.sliders, "intimacy_timing");
  if (reasons.length < 5 && Math.abs(intimA - intimB) <= 1) {
    reasons.push(`亲密节奏合拍 — 都是${intimacyText((intimA + intimB) / 2)}，推进关系更舒适`);
  }

  // 9. Conflict resolution style
  const conflA = sliderValue(a.sliders, "conflict_resolution");
  const conflB = sliderValue(b.sliders, "conflict_resolution");
  if (reasons.length < 5 && Math.abs(conflA - conflB) <= 1) {
    reasons.push(`处理冲突的方式相近 — 都偏${conflictText((conflA + conflB) / 2)}，减少沟通摩擦`);
  }

  // 10. Campus proximity
  if (reasons.length < 4 && a.campus && b.campus) {
    if (a.campus === b.campus) {
      reasons.push(`同在${a.campus}校区，线下见面零距离`);
    } else {
      reasons.push(`${a.campus} × ${b.campus}，校区通勤完全可行`);
    }
  }

  // 11. Grade proximity
  if (reasons.length < 4 && a.grade && b.grade) {
    const ga = GRADE_MAP[a.grade] || 3;
    const gb = GRADE_MAP[b.grade] || 3;
    if (ga === gb) {
      reasons.push(`同为${a.grade}，共享学业节奏和校园体验`);
    }
  }

  // Fallback reasons
  if (reasons.length < 3) {
    reasons.push("多维度问卷契合度良好，适合先从线下轻松聊天开始");
  }
  if (reasons.length < 3) {
    reasons.push("你们在核心量表上差异较小，关系推进节奏更容易对齐");
  }
  return reasons.slice(0, 6);
}

function computeConfidence(a, b, score) {
  // 1. Data completeness (0-1): how many sliders + values each user filled
  const aSliderCount = a.sliders ? Object.keys(a.sliders).filter((k) => a.sliders[k] != null).length : 0;
  const bSliderCount = b.sliders ? Object.keys(b.sliders).filter((k) => b.sliders[k] != null).length : 0;
  const sliderCompleteness = (aSliderCount + bSliderCount) / (ALL_SLIDER_KEYS.length * 2);
  const aValueCount = Math.min((a.values || []).length, 15);
  const bValueCount = Math.min((b.values || []).length, 15);
  const valueCompleteness = (aValueCount + bValueCount) / 30;
  const dataQuality = sliderCompleteness * 0.7 + valueCompleteness * 0.3;

  // 2. Score strength (0-1): higher scores = more confidence, with diminishing returns
  const scoreStrength = Math.min(1, score / 80);

  // 3. Differentiation (0-1): how spread the individual dimension scores are
  const tagSim = jaccard(a.values || [], b.values || []);
  const sliderTotal = computeSliderScore(a, b).total;
  const spread = Math.abs(tagSim - sliderTotal);
  const differentiation = Math.min(1, 0.5 + spread);

  const confidence = Math.round((dataQuality * 0.5 + scoreStrength * 0.35 + differentiation * 0.15) * 100);
  return Math.max(10, Math.min(99, confidence));
}

function confidenceLabel(confidence) {
  if (confidence >= 80) return "高";
  if (confidence >= 55) return "中";
  return "低";
}

function scorePair(a, b) {
  const breaker = checkDealbreaker(a, b);
  if (breaker.incompatible) {
    return { compatible: false, score: 0, reasons: [], confidence: 0 };
  }

  const tagSim = jaccard(a.values || [], b.values || []);
  const slider = computeSliderScore(a, b).total;
  const cScore = campusScore(a, b);
  const gScore = gradeScore(a, b);
  const habit = lifeHabitScore(a, b);

  const score = tagSim * 30 + slider * 40 + cScore * 10 + gScore * 10 + habit * 10;
  const confidence = computeConfidence(a, b, score);
  return {
    compatible: true,
    score,
    confidence,
    confidenceLabel: confidenceLabel(confidence),
    reasons: buildReasons(a, b)
  };
}

function getPairKey(aId, bId) {
  const a = Math.min(Number(aId || 0), Number(bId || 0));
  const b = Math.max(Number(aId || 0), Number(bId || 0));
  return `${a}:${b}`;
}

function historyPenaltyFactor(matchCount) {
  const count = Number(matchCount || 0);
  if (count <= 0) return 1;
  if (count === 1) return 0.3;
  if (count === 2) return 0.1;
  return 0;
}

function applyHistoricalPenalty(score, matchCount) {
  const factor = historyPenaltyFactor(matchCount);
  if (factor <= 0) {
    return {
      excluded: true,
      factor,
      score: 0
    };
  }
  return {
    excluded: false,
    factor,
    score: Number(score || 0) * factor
  };
}

function fairnessBonusByStreak(streak) {
  const n = Math.max(0, Number(streak || 0));
  if (n >= 3) return 10;
  if (n === 2) return 5;
  if (n === 1) return 2;
  return 0;
}

function resolveMinScore(raw, fallback = DEFAULT_MATCH_MIN_SCORE) {
  const n = Number(raw);
  if (!Number.isFinite(n)) return Math.max(0, Number(fallback || 0));
  return Math.max(0, n);
}

function buildCandidateEdges(
  users,
  {
    historicalCounts = new Map(),
    consecutiveUnmatchedWeeksByUser = new Map(),
    minScore = DEFAULT_MATCH_MIN_SCORE
  } = {}
) {
  const safeUsers = Array.isArray(users) ? users : [];
  const safeHistorical = historicalCounts instanceof Map ? historicalCounts : new Map();
  const safeStreaks = consecutiveUnmatchedWeeksByUser instanceof Map ? consecutiveUnmatchedWeeksByUser : new Map();
  const threshold = resolveMinScore(minScore, DEFAULT_MATCH_MIN_SCORE);

  const fairnessBonusByUser = new Map();
  for (const user of safeUsers) {
    const streak = Number(safeStreaks.get(user.id) || 0);
    fairnessBonusByUser.set(user.id, fairnessBonusByStreak(streak));
  }

  const preThresholdCountByUser = new Map();
  const postThresholdCountByUser = new Map();
  const edges = [];

  for (let i = 0; i < safeUsers.length; i += 1) {
    for (let j = i + 1; j < safeUsers.length; j += 1) {
      const a = safeUsers[i];
      const b = safeUsers[j];
      if (!basicCompatible(a, b)) continue;

      const scored = scorePair(a, b);
      if (!scored.compatible) continue;

      const pairKey = getPairKey(a.id, b.id);
      const historyCount = Number(safeHistorical.get(pairKey) || 0);
      const historyAdjusted = applyHistoricalPenalty(scored.score, historyCount);
      if (historyAdjusted.excluded) continue;

      const fairnessBonusA = Number(fairnessBonusByUser.get(a.id) || 0);
      const fairnessBonusB = Number(fairnessBonusByUser.get(b.id) || 0);
      const finalScore = Math.min(100, historyAdjusted.score + fairnessBonusA + fairnessBonusB);

      preThresholdCountByUser.set(a.id, Number(preThresholdCountByUser.get(a.id) || 0) + 1);
      preThresholdCountByUser.set(b.id, Number(preThresholdCountByUser.get(b.id) || 0) + 1);

      if (finalScore < threshold) continue;

      postThresholdCountByUser.set(a.id, Number(postThresholdCountByUser.get(a.id) || 0) + 1);
      postThresholdCountByUser.set(b.id, Number(postThresholdCountByUser.get(b.id) || 0) + 1);

      edges.push({
        userA: a.id,
        userB: b.id,
        score: Number(finalScore.toFixed(2)),
        confidence: scored.confidence,
        confidenceLabel: scored.confidenceLabel,
        reasons: scored.reasons,
        rawScore: Number(scored.score.toFixed(2)),
        historyCount,
        historyFactor: historyAdjusted.factor,
        fairnessBonusA,
        fairnessBonusB
      });
    }
  }

  edges.sort((x, y) => y.score - x.score);

  const belowThresholdUsers = [];
  for (const user of safeUsers) {
    const pre = Number(preThresholdCountByUser.get(user.id) || 0);
    const post = Number(postThresholdCountByUser.get(user.id) || 0);
    if (pre > 0 && post === 0) {
      belowThresholdUsers.push(user.id);
    }
  }

  return {
    edges,
    minScore: threshold,
    belowThresholdUsers,
    belowThresholdCount: belowThresholdUsers.length
  };
}

function runWeeklyMatch(week) {
  const users = getParticipantPool(week);
  const historical = getAllHistoricalPairs(week);
  const streakMap = new Map();
  for (const user of users) {
    streakMap.set(user.id, getConsecutiveUnmatchedWeeks(user.id, week));
  }
  const candidateOut = buildCandidateEdges(users, {
    historicalCounts: historical,
    consecutiveUnmatchedWeeksByUser: streakMap,
    minScore: config.matchMinScore
  });
  const edges = candidateOut.edges;

  // Build a quick lookup: pairKey -> edge
  const edgeMap = new Map();
  for (const e of edges) {
    const key = e.userA < e.userB ? `${e.userA}:${e.userB}` : `${e.userB}:${e.userA}`;
    edgeMap.set(key, e);
  }

  function getEdge(a, b) {
    const key = a < b ? `${a}:${b}` : `${b}:${a}`;
    return edgeMap.get(key) || null;
  }

  // Phase 0: Mutual crush instant-match
  const used = new Set();
  const pairs = [];
  let crushMatchCount = 0;
  try {
    const mutualCrushes = findMutualCrushes(week);
    const userMap = new Map();
    for (const u of users) userMap.set(u.id, u);
    for (const mc of mutualCrushes) {
      if (used.has(mc.user_a_id) || used.has(mc.user_b_id)) continue;
      const ua = userMap.get(mc.user_a_id);
      const ub = userMap.get(mc.user_b_id);
      if (!ua || !ub) continue;
      used.add(mc.user_a_id);
      used.add(mc.user_b_id);
      const edge = getEdge(mc.user_a_id, mc.user_b_id);
      const score = edge ? edge.score : 95;
      const reasons = ["双向心动！你们互相选择了对方 \u2764\ufe0f"];
      if (edge && edge.reasons && edge.reasons.length > 0) {
        reasons.push(...edge.reasons.slice(0, 2));
      }
      const conf = edge ? edge.confidence : 99;
      pairs.push({ userA: mc.user_a_id, userB: mc.user_b_id, score: Math.max(score, 95), confidence: conf, reasons });
      markCrushMatched(mc.user_a_id, week);
      markCrushMatched(mc.user_b_id, week);
      crushMatchCount += 1;
    }
  } catch (err) {
    // Crush table might not exist yet on first run; safe to skip
  }

  // Phase 1: Greedy
  for (const edge of edges) {
    if (used.has(edge.userA) || used.has(edge.userB)) continue;
    used.add(edge.userA);
    used.add(edge.userB);
    pairs.push({
      userA: edge.userA,
      userB: edge.userB,
      score: edge.score,
      confidence: edge.confidence,
      reasons: edge.reasons
    });
  }

  // Phase 2: Local search improvement (2-opt swaps)
  // Try swapping partners between pairs to improve total score
  let improved = true;
  let rounds = 0;
  const MAX_ROUNDS = 10;
  while (improved && rounds < MAX_ROUNDS) {
    improved = false;
    rounds += 1;
    for (let i = 0; i < pairs.length; i += 1) {
      for (let j = i + 1; j < pairs.length; j += 1) {
        const currentScore = pairs[i].score + pairs[j].score;

        // Try swap: pairs[i].userA with pairs[j].userA, pairs[i].userB with pairs[j].userB
        const alt1A = getEdge(pairs[i].userA, pairs[j].userB);
        const alt1B = getEdge(pairs[j].userA, pairs[i].userB);
        const alt1Score = (alt1A ? alt1A.score : 0) + (alt1B ? alt1B.score : 0);

        // Try swap: pairs[i].userA with pairs[j].userB, pairs[i].userB with pairs[j].userA
        const alt2A = getEdge(pairs[i].userA, pairs[j].userA);
        const alt2B = getEdge(pairs[i].userB, pairs[j].userB);
        const alt2Score = (alt2A ? alt2A.score : 0) + (alt2B ? alt2B.score : 0);

        if (alt1Score > currentScore && alt1Score >= alt2Score && alt1A && alt1B) {
          pairs[i] = { userA: alt1A.userA, userB: alt1A.userB, score: alt1A.score, confidence: alt1A.confidence, reasons: alt1A.reasons };
          pairs[j] = { userA: alt1B.userA, userB: alt1B.userB, score: alt1B.score, confidence: alt1B.confidence, reasons: alt1B.reasons };
          improved = true;
        } else if (alt2Score > currentScore && alt2A && alt2B) {
          pairs[i] = { userA: alt2A.userA, userB: alt2A.userB, score: alt2A.score, confidence: alt2A.confidence, reasons: alt2A.reasons };
          pairs[j] = { userA: alt2B.userA, userB: alt2B.userB, score: alt2B.score, confidence: alt2B.confidence, reasons: alt2B.reasons };
          improved = true;
        }
      }
    }
  }

  replaceWeekMatches(week, pairs);
  return {
    weekKey: week,
    participants: users.length,
    candidates: edges.length,
    matchedPairs: pairs.length,
    crushMatchedPairs: crushMatchCount,
    belowThresholdCount: candidateOut.belowThresholdCount
  };
}

function buildUnmatchedItem(user, reasonKey) {
  return {
    id: user.id,
    studentId: user.student_id,
    name: user.name,
    email: user.email,
    gender: user.gender || "",
    campus: user.campus || "",
    grade: user.grade || "",
    inPoolAt: user.opt_in_created_at || "",
    reasonKey,
    reasonText: unmatchedReasonText(reasonKey)
  };
}

function unmatchedReasonText(reasonKey) {
  if (reasonKey === "no_compatible_opposite") return "当周无异性兼容对象";
  if (reasonKey === "historical_blocked") return "所有兼容对象已被历史匹配过";
  if (reasonKey === "dealbreaker_filtered") return "被 dealbreaker 规则淘汰了所有候选";
  if (reasonKey === "below_threshold") return "候选匹配分均低于质量阈值";
  return "在全局配对排序中优先级靠后，暂未匹配";
}

function analyzeUnmatched(week) {
  const users = getParticipantPool(week);
  const historical = getAllHistoricalPairs(week);
  const matchedRows = listMatchesByWeek(week);
  const matchedUserIds = new Set();
  for (const row of matchedRows) {
    matchedUserIds.add(row.user_a_id);
    matchedUserIds.add(row.user_b_id);
  }

  const streakMap = new Map();
  for (const user of users) {
    streakMap.set(user.id, getConsecutiveUnmatchedWeeks(user.id, week));
  }

  const unmatchedUsers = users.filter((u) => !matchedUserIds.has(u.id));
  const items = unmatchedUsers.map((user) => {
    const others = users.filter((x) => x.id !== user.id);
    const oppositeCompatible = others.filter((other) => basicCompatible(user, other));
    if (!oppositeCompatible.length) {
      return buildUnmatchedItem(user, "no_compatible_opposite");
    }

    const historyAvailable = oppositeCompatible.filter((other) => {
      const pairKey = getPairKey(user.id, other.id);
      const count = Number(historical.get(pairKey) || 0);
      return historyPenaltyFactor(count) > 0;
    });
    if (!historyAvailable.length) {
      return buildUnmatchedItem(user, "historical_blocked");
    }

    const afterDealbreaker = historyAvailable.filter((other) => scorePair(user, other).compatible);
    if (!afterDealbreaker.length) {
      return buildUnmatchedItem(user, "dealbreaker_filtered");
    }

    const userBonus = fairnessBonusByStreak(streakMap.get(user.id) || 0);
    const threshold = resolveMinScore(config.matchMinScore, DEFAULT_MATCH_MIN_SCORE);
    const aboveThreshold = afterDealbreaker.filter((other) => {
      const scored = scorePair(user, other);
      if (!scored.compatible) return false;
      const pairKey = getPairKey(user.id, other.id);
      const historyCount = Number(historical.get(pairKey) || 0);
      const historyAdjusted = applyHistoricalPenalty(scored.score, historyCount);
      if (historyAdjusted.excluded) return false;
      const otherBonus = fairnessBonusByStreak(streakMap.get(other.id) || 0);
      const finalScore = Math.min(100, historyAdjusted.score + userBonus + otherBonus);
      return finalScore >= threshold;
    });
    if (!aboveThreshold.length) {
      return buildUnmatchedItem(user, "below_threshold");
    }

    return buildUnmatchedItem(user, "priority_unmatched");
  });

  const grouped = items.reduce((acc, item) => {
    const key = item.reasonKey || "unknown";
    acc[key] = (acc[key] || 0) + 1;
    return acc;
  }, {});

  return {
    weekKey: week,
    poolSize: users.length,
    matchedPairs: matchedRows.length,
    unmatchedCount: items.length,
    reasonBreakdown: grouped,
    items
  };
}

module.exports = {
  ALL_SLIDER_KEYS,
  runWeeklyMatch,
  analyzeUnmatched,
  buildCandidateEdges,
  scorePair,
  buildReasons,
  checkDealbreaker,
  computeSliderScore,
  lifeHabitScore,
  jaccard,
  historyPenaltyFactor,
  applyHistoricalPenalty,
  fairnessBonusByStreak,
  resolveMinScore,
  computeConfidence,
  confidenceLabel
};
