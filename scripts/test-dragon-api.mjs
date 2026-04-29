import { readFileSync } from "node:fs";

const DRAGON_BASE_URL = "https://dragoncode.codes/gpt-image/v1";
const TINY_PNG_DATA_URI =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII=";

function loadEnv(path = ".env.local") {
  const env = { ...process.env };

  for (const line of readFileSync(path, "utf8").split(/\r?\n/)) {
    const match = line.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
    if (match && !env[match[1]]) {
      env[match[1]] = match[2].replace(/^["']|["']$/g, "");
    }
  }

  return env;
}

function summarizeResponseText(text, taskId) {
  if (taskId) {
    return undefined;
  }

  return text.replace(/\s+/g, " ").slice(0, 260);
}

async function submitCase(name, apiKey, payload) {
  const startedAt = Date.now();
  const response = await fetch(`${DRAGON_BASE_URL}/images/generations`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify(payload)
  });
  const text = await response.text();
  let json = null;

  try {
    json = JSON.parse(text);
  } catch {
    // DragonCode gateway errors are often HTML rather than JSON.
  }

  const taskId = json?.data?.[0]?.task_id ?? null;
  const summary = {
    case: name,
    http: response.status,
    ms: Date.now() - startedAt,
    contentType: response.headers.get("content-type"),
    code: json?.code ?? null,
    status: json?.data?.[0]?.status ?? null,
    taskId,
    responsePreview: summarizeResponseText(text, taskId)
  };

  console.log(JSON.stringify(summary, null, 2));

  return taskId;
}

async function queryTask(name, apiKey, taskId) {
  if (!taskId) {
    return;
  }

  const response = await fetch(`${DRAGON_BASE_URL}/tasks/${taskId}`, {
    headers: {
      Authorization: `Bearer ${apiKey}`
    }
  });
  const text = await response.text();
  let json = null;

  try {
    json = JSON.parse(text);
  } catch {
    // Keep a short preview below.
  }

  console.log(
    JSON.stringify(
      {
        case: `${name}-query`,
        http: response.status,
        contentType: response.headers.get("content-type"),
        code: json?.code ?? null,
        status: json?.data?.status ?? null,
        progress: json?.data?.progress ?? null,
        hasResult: Boolean(json?.data?.result),
        error: json?.data?.error ?? null,
        responsePreview: json ? undefined : text.replace(/\s+/g, " ").slice(0, 260)
      },
      null,
      2
    )
  );
}

async function main() {
  const mode = process.argv[2] ?? "both";
  const env = loadEnv();
  const apiKey = env.DRAGON_API_KEY;

  if (!apiKey) {
    throw new Error("Missing DRAGON_API_KEY in .env.local");
  }

  if (mode === "text" || mode === "both") {
    const taskId = await submitCase("text-to-image", apiKey, {
      model: "gpt-image-2",
      prompt: "接口连通性测试：一枚小小的黄色圆形图标，纯色背景",
      n: 1,
      size: "1:1",
      resolution: "1k"
    });
    await queryTask("text-to-image", apiKey, taskId);
  }

  if (mode === "image" || mode === "both") {
    const taskId = await submitCase("image-to-image", apiKey, {
      model: "gpt-image-2",
      prompt: "把参考图变成简单的黄色圆形图标",
      n: 1,
      size: "1:1",
      resolution: "1k",
      image_urls: [TINY_PNG_DATA_URI]
    });
    await queryTask("image-to-image", apiKey, taskId);
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack : error);
  process.exitCode = 1;
});
