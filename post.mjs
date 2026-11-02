// Instagram 자동 포스팅: queue.json의 다음 글 -> 이미지 카드 렌더 -> Graph API로 게시.
//
// node post.mjs prepare    # queue.json 맨 앞 글을 꺼내 posts/<날짜>.jpg + .json 생성
// node post.mjs publish    # 가장 최근 post를 Instagram에 게시 (이미지가 공개 URL에 올라간 뒤)
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { setTimeout as sleep } from "node:timers/promises";
import sharp from "sharp";

const POSTS = "posts";
const QUEUE = "queue.json";
const GRAPH = "https://graph.facebook.com/v21.0";

const postFiles = async () =>
  (await readdir(POSTS).catch(() => [])).filter((f) => f.endsWith(".json")).sort();

async function prepare() {
  const queue = JSON.parse(await readFile(QUEUE, "utf8"));
  const post = queue.shift();
  if (!post) throw new Error("queue.json이 비었어요. 게시물을 채워주세요.");

  // 배경: post.image(예: images/2026-11-02-housing.png) > Gemini 생성 > 단색. 모든 장에 같은 배경을 씀
  const image = post.image ?? (await geminiImage(post.image_prompt ?? post.topic));
  // 1장 = image_text, post.slides가 있으면 2장부터 이어 붙여 캐러셀(<날짜>-1.jpg, -2.jpg ...)로 게시
  const texts = [post.image_text, ...(post.slides ?? [])];

  await mkdir(POSTS, { recursive: true });
  const stem = `${POSTS}/${new Date().toISOString().slice(0, 10)}`;
  for (const [i, text] of texts.entries()) {
    const file = texts.length > 1 ? `${stem}-${i + 1}.jpg` : `${stem}.jpg`;
    await card(text, image, i === 0).jpeg({ quality: 92 }).toFile(file);
  }
  await writeFile(`${stem}.json`, JSON.stringify(post, null, 2));
  await writeFile(QUEUE, JSON.stringify(queue, null, 2) + "\n");
  console.log(stem, `(남은 글 ${queue.length}개)`);
}

// 표지(title): \n 또는 12자마다 줄바꿈, 72px.
// 본문 장: 첫 줄은 소제목 80px, 나머지는 18자마다 줄바꿈해 48px (빈 줄은 간격)
function card(text, image, title) {
  const esc = (s) => s.replace(/[<>&"]/g, (c) => `&#${c.charCodeAt(0)};`);
  const rows = title
    ? text.match(/.{1,12}/gu).map((t) => [t, 72, 96])
    : text.split("\n").flatMap((l, i) => (i === 0 ? [[l, 80, 128]] : (l.match(/.{1,18}/gu) ?? [""]).map((t) => [t, 48, 72])));
  let y = 540 - rows.reduce((h, [, , gap]) => h + gap, 0) / 2;
  const tspans = rows.map(([t, size, gap]) => `<tspan x="540" y="${(y += gap) - gap / 2}" font-size="${size}">${esc(t)}</tspan>`);
  const bg = image ? `fill="black" fill-opacity="0.45"` : `fill="${process.env.BG_COLOR ?? "#1f2937"}"`;
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="1080" height="1080">
    <rect width="100%" height="100%" ${bg}/>
    <text x="540" fill="white" font-family="${process.env.FONT ?? "NanumGothic"}" font-weight="bold"
      text-anchor="middle" dominant-baseline="middle">${tspans.join("")}</text></svg>`;
  return image
    ? sharp(image).resize(1080, 1080, { fit: "cover" }).composite([{ input: Buffer.from(svg) }])
    : sharp(Buffer.from(svg));
}

// GEMINI_API_KEY가 없거나 생성에 실패하면 undefined -> 단색 배경으로 게시는 계속 진행
async function geminiImage(subject) {
  if (!process.env.GEMINI_API_KEY) return;
  const model = process.env.GEMINI_MODEL ?? "gemini-2.5-flash-image";
  const prompt = `Warm, soft, cozy illustration for an Instagram card background about: ${subject}. ` +
    "Square, simple composition, muted pastel colors. Absolutely no text, letters, numbers, or logos.";
  try {
    const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-goog-api-key": process.env.GEMINI_API_KEY },
      body: JSON.stringify({
        contents: [{ parts: [{ text: prompt }] }],
        generationConfig: { responseModalities: ["IMAGE"], imageConfig: { aspectRatio: "1:1" } },
      }),
    });
    const body = await res.json();
    if (!res.ok) throw new Error(JSON.stringify(body));
    const data = body.candidates?.[0]?.content?.parts?.find((p) => p.inlineData)?.inlineData.data;
    if (!data) throw new Error("응답에 이미지가 없어요: " + JSON.stringify(body).slice(0, 300));
    return Buffer.from(data, "base64");
  } catch (e) {
    console.warn("Gemini 이미지 생성 실패, 단색 배경 사용:", e.message);
  }
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
  const { caption, slides = [] } = JSON.parse(await readFile(`${stem}.json`, "utf8"));
  const base = `${process.env.PUBLIC_BASE_URL.replace(/\/$/, "")}/${stem}`;
  const user = process.env.IG_USER_ID;

  let id;
  if (!slides.length) ({ id } = await graph(`${user}/media`, { image_url: `${base}.jpg`, caption }));
  else {
    const children = [];
    for (let i = 1; i <= slides.length + 1; i++)
      children.push((await graph(`${user}/media`, { image_url: `${base}-${i}.jpg`, is_carousel_item: true })).id);
    ({ id } = await graph(`${user}/media`, { media_type: "CAROUSEL", children: children.join(","), caption }));
  }
  for (let i = 0; i < 10; i++) { // 컨테이너 처리 대기
    const { status_code } = await graph(id, { fields: "status_code" }, "GET");
    if (status_code === "FINISHED") break;
    if (status_code === "ERROR") throw new Error("media container failed");
    await sleep(5000);
  }
  console.log(await graph(`${user}/media_publish`, { creation_id: id }));
}

// 토큰이 14일 안에 만료되면 실패 -> GitHub Actions 실패 메일로 알림
async function check() {
  const { data } = await graph("debug_token", { input_token: process.env.IG_ACCESS_TOKEN }, "GET");
  if (!data.is_valid) throw new Error("IG_ACCESS_TOKEN이 만료됐거나 무효예요. 새 토큰으로 바꿔주세요.");
  const days = data.expires_at ? Math.floor((data.expires_at * 1000 - Date.now()) / 864e5) : Infinity;
  console.log(`토큰 만료까지 ${days}일 (${data.expires_at ? new Date(data.expires_at * 1000).toISOString().slice(0, 10) : "만료 없음"})`);
  if (days < 14) throw new Error(`IG_ACCESS_TOKEN이 ${days}일 뒤 만료돼요. 새 토큰으로 바꿔주세요.`);
}

await { prepare, publish, check }[process.argv[2]]();
