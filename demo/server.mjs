import { createServer } from "node:http";
import { readFile } from "node:fs/promises";

const assets = new Map([
  ["/", ["index.html", "text/html"]],
  ["/index.html", ["index.html", "text/html"]],
  ["/diagram.js", ["diagram.js", "text/javascript"]],
  ["/style.css", ["style.css", "text/css"]],
]);

const server = createServer(async (request, response) => {
  const asset = assets.get(request.url.split("?")[0]);
  if (!asset || !["GET", "HEAD"].includes(request.method)) {
    response.writeHead(404).end();
    return;
  }
  try {
    const body = await readFile(new URL(asset[0], import.meta.url));
    response.writeHead(200, {
      "Content-Type": asset[1] + "; charset=utf-8",
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
      "Content-Security-Policy": "default-src 'self'; connect-src 'none'; img-src 'self' data:; object-src 'none'; frame-ancestors 'none'",
    });
    response.end(request.method === "HEAD" ? undefined : body);
  } catch {
    response.writeHead(500).end("Could not load the demo file.");
  }
});
server.on("error", (error) => {
  console.error(error.message);
  process.exitCode = 1;
});
server.listen(4178, "127.0.0.1", () => {
  console.log("StockFlow architecture demo: http://127.0.0.1:4178/");
});
