import { join } from "node:path";
import { createReply } from "./agent.ts";
import { createApp } from "./app.ts";
import { createJsonTaskStore } from "./task-store.ts";

// 智能体和任务 API 共用同一个存储实例，对话里的操作会立即反映到清单上。
const tasks = createJsonTaskStore(join("data", "tasks.json"));
const app = createApp({ reply: createReply(tasks), tasks });
const port = Number(process.env.PORT || 3000);
app.listen(port, "127.0.0.1", () => console.log(`小明智能体已启动：http://127.0.0.1:${port}`));
