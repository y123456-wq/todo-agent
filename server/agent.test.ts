import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import type { ChatMessage } from "../shared/chat.ts";
import { createReply } from "./agent.ts";
import { createJsonTaskStore } from "./task-store.ts";

async function setup(t: TestContext) {
  // 这些用例验证本地规则引擎；移除密钥避免测试真的调用模型。
  const originalKey = process.env.DEEPSEEK_API_KEY;
  delete process.env.DEEPSEEK_API_KEY;
  t.after(() => {
    if (originalKey === undefined) delete process.env.DEEPSEEK_API_KEY;
    else process.env.DEEPSEEK_API_KEY = originalKey;
  });

  const directory = await mkdtemp(join(tmpdir(), "todo-agent-reply-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const filename = join(directory, "tasks.json");
  const tasks = createJsonTaskStore(filename);
  const reply = createReply(tasks);
  const history: ChatMessage[] = [];

  async function say(content: string): Promise<string> {
    history.push({ role: "user", content });
    const answer = await reply(history);
    history.push({ role: "assistant", content: answer });
    return answer;
  }

  return { tasks, filename, say };
}

test("中文对话可以创建、查看、完成并删除任务", async (t) => {
  const { tasks, say } = await setup(t);

  assert.match(await say("帮我记一下买牛奶"), /买牛奶/);
  assert.match(await say("再记一条取快递"), /取快递/);
  assert.equal(tasks.list().length, 2);

  const listed = await say("我有哪些任务？");
  assert.match(listed, /买牛奶/);
  assert.match(listed, /取快递/);
  assert.match(listed, /待处理 2 条/);

  assert.match(await say("牛奶买好了"), /已完成/);
  assert.equal(tasks.list().find((task) => task.title === "买牛奶")?.done, true);
  assert.equal(tasks.list().find((task) => task.title === "取快递")?.done, false);

  assert.match(await say("取快递这条删掉吧"), /已删除/);
  assert.deepEqual(
    tasks.list().map((task) => task.title),
    ["买牛奶"],
  );
  assert.match(await say("再给我看看清单"), /✅ 1\. 买牛奶/);
});

test("省略动词的说法按字符相似度匹配到正确任务", async (t) => {
  const { tasks, say } = await setup(t);
  await say("记一下买牛奶");
  await say("记一下买面包");

  const answer = await say("牛奶买好了");
  assert.match(answer, /已完成：买牛奶/);
  assert.equal(tasks.list().find((task) => task.title === "买牛奶")?.done, true);
  assert.equal(tasks.list().find((task) => task.title === "买面包")?.done, false);
});

test("能解析到期时间、优先级、工作量和子任务", async (t) => {
  const { tasks, say } = await setup(t);
  await say("提醒我明天 15:00 开会，优先级高，工作量大");

  const meeting = tasks.list()[0];
  assert.equal(meeting.title, "开会");
  assert.match(String(meeting.due), /明天 15:00/);
  assert.equal(meeting.priority, "high");
  assert.equal(meeting.size, "large");

  await say("给开会加个子任务 准备材料");
  assert.equal(tasks.list().length, 2);
  assert.equal(tasks.list()[1].title, "准备材料");
  assert.equal(tasks.list()[1].parentId, meeting.id);

  await say("准备材料好了");
  assert.equal(tasks.list()[1].done, true);
});

test("重复标题和不存在的任务都有明确反馈", async (t) => {
  const { tasks, say } = await setup(t);
  await say("帮我记一下买牛奶");

  assert.match(await say("记一下买牛奶"), /已经在清单里/);
  assert.equal(tasks.list().length, 1);

  assert.match(await say("把不存在的东西删掉"), /没找到/);
  assert.equal(tasks.list().length, 1);

  assert.match(await say("你好"), /我是小明/);
  assert.match(await say("随便聊两句"), /有什么待办/);
});

test("任务写入文件，新的存储实例也能读到", async (t) => {
  const { tasks, filename, say } = await setup(t);
  await say("记一下买牛奶");
  assert.deepEqual(createJsonTaskStore(filename).list(), tasks.list());
});
