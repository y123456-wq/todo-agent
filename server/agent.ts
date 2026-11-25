import { join } from "node:path";
import type { ChatMessage } from "../shared/chat.ts";
import { getModelClient, model } from "./model.ts";
import { createJsonTaskStore, type Task, type TaskChanges, type TaskStore } from "./task-store.ts";

export type { ChatMessage } from "../shared/chat.ts";

type Priority = "high" | "medium" | "low";
type Size = "small" | "medium" | "large";

/** 智能体把一句话解析成的一次操作。本地规则和模型都输出同一种结构。 */
type Action =
  | {
      kind: "create";
      title: string;
      due?: string;
      dueDate?: string;
      priority?: Priority;
      size?: Size;
      parentTitle?: string;
      allowDuplicate?: boolean;
    }
  | { kind: "list"; dueOnly?: boolean; openOnly?: boolean }
  | { kind: "complete"; keywords: string[]; ids?: string[] }
  | { kind: "delete"; keywords: string[]; ids?: string[] }
  | { kind: "rename"; keywords: string[]; title: string; ids?: string[] }
  | { kind: "setPriority"; keywords: string[]; priority: Priority; ids?: string[] }
  | { kind: "help" }
  | { kind: "chat"; text: string };

const PRIORITY_LABEL: Record<Priority, string> = { high: "高", medium: "中", low: "低" };
const SIZE_LABEL: Record<Size, string> = { small: "小", medium: "中", large: "大" };
// 低于这个相似度就不擅自改动任务，宁可让用户确认。
const MATCH_THRESHOLD = 0.42;
// 前两名差距小于这个值视为歧义，避免误操作相似标题。
const AMBIGUOUS_GAP = 0.1;

// ---------------------------------------------------------------------------
// 文本工具
// ---------------------------------------------------------------------------

function stripPunctuation(value: string): string {
  return value.replace(/[\s，。！？、,.!?：:；;"'“”‘’()（）【】{}「」]/g, "");
}

function grams(value: string): Set<string> {
  const result = new Set<string>();
  for (const character of value) result.add(character);
  for (let index = 0; index < value.length - 1; index += 1)
    result.add(value.slice(index, index + 2));
  return result;
}

/** 中文短句用「单字 + 相邻二字」的集合重合度，比纯编辑距离更能容忍词序变化。 */
function similarity(left: string, right: string): number {
  const a = stripPunctuation(left).toLowerCase();
  const b = stripPunctuation(right).toLowerCase();
  if (!a || !b) return 0;
  if (a === b) return 1;
  if (a.includes(b) || b.includes(a)) {
    return 0.75 + (0.25 * Math.min(a.length, b.length)) / Math.max(a.length, b.length);
  }
  const ga = grams(a);
  const gb = grams(b);
  let shared = 0;
  for (const gram of ga) if (gb.has(gram)) shared += 1;
  return shared / (ga.size + gb.size - shared);
}

/** 去掉对话里的动作词、语气词和指示代词，留下用于匹配任务的关键词。 */
function cleanKeyword(raw: string): string {
  let value = raw.trim();
  value = value.replace(/^(我)?(已经|已|把|将|请|帮我|帮忙|麻烦|给我|就)/, "");
  value = value.replace(/(吧|呢|啊|呀|哦|啦|哈|嘛|了)$/, "");
  value = value.replace(
    /(标记为已完成|标记为完成|标记完成|设置为完成|设为完成|已完成|完成了|完成|做好了|做好|弄好了|弄好|搞定了|搞定|办完了|办完|做完了|做完|删掉了|删掉|删除了|删除|移除了|移除|去掉了|去掉|取消了|取消|清除了|清除|好了|好)$/,
    "",
  );
  value = value.replace(/(这一条|这条|那一条|那个|这个|一项|一条|一个)$/, "");
  value = value.replace(/^(把|将|给)/, "");
  return stripPunctuation(value);
}

function splitKeywords(raw: string): string[] {
  return raw
    .split(/[和跟与、,，以及]+/)
    .map(cleanKeyword)
    .filter(Boolean);
}

interface DueInfo {
  due?: string;
  dueDate?: string;
  rest: string;
}

/** 从句子里抽取「明天 / 周六下午 / 3 点半」等时间，返回去掉时间后的文本。 */
function parseDue(text: string): DueInfo {
  let rest = text;
  const now = new Date();
  let day: Date | null = null;
  let dayLabel = "";

  const relative = rest.match(/(大后天|后天|明天|今天)/);
  if (relative) {
    const offsets: Record<string, number> = { 今天: 0, 明天: 1, 后天: 2, 大后天: 3 };
    day = new Date(now.getFullYear(), now.getMonth(), now.getDate() + offsets[relative[0]]);
    dayLabel = relative[0];
    rest = rest.replace(relative[0], "");
  } else {
    const weekly = rest.match(/(下)?(?:周|星期)([一二三四五六日天1-7])/);
    if (weekly) {
      const weekdays: Record<string, number> = {
        一: 1,
        二: 2,
        三: 3,
        四: 4,
        五: 5,
        六: 6,
        日: 0,
        天: 0,
        1: 1,
        2: 2,
        3: 3,
        4: 4,
        5: 5,
        6: 6,
        7: 0,
      };
      let delta = (weekdays[weekly[2]] - now.getDay() + 7) % 7;
      if (weekly[1]) delta += 7;
      else if (delta === 0) delta = 7;
      day = new Date(now.getFullYear(), now.getMonth(), now.getDate() + delta);
      dayLabel = `${weekly[1] ?? ""}周${weekly[2]}`;
      rest = rest.replace(weekly[0], "");
    }
  }

  let timeLabel = "";
  // 支持「3 点」「3 点半」以及「15:00」两种写法。
  const clock = rest.match(
    /(上午|中午|下午|晚上|早上)?\s*(\d{1,2})\s*[:点时]\s*(\d{1,2})?(半|分)?/,
  );
  if (clock) {
    let hour = Number(clock[2]);
    if (clock[1] === "下午" || clock[1] === "晚上") hour += hour < 12 ? 12 : 0;
    if (clock[1] === "中午" && hour < 11) hour = 12;
    const minute = clock[4] === "半" ? "30" : clock[3] ? clock[3].padStart(2, "0") : "00";
    timeLabel = `${String(hour).padStart(2, "0")}:${minute}`;
    rest = rest.replace(clock[0], "");
  } else {
    const period = rest.match(/上午|中午|下午|晚上|早上/);
    if (period) {
      timeLabel = period[0];
      rest = rest.replace(period[0], "");
    }
  }

  if (!day && !timeLabel) return { rest };
  if (!day) day = now;
  const dueDate = `${day.getFullYear()}-${String(day.getMonth() + 1).padStart(2, "0")}-${String(day.getDate()).padStart(2, "0")}`;
  const due = [dayLabel || dueDate, timeLabel].filter(Boolean).join(" ");
  return { due, dueDate, rest };
}

const CREATE_MARKERS = [
  "帮我记一下",
  "帮我记下",
  "帮我记住",
  "帮我添加",
  "帮我新增",
  "帮我创建",
  "帮我新建",
  "帮我加",
  "帮我记",
  "记一下",
  "记下",
  "记住",
  "添加",
  "新增",
  "创建",
  "新建",
  "加一条",
  "加一个",
  "加个",
  "提醒我",
  "一条",
  "记",
  "加",
  "要",
];

function detectIntent(text: string): Action["kind"] {
  if (/^(你好|您好|嗨|hi|hello)\s*[!！。.~～]*$/i.test(text)) return "help";
  // 短寒暄不应当被当成一条待办；带操作词的句子仍然按操作处理。
  if (
    text.length <= 12 &&
    /^(随便聊|闲聊|聊聊|在吗|在么|谢谢|好的|收到|嗯|ok\b)/i.test(text) &&
    !/(记|添加|删除|完成|清单|任务|待办)/.test(text)
  ) {
    return "chat";
  }
  // 明确的创建说法优先于属性设置，如「提醒我明天开会，优先级高」。
  if (
    /(提醒我|记一下|记下|记住|记一条|记个|帮我记|添加|新增|创建|新建|加一条|加个|子任务)/.test(text)
  ) {
    return "create";
  }
  if (/(删掉|删除|移除|去掉|取消|清除|不要了|删了)/.test(text)) return "delete";
  if (
    /(标记为已完成|标记为完成|标记完成|已完成|完成了|完成|做好了|做好|弄好了|搞定了|办完了|办完|做完了|做完|好了)/.test(
      text,
    )
  ) {
    return "complete";
  }
  if (/(改名为|改叫|重命名为|改成)/.test(text)) return "rename";
  if (/(优先级|重要程度)/.test(text)) return "setPriority";
  if (/(有哪些|什么任务|看看|列一下|列出|清单|列表|待办|有什么|还剩|进度|到期|要做)/.test(text)) {
    return "list";
  }
  return "create";
}

/** 本地规则解析：不依赖网络与密钥，保证开箱即可用。 */
function parseLocally(text: string): Action {
  const intent = detectIntent(text);

  if (intent === "help") {
    return {
      kind: "help",
    };
  }

  if (intent === "chat") {
    return { kind: "chat", text };
  }

  if (intent === "list") {
    return {
      kind: "list",
      dueOnly: /到期|截止|今天.*(任务|待办)/.test(text),
      openOnly: /未完成|还没做|待处理/.test(text),
    };
  }

  if (intent === "complete" || intent === "delete") {
    let subject = text
      .replace(/^(我)?(已经|已|把|将|请|帮我|帮忙|麻烦|给我)/, "")
      .replace(/(吧|呢|啊|呀|哦|啦|哈|嘛|了)$/, "")
      .replace(
        /(标记为已完成|标记为完成|标记完成|设置为完成|设为完成|已完成|完成了|完成|做好了|做好|弄好了|搞定了|办完了|办完|做完了|做完|删掉了|删掉|删除了|删除|移除了|移除|去掉了|去掉|取消了|取消|清除了|清除|好了|好)$/,
        "",
      )
      .replace(/(这一条|这条|那一条|那个|这个|一项|一条|一个)$/, "");
    const keywords = splitKeywords(subject || cleanKeyword(text));
    return { kind: intent, keywords };
  }

  if (intent === "rename") {
    const match = text.match(/(?:改名为|改叫|重命名为|改成)\s*(.+)$/);
    const title = stripPunctuation(match?.[1] ?? "");
    const keywords = splitKeywords(text.split(/改名为|改叫|重命名为|改成/)[0]);
    if (!title) return { kind: "chat", text };
    return { kind: "rename", keywords, title };
  }

  if (intent === "setPriority") {
    const priority: Priority = /高|重要|紧急/.test(text)
      ? "high"
      : /低/.test(text)
        ? "low"
        : "medium";
    const keywords = splitKeywords(
      text
        .replace(/(优先级|重要程度|设为|设置为|设成|改成|的)/g, "")
        .replace(/(高|中|低|重要|紧急)/g, ""),
    );
    return { kind: "setPriority", priority, keywords };
  }

  // 创建：依次剥掉称呼、动作词、量词和时间，剩下的是标题。
  let subject = text.replace(/^(再|又|还|顺便|然后|请|麻烦|帮忙|帮我|我|给我)/, "");
  for (const marker of CREATE_MARKERS) {
    if (subject.startsWith(marker)) {
      subject = subject.slice(marker.length);
      break;
    }
  }
  subject = subject.replace(/^(一条|一个|个|一|新的)/, "");
  const due = parseDue(subject);
  // 优先级、工作量是任务属性，不能混进标题。
  let title = due.rest
    .replace(/优先级\s*[高中低]/g, "")
    .replace(/[高中低]\s*优先级/g, "")
    .replace(/工作量\s*[小中大]/g, "")
    .replace(/[小中大]\s*工作量/g, "")
    .replace(/(重要|紧急)/g, "");
  title = stripPunctuation(title)
    .replace(/(吧|呢|啊|呀|哦|啦|哈|嘛)$/, "")
    .trim();

  // 子任务：如「给写报告加个子任务 收集资料」。
  let parentTitle: string | undefined;
  const sub = text.match(/(?:给|为)\s*(.+?)\s*(?:加|添加)(?:一个|个)?子任务[:：\s]*(.*)$/);
  if (sub) {
    title = stripPunctuation(sub[2]);
    parentTitle = sub[1];
  } else if (/(子任务|子待办)/.test(text)) {
    title = stripPunctuation(text.replace(/(子任务|子待办|加|添加|新建|一个|个)/g, ""));
  }

  if (!title) {
    // 纯陈述句（如「周六下午洗衣服」）在前面已剥掉时间，这里兜底直接用原文。
    title = stripPunctuation(text);
  }

  const priority: Priority | undefined = /紧急|优先级高|重要/.test(text)
    ? "high"
    : /优先级低|不重要/.test(text)
      ? "low"
      : undefined;
  let size: Size | undefined;
  const sizeMatch = text.match(/工作量\s*([小中大])|([小中大])\s*工作量|([小中大])任务量/);
  if (sizeMatch) {
    const sizeLabels: Record<string, Size> = { 小: "small", 中: "medium", 大: "large" };
    size = sizeLabels[sizeMatch[1] ?? sizeMatch[2] ?? sizeMatch[3] ?? ""];
  }

  return {
    kind: "create",
    title: title.slice(0, 200),
    due: due.due,
    dueDate: due.dueDate,
    priority,
    size,
    parentTitle,
    allowDuplicate: /再|又|还/.test(text),
  };
}

// ---------------------------------------------------------------------------
// 目标解析与执行
// ---------------------------------------------------------------------------

interface Resolution {
  targets: Task[];
  ambiguous: Array<{ keyword: string; candidates: Task[] }>;
  missing: string[];
}

function rankMatches(
  tasks: Task[],
  keyword: string,
  ids?: string[],
): Array<{ task: Task; score: number }> {
  if (ids?.length) {
    return tasks.filter((task) => ids.includes(task.id)).map((task) => ({ task, score: 1 }));
  }
  const target = cleanKeyword(keyword);
  if (!target) return [];
  return tasks
    .map((task) => ({ task, score: similarity(target, stripPunctuation(task.title)) }))
    .filter((entry) => entry.score >= MATCH_THRESHOLD)
    .sort((a, b) => b.score - a.score);
}

function resolveTargets(tasks: Task[], keywords: string[], ids?: string[]): Resolution {
  const resolution: Resolution = { targets: [], ambiguous: [], missing: [] };
  for (const keyword of keywords.length ? keywords : [""]) {
    const ranked = rankMatches(tasks, keyword, ids);
    if (ranked.length === 0) {
      resolution.missing.push(keyword);
      continue;
    }
    if (
      ranked.length > 1 &&
      ranked[0].score - ranked[1].score < AMBIGUOUS_GAP &&
      ranked[1].score >= MATCH_THRESHOLD
    ) {
      resolution.ambiguous.push({
        keyword,
        candidates: ranked.slice(0, 3).map((entry) => entry.task),
      });
      continue;
    }
    if (!resolution.targets.some((task) => task.id === ranked[0].task.id))
      resolution.targets.push(ranked[0].task);
  }
  return resolution;
}

function describeTask(task: Task): string {
  const parts = [task.title];
  if (task.due) parts.push(`截止 ${task.due}`);
  if (task.priority)
    parts.push(`优先级${PRIORITY_LABEL[task.priority as Priority] ?? task.priority}`);
  if (task.size) parts.push(`工作量${SIZE_LABEL[task.size as Size] ?? task.size}`);
  return parts.join(" · ");
}

function formatList(tasks: Task[], heading = "你的待办清单"): string {
  if (tasks.length === 0) {
    return "📭 清单是空的，还没有待办。说「记一下买牛奶」，我就帮你加上。";
  }
  const pending = tasks.filter((task) => !task.done).length;
  const lines = [`📋 ${heading}（共 ${tasks.length} 条，待处理 ${pending} 条）`];
  const topLevel = tasks.filter((task) => !task.parentId);
  const orphans = tasks.filter(
    (task) => task.parentId && !tasks.some((parent) => parent.id === task.parentId),
  );
  let number = 0;
  const render = (task: Task, indent: string) => {
    number += 1;
    const prefix = indent ? `${indent}└ ` : `${number}. `;
    lines.push(`${task.done ? "✅" : "⬜"} ${prefix}${describeTask(task)}`);
  };
  for (const task of topLevel) {
    render(task, "");
    for (const child of tasks.filter((item) => item.parentId === task.id)) render(child, "   ");
  }
  for (const task of orphans) render(task, "");
  lines.push(pending === 0 ? "🎉 全部完成，做得漂亮！" : `💡 还有 ${pending} 件事等着你。`);
  return lines.join("\n");
}

function clarification(resolution: Resolution): string | null {
  if (resolution.ambiguous.length) {
    const detail = resolution.ambiguous
      .map(
        ({ keyword, candidates }) =>
          `「${keyword}」可能指：${candidates.map((task) => task.title).join("、")}`,
      )
      .join("；");
    return `我不太确定你说的是哪一条。${detail}。请说得更具体一点，我再帮你操作。`;
  }
  return null;
}

function execute(action: Action, store: TaskStore): string {
  switch (action.kind) {
    case "help":
      return [
        "你好！我是小明，可以帮你管理待办 😊",
        "· 记一件事：「帮我记一下买牛奶」「周六下午洗衣服」",
        "· 看清单：「我有哪些任务？」「今天有哪些任务到期？」",
        "· 完成：「牛奶买好了」「把取快递标记为完成」",
        "· 删除：「取快递这条删掉吧」",
        "· 还能设置优先级、工作量，以及创建子任务。",
      ].join("\n");

    case "chat":
      return /^(随便聊|闲聊|聊聊|在吗|在么|谢谢|好的|收到|嗯|ok)/i.test(action.text)
        ? "我在呢 😊 有什么待办要我帮忙吗？"
        : "我没太理解这句话。你可以说「记一下买牛奶」「看看清单」「牛奶买好了」或者「删掉取快递」。";

    case "list": {
      let items = store.list();
      if (action.openOnly) items = items.filter((task) => !task.done);
      if (action.dueOnly) {
        const today = new Date();
        const key = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, "0")}-${String(today.getDate()).padStart(2, "0")}`;
        items = items.filter(
          (task) =>
            !task.done &&
            (task.dueDate === key || (typeof task.due === "string" && /今天/.test(task.due))),
        );
        if (items.length === 0)
          return `📅 今天没有到期的任务。${store.list().length ? "要不要看看完整清单？" : ""}`;
        return formatList(items, "今天到期的任务");
      }
      return formatList(items);
    }

    case "create": {
      const title = stripPunctuation(action.title).slice(0, 200);
      if (!title) return "任务标题是空的，请告诉我具体要做什么。";
      const duplicate = store.list().find((task) => stripPunctuation(task.title) === title);
      if (duplicate && !action.allowDuplicate) {
        return `「${title}」已经在清单里了（${duplicate.done ? "已完成" : "待处理"}），我没有重复添加。`;
      }

      let parentId: string | undefined;
      if (action.parentTitle) {
        // 本地规则传标题，模型可能直接传 id，两种都接受。
        const direct = store.list().find((item) => item.id === action.parentTitle);
        const parent = direct ? { task: direct } : rankMatches(store.list(), action.parentTitle)[0];
        if (!parent) return `没找到「${action.parentTitle}」这条任务，子任务没有创建。`;
        parentId = parent.task.id;
      }

      const task = store.create(title);
      const changes: TaskChanges = {};
      if (action.due) changes.due = action.due;
      if (action.dueDate) changes.dueDate = action.dueDate;
      if (action.priority) changes.priority = action.priority;
      if (action.size) changes.size = action.size;
      if (parentId) changes.parentId = parentId;
      store.update(task.id, changes);

      const extras = [
        action.due ? `截止 ${action.due}` : "",
        action.priority ? `优先级${PRIORITY_LABEL[action.priority]}` : "",
        action.size ? `工作量${SIZE_LABEL[action.size]}` : "",
        parentId ? "已作为子任务" : "",
      ]
        .filter(Boolean)
        .join("，");
      return `✅ 已记下「${title}」${extras ? `（${extras}）` : ""}。现在一共 ${store.list().length} 条任务。`;
    }

    case "complete":
    case "delete":
    case "rename":
    case "setPriority": {
      const tasks = store.list();
      if (tasks.length === 0) return "清单是空的，没有可以操作的任务。";
      const keywords =
        action.kind === "rename" || action.kind === "setPriority"
          ? action.keywords
          : action.keywords;
      const resolution = resolveTargets(tasks, keywords, action.ids);
      const needClarify = clarification(resolution);
      if (needClarify) return needClarify;
      if (!resolution.targets.length) {
        const name = keywords.map((keyword) => `「${keyword}」`).join("、") || "这条任务";
        return `没找到${name}。${formatList(tasks)}`;
      }

      const changed: string[] = [];
      const skipped: string[] = [];
      for (const task of resolution.targets) {
        if (action.kind === "complete") {
          if (task.done) {
            skipped.push(`${task.title}（本来就完成了）`);
            continue;
          }
          store.update(task.id, { done: true });
          changed.push(task.title);
        } else if (action.kind === "delete") {
          store.remove(task.id);
          for (const child of tasks.filter((item) => item.parentId === task.id))
            store.remove(child.id);
          changed.push(task.title);
        } else if (action.kind === "rename") {
          store.update(task.id, { title: action.title });
          changed.push(`${task.title} → ${action.title}`);
        } else {
          store.update(task.id, { priority: action.priority });
          changed.push(`${task.title}（优先级${PRIORITY_LABEL[action.priority]}）`);
        }
      }

      const verb = {
        complete: "✅ 已完成",
        delete: "🗑️ 已删除",
        rename: "✏️ 已改名",
        setPriority: "⚙️ 已更新",
      }[action.kind];
      const lines: string[] = [];
      if (changed.length) lines.push(`${verb}：${changed.join("、")}。`);
      else if (skipped.length) lines.push(`这些任务已经处理过了：${skipped.join("、")}。`);
      if (skipped.length && changed.length) lines.push(`跳过：${skipped.join("、")}。`);
      if (resolution.missing.length)
        lines.push(`没找到：${resolution.missing.map((item) => `「${item}」`).join("、")}。`);
      if (action.kind === "delete") lines.push(formatList(store.list()));
      return lines.join("\n");
    }
  }
}

// ---------------------------------------------------------------------------
// 大模型增强（可选）：把 DeepSeek 的 Function Calling 映射成同一个 Action。
// ---------------------------------------------------------------------------

const SYSTEM_PROMPT = `你是中文待办助手「小明」。根据用户最后一句话和当前任务清单，选择一个工具来操作任务。
- 用任务标题做模糊匹配，用户可能省略动词，如「牛奶买好了」「取快递这条删掉吧」。
- 创建任务时提取简洁标题，并尽量解析截止日期 dueDate（YYYY-MM-DD）和可读的 due。
- 有多个可能目标且不确定时，不要猜测，用 chat_reply 请用户澄清。
- 不要编造不存在的任务 id；ids 必须来自当前清单。
当前清单（JSON）：`;

const TOOL_DEFINITIONS = [
  {
    type: "function" as const,
    function: {
      name: "create_task",
      description: "创建一条待办任务",
      parameters: {
        type: "object",
        properties: {
          title: { type: "string", description: "简洁的任务标题" },
          due: { type: "string", description: "可读的截止时间，如 明天 15:00" },
          dueDate: { type: "string", description: "YYYY-MM-DD" },
          priority: { type: "string", enum: ["high", "medium", "low"] },
          size: { type: "string", enum: ["small", "medium", "large"] },
          parentId: { type: "string", description: "父任务 id，创建子任务时使用" },
        },
        required: ["title"],
      },
    },
  },
  {
    type: "function" as const,
    function: {
      name: "list_tasks",
      description: "列出任务。dueOnly 表示只看今天到期，openOnly 表示只看未完成",
      parameters: {
        type: "object",
        properties: { dueOnly: { type: "boolean" }, openOnly: { type: "boolean" } },
      },
    },
  },
  {
    type: "function" as const,
    function: {
      name: "complete_tasks",
      description: "把指定任务标记为已完成",
      parameters: {
        type: "object",
        properties: { ids: { type: "array", items: { type: "string" } } },
        required: ["ids"],
      },
    },
  },
  {
    type: "function" as const,
    function: {
      name: "delete_tasks",
      description: "删除指定任务",
      parameters: {
        type: "object",
        properties: { ids: { type: "array", items: { type: "string" } } },
        required: ["ids"],
      },
    },
  },
  {
    type: "function" as const,
    function: {
      name: "rename_task",
      description: "修改任务标题",
      parameters: {
        type: "object",
        properties: {
          id: { type: "string" },
          title: { type: "string" },
        },
        required: ["id", "title"],
      },
    },
  },
  {
    type: "function" as const,
    function: {
      name: "chat_reply",
      description: "闲聊、问候或需要用户澄清时直接回复",
      parameters: {
        type: "object",
        properties: { text: { type: "string" } },
        required: ["text"],
      },
    },
  },
];

function actionFromTool(name: string, args: Record<string, unknown>): Action | null {
  const ids = Array.isArray(args.ids)
    ? args.ids.filter((id): id is string => typeof id === "string")
    : undefined;
  switch (name) {
    case "create_task":
      return typeof args.title === "string"
        ? {
            kind: "create",
            title: args.title.slice(0, 200),
            due: typeof args.due === "string" ? args.due : undefined,
            dueDate: typeof args.dueDate === "string" ? args.dueDate : undefined,
            priority: isPriority(args.priority) ? args.priority : undefined,
            size: isSize(args.size) ? args.size : undefined,
            parentTitle: typeof args.parentId === "string" ? args.parentId : undefined,
          }
        : null;
    case "list_tasks":
      return { kind: "list", dueOnly: args.dueOnly === true, openOnly: args.openOnly === true };
    case "complete_tasks":
      return ids?.length ? { kind: "complete", keywords: [], ids } : null;
    case "delete_tasks":
      return ids?.length ? { kind: "delete", keywords: [], ids } : null;
    case "rename_task":
      return typeof args.id === "string" && typeof args.title === "string"
        ? { kind: "rename", keywords: [], title: args.title.slice(0, 200), ids: [args.id] }
        : null;
    case "chat_reply":
      return typeof args.text === "string" ? { kind: "chat", text: args.text.slice(0, 500) } : null;
    default:
      return null;
  }
}

function isPriority(value: unknown): value is Priority {
  return value === "high" || value === "medium" || value === "low";
}

function isSize(value: unknown): value is Size {
  return value === "small" || value === "medium" || value === "large";
}

async function parseWithModel(messages: ChatMessage[], store: TaskStore): Promise<Action | null> {
  if (!process.env.DEEPSEEK_API_KEY) return null;
  try {
    const client = getModelClient();
    const snapshot = store.list().map((task) => ({
      id: task.id,
      title: task.title,
      done: task.done,
      due: task.due ?? null,
      dueDate: task.dueDate ?? null,
      parentId: task.parentId ?? null,
    }));
    const response = await client.chat.completions.create({
      model,
      temperature: 0,
      messages: [
        { role: "system", content: `${SYSTEM_PROMPT}${JSON.stringify(snapshot)}` },
        ...messages.map((message) => ({ role: message.role, content: message.content })),
      ],
      tools: TOOL_DEFINITIONS,
      tool_choice: "auto",
    });
    const call = response.choices[0]?.message?.tool_calls?.[0];
    if (!call || call.type !== "function") return null;
    const args: unknown = JSON.parse(call.function.arguments || "{}");
    if (typeof args !== "object" || args === null) return null;
    return actionFromTool(call.function.name, args as Record<string, unknown>);
  } catch (error) {
    // 模型不可用时静默降级到本地规则，保证功能始终可用。
    console.error("[小明] 模型解析失败，已回退本地规则：", error);
    return null;
  }
}

// ---------------------------------------------------------------------------
// 对外入口
// ---------------------------------------------------------------------------

export function createReply(store: TaskStore) {
  return async function reply(messages: ChatMessage[]): Promise<string> {
    const latest = messages.at(-1);
    if (!latest) return "你好，欢迎使用小明智能体";

    const action = (await parseWithModel(messages, store)) ?? parseLocally(latest.content);
    return execute(action, store);
  };
}

/** 兼容默认入口：推荐由 server/index.ts 用 createReply 注入同一个任务存储。 */
export async function reply(messages: ChatMessage[]): Promise<string> {
  return createReply(createJsonTaskStore(join("data", "tasks.json")))(messages);
}
