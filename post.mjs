// Instagram 자동 포스팅: Claude로 글 생성 -> 이미지 카드 렌더 -> Graph API로 게시.
//
// node post.mjs generate   # posts/<날짜>.jpg + .json 생성
// node post.mjs publish    # 가장 최근 post를 Instagram에 게시 (이미지가 공개 URL에 올라간 뒤)
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { setTimeout as sleep } from "node:timers/promises";

const POSTS = "posts";
const GRAPH = "https://graph.facebook.com/v21.0";

const postFiles = async () =>
  (await readdir(POSTS).catch(() => [])).filter((f) => f.endsWith(".json")).sort();

async function generate() {
  const { default: Anthropic } = await import("@anthropic-ai/sdk");
  const { zodOutputFormat } = await import("@anthropic-ai/sdk/helpers/zod");
  const { z } = await import("zod");
  const { default: sharp } = await import("sharp");

  const Post = z.object({
    topic: z.string(),
    image_text: z.string(), // 카드에 들어갈 짧은 문구
    caption: z.string(), // 해시태그 포함 본문
  });

  const recent = await Promise.all(
    (await postFiles()).slice(-20).map(async (f) => JSON.parse(await readFile(`${POSTS}/${f}`, "utf8")).topic),
  );
  const resp = await new Anthropic().messages.parse({
    model: "claude-opus-5-5",
    max_tokens: 16000,
    output_config: { effort: "low", format: zodOutputFormat(Post) },
    messages: [{
      role: "user",
      content:
        `인스타그램 계정 주제: ${process.env.ACCOUNT_THEME}\n` +
        `최근 다룬 토픽(중복 금지): ${JSON.stringify(recent)}\n` +
        "새 피드 게시물 1개를 한국어로 작성해. image_text는 40자 이내, " +
        "caption은 300자 이내 + 해시태그 5~10개.",
    }],
  });
  if (resp.stop_reason !== "end_turn" || !resp.parsed_output) throw new Error(`generation stopped: ${resp.stop_reason}`);
  const post = resp.parsed_output;

  // 12자씩 줄바꿈해 SVG로 그린 뒤 JPEG 변환
  const esc = (s) => s.replace(/[<>&"]/g, (c) => `&#${c.charCodeAt(0)};`);
  const lines = post.image_text.match(/.{1,12}/gu);
  const top = 540 - ((lines.length - 1) * 96) / 2;
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="1080" height="1080">
    <rect width="100%" height="100%" fill="${process.env.BG_COLOR ?? "#1f2937"}"/>
    <text x="540" fill="white" font-family="${process.env.FONT ?? "NanumGothic"}" font-weight="bold"
      font-size="72" text-anchor="middle" dominant-baseline="middle">
      ${lines.map((l, i) => `<tspan x="540" y="${top + i * 96}">${esc(l)}</tspan>`).join("")}
    </text></svg>`;

  await mkdir(POSTS, { recursive: true });
  const stem = `${POSTS}/${new Date().toISOString().slice(0, 10)}`;
  await sharp(Buffer.from(svg)).jpeg({ quality: 92 }).toFile(`${stem}.jpg`);
  await writeFile(`${stem}.json`, JSON.stringify(post, null, 2));
  console.log(stem);
}

async function graph(path, params = {}, method = "POST") {
  const qs = new URLSearchParams({ ...params, access_token: process.env.IG_ACCESS_TOKEN });
  const res = await fetch(`${GRAPH}/${path}?${qs}`, { method });
  const body = await res.json();
  if (!res.ok) throw new Error(JSON.stringify(body));
  return body;
}

async function publish() {
  const stem = `${POSTS}/${(await postFiles()).at(-1).replace(/\.json$/, "")}`;
  const { caption } = JSON.parse(await readFile(`${stem}.json`, "utf8"));
  const image_url = `${process.env.PUBLIC_BASE_URL.replace(/\/$/, "")}/${stem}.jpg`;
  const user = process.env.IG_USER_ID;

  const { id } = await graph(`${user}/media`, { image_url, caption });
  for (let i = 0; i < 10; i++) { // 컨테이너 처리 대기
    const { status_code } = await graph(id, { fields: "status_code" }, "GET");
    if (status_code === "FINISHED") break;
    if (status_code === "ERROR") throw new Error("media container failed");
    await sleep(5000);
  }
  console.log(await graph(`${user}/media_publish`, { creation_id: id }));
}

await { generate, publish }[process.argv[2]]();
