import http from "node:http";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

// 通过脚本参数读取端口，默认只监听本机，避免把串口工具暴露到局域网。
const args = process.argv.slice(2);
const portIndex = args.indexOf("--port");
const requestedPort = portIndex >= 0 ? Number(args[portIndex + 1]) : 5173;
const port = Number.isInteger(requestedPort) && requestedPort > 0 ? requestedPort : 5173;

// 使用模块自身位置定位 public 目录，使脚本从任意工作目录启动都能找到页面资源。
const projectRoot = path.dirname(fileURLToPath(import.meta.url));
const publicRoot = path.join(projectRoot, "public");
const { version } = JSON.parse(await readFile(path.join(projectRoot, "package.json"), "utf8"));

// 仅允许常见静态资源类型，未知扩展名按二进制流返回，避免错误的 MIME 推断。
const mimeTypes = new Map([
  [".html", "text/html; charset=utf-8"],
  [".css", "text/css; charset=utf-8"],
  [".js", "text/javascript; charset=utf-8"],
  [".json", "application/json; charset=utf-8"],
  [".svg", "image/svg+xml"],
  [".ico", "image/x-icon"],
  [".mp4", "video/mp4"],
]);

// 解析单段 Range 请求头，使课堂视频可以拖动进度条；多段范围按不可满足处理。
function parseRange(header, size) {
  const match = /^bytes=(\d*)-(\d*)$/.exec(header);
  if (!match || (match[1] === "" && match[2] === "")) return null;
  const start = match[1] === "" ? Math.max(0, size - Number(match[2])) : Number(match[1]);
  const end = match[1] === "" || match[2] === "" ? size - 1 : Math.min(Number(match[2]), size - 1);
  return start <= end ? { start, end } : null;
}

// 将 URL 路径安全地映射到 public 目录，拒绝目录穿越请求。
function resolveStaticPath(requestUrl) {
  const url = new URL(requestUrl, "http://127.0.0.1");
  let pathname;
  try {
    pathname = decodeURIComponent(url.pathname);
  } catch {
    // 畸形百分号编码不是合法资源路径，交给调用方返回 400 而不是让请求悬挂。
    return null;
  }
  const relativePath = pathname === "/" ? "index.html" : pathname.slice(1);
  const candidate = path.resolve(publicRoot, relativePath);
  if (candidate !== publicRoot && !candidate.startsWith(`${publicRoot}${path.sep}`)) {
    return null;
  }
  return candidate;
}

// 处理健康检查和页面静态文件，让启动脚本可以确认服务已经可用。
const server = http.createServer(async (request, response) => {
  if (request.method !== "GET" && request.method !== "HEAD") {
    response.writeHead(405, { "Content-Type": "text/plain; charset=utf-8" });
    response.end("Method Not Allowed");
    return;
  }

  if (request.url?.startsWith("/health")) {
    response.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
    response.end(JSON.stringify({ ok: true, service: "ydlidar-x3pro-teaching-aid", version }));
    return;
  }

  const filePath = request.url ? resolveStaticPath(request.url) : null;
  if (!filePath) {
    response.writeHead(400, { "Content-Type": "text/plain; charset=utf-8" });
    response.end("Bad Request");
    return;
  }

  try {
    const data = await readFile(filePath);
    const type = mimeTypes.get(path.extname(filePath).toLowerCase()) ?? "application/octet-stream";
    if (request.headers.range) {
      const range = parseRange(request.headers.range, data.length);
      if (!range) {
        response.writeHead(416, { "Content-Range": `bytes */${data.length}` });
        response.end();
        return;
      }
      response.writeHead(206, {
        "Content-Type": type,
        "Content-Length": range.end - range.start + 1,
        "Content-Range": `bytes ${range.start}-${range.end}/${data.length}`,
        "Accept-Ranges": "bytes",
        "Cache-Control": "no-store",
      });
      response.end(request.method === "HEAD" ? undefined : data.subarray(range.start, range.end + 1));
      return;
    }
    response.writeHead(200, { "Content-Type": type, "Accept-Ranges": "bytes", "Cache-Control": "no-store" });
    if (request.method === "HEAD") {
      response.end();
    } else {
      response.end(data);
    }
  } catch (error) {
    const status = error?.code === "ENOENT" ? 404 : 500;
    response.writeHead(status, { "Content-Type": "text/plain; charset=utf-8" });
    response.end(status === 404 ? "Not Found" : "Internal Server Error");
  }
});

// 绑定回环地址，使 Web Serial 页面可用，同时不允许局域网访问串口工具。
server.listen(port, "127.0.0.1", () => {
  console.log(`YDLIDAR 教学工具已启动: http://127.0.0.1:${port}`);
});

// 处理 Ctrl+C，确保 Node 进程和监听端口能干净退出。
process.on("SIGINT", () => {
  server.close(() => process.exit(0));
});

// 处理未捕获错误并给出可理解的启动失败信息。
server.on("error", (error) => {
  console.error(`本地服务启动失败: ${error.message}`);
  process.exitCode = 1;
});
