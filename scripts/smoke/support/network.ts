import net from "node:net";

export const findFreePort = async () => await new Promise<number>((resolve, reject) => {
  const server = net.createServer();
  server.once("error", reject);
  server.listen(0, "127.0.0.1", () => {
    const address = server.address();
    if (!address || typeof address === "string") {
      server.close(() => reject(new Error("could not allocate tcp port")));
      return;
    }
    const port = address.port;
    server.close(() => resolve(port));
  });
});
