// 관리 화면 서버: 프로젝트 폴더를 그대로 보여주고, queue.json 저장과 images/ 업로드만 허용.
//
// node admin.mjs   ->  http://localhost:8080  (이 컴퓨터에서만 접속 가능)
import { createServer } from "node:http";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { extname, relative, resolve } from "node:path";

const TYPES = { ".html": "text/html; charset=utf-8", ".json": "application/json; charset=utf-8", ".js": "text/javascript",
  ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".webp": "image/webp", ".mp4": "video/mp4" };

createServer(async (req, res) => {
  const file = relative(".", resolve("." + decodeURIComponent(new URL(req.url, "http://x").pathname))).replaceAll("\\", "/") || "index.html";
  if (file.startsWith("..") || /^[a-z]:/i.test(file)) return res.writeHead(403).end(); // 프로젝트 폴더 밖 차단
  try {
    if (req.method === "PUT") {
      const body = Buffer.concat(await Array.fromAsync(req));
      if (file === "queue.json") {
        const queue = JSON.parse(body);
        if (!Array.isArray(queue) || queue.some((p) => !p.topic || !p.image_text || !p.caption)) throw new Error("글마다 제목·카드 문구·캡션이 필요해요");
        await writeFile(file, JSON.stringify(queue, null, 2) + "\n");
      } else if (/^images\/[\w.-]+\.(png|jpe?g|webp)$/i.test(file)) {
        await mkdir("images", { recursive: true });
        await writeFile(file, body);
      } else return res.writeHead(403).end();
      return res.writeHead(204).end();
    }
    const data = await readFile(file);
    res.writeHead(200, { "content-type": TYPES[extname(file).toLowerCase()] ?? "application/octet-stream", "cache-control": "no-store" }).end(data);
  } catch (e) {
    res.writeHead(e.code === "ENOENT" ? 404 : 400, { "content-type": "text/plain; charset=utf-8" }).end(e.message);
  }
}).listen(8080, "127.0.0.1", () => console.log("관리 화면: http://localhost:8080"));
