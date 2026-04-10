const OpenAI = require("openai");
const { config } = require("../config");

// Slider labels: index 0 = value 1, index 6 = value 7
const SLIDER_LABELS = {
  schedule:         ["深度夜猫子", "偏夜型", "略偏夜型", "中间节律", "略偏早型", "偏早型", "极度早起"],
  marriage_view:    ["坚定不婚", "倾向不婚", "谨慎观望", "中性态度", "考虑结婚", "倾向结婚", "非常想结婚"],
  involution_self:  ["完全躺平", "比较躺平", "偏躺平", "适度努力", "偏努力内卷", "比较卷", "极度内卷"],
  social_self:      ["极度宅内向", "比较内向", "偏内向", "内外向适中", "偏外向", "比较外向", "极度外向社牛"],
  spending_style:   ["极度节俭", "比较节俭", "偏节俭", "收支平衡", "偏品质消费", "比较追求品质", "极致品质体验"],
  care_style:       ["极喜欢被照顾", "偏喜欢被照顾", "略偏被照顾", "照顾双向均衡", "略偏照顾人", "偏喜欢照顾人", "极喜欢照顾人"],
  intimacy_timing:  ["极度慢热", "比较慢热", "偏慢热", "节奏适中", "偏快热", "比较快热", "极度快热"],
  dining_style:     ["超爱吃辣", "比较爱辣", "偏爱辣", "辛辣适中", "偏清淡", "比较清淡", "完全不吃辣"]
};

const KEY_SLIDERS = ["schedule", "marriage_view", "involution_self", "social_self", "spending_style", "care_style", "intimacy_timing"];

const SLIDER_NAMES = {
  schedule: "作息",
  marriage_view: "婚恋观",
  involution_self: "努力程度",
  social_self: "社交风格",
  spending_style: "消费观",
  care_style: "照顾风格",
  intimacy_timing: "亲密节奏"
};

let _client = null;

function getClient() {
  if (_client) return _client;
  const apiKey = config.llm.apiKey || process.env.SILICONFLOW_API_KEY;
  if (!apiKey) return null;
  _client = new OpenAI({
    apiKey,
    baseURL: config.llm.baseUrl || "https://api.siliconflow.cn/v1"
  });
  return _client;
}

function sliderLabel(sliders, key) {
  const raw = Number((sliders && sliders[key]) ?? 4);
  const v = Math.round(Math.min(7, Math.max(1, raw)));
  const labels = SLIDER_LABELS[key];
  return labels ? labels[v - 1] : `${v}/7`;
}

function formatProfile(user, questionnaire) {
  const sliders = (questionnaire && questionnaire.sliders) || {};
  const values = Array.isArray(questionnaire && questionnaire.values) ? questionnaire.values : [];
  const traitLines = KEY_SLIDERS.map((key) => `${SLIDER_NAMES[key]}：${sliderLabel(sliders, key)}`);
  return [
    `年级：${user.grade || "未知"}，校区：${user.campus || "未知"}，性别：${user.gender || "未知"}`,
    `兴趣与价值观：${values.slice(0, 8).join("、") || "未填写"}`,
    traitLines.join("；")
  ].join("\n");
}

/**
 * 为一对匹配用户生成 AI 分析报告。
 * 若未配置 SILICONFLOW_API_KEY 则返回 null（邮件退回原版格式）。
 *
 * @returns {Promise<string|null>} 报告正文文本，或 null
 */
async function generateMatchAnalysis({ userA, userB, questionnaireA, questionnaireB, score, reasons }) {
  const client = getClient();
  if (!client) return null;

  const profileA = formatProfile(userA, questionnaireA);
  const profileB = formatProfile(userB, questionnaireB);
  const reasonsList = Array.isArray(reasons) && reasons.length
    ? reasons.map((r) => `- ${String(r).trim()}`).join("\n")
    : "- 多维度问卷契合度较高";

  const prompt = `你是 SCU DateDrop 的智能匹配分析师，为四川大学的两位同学生成一份简短、真实、温暖的匹配分析。

匹配分数：${Number(score || 0).toFixed(1)} / 100

同学A 的档案：
${profileA}

同学B 的档案：
${profileB}

系统匹配理由：
${reasonsList}

请写一段 150-200 字的分析，结构如下：
1. 最突出的 1-2 个契合点（具体引用档案中的特征）
2. 一个值得探索的互补或差异点
3. 一个接地气的破冰小建议（结合校区/共同兴趣/具体场景）

语气：温暖、真实、朋友式，不夸张，不说"天生一对"之类的词。直接输出分析正文，无需标题或序号。`;

  const response = await client.chat.completions.create({
    model: config.llm.model || "Qwen/Qwen2.5-72B-Instruct",
    messages: [{ role: "user", content: prompt }],
    max_tokens: config.llm.maxTokens || 600,
    temperature: 0.7
  });

  const text = response.choices[0]?.message?.content?.trim() || null;
  return text || null;
}

module.exports = { generateMatchAnalysis };
