import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import vm from "node:vm";
import { contentType } from "../../src/server/serverFiles.js";

const projectRoot = path.resolve(import.meta.dirname, "../..");

test("PWA manifest declares an installable standalone app and required icons", async () => {
  const manifest = JSON.parse(await readFile(path.join(projectRoot, "public/manifest.webmanifest"), "utf8")) as {
    id?: string;
    start_url?: string;
    scope?: string;
    display?: string;
    icons?: Array<{ src?: string; sizes?: string; type?: string }>;
  };

  assert.equal(manifest.id, "/");
  assert.equal(manifest.start_url, "/");
  assert.equal(manifest.scope, "/");
  assert.equal(manifest.display, "standalone");
  assert.deepEqual(manifest.icons?.map(({ src, sizes, type }) => ({ src, sizes, type })), [
    {
      src: "/icons/codexhub-192.png",
      sizes: "192x192",
      type: "image/png"
    },
    {
      src: "/icons/codexhub-512.png",
      sizes: "512x512",
      type: "image/png"
    }
  ]);
  for (const icon of manifest.icons ?? []) {
    const image = await readFile(path.join(projectRoot, "public", icon.src?.replace(/^\//, "") ?? ""));
    assert.equal(image.subarray(0, 8).toString("hex"), "89504e470d0a1a0a");
    const [width, height] = [image.readUInt32BE(16), image.readUInt32BE(20)];
    assert.equal(`${width}x${height}`, icon.sizes);
  }
});

test("production static serving uses the manifest MIME type", () => {
  assert.equal(contentType("manifest.webmanifest"), "application/manifest+json; charset=utf-8");
});

const loadServiceWorker = async () => {
  const swCode = await readFile(path.join(projectRoot, "public/codexhub-notification-sw.js"), "utf8");
  const handlers = new Map<string, (event: Record<string, unknown>) => void>();
  const deletedCacheNames: string[] = [];
  vm.runInNewContext(swCode, {
    URL,
    URLSearchParams,
    Response,
    fetch: async () => new Response("network"),
    caches: {
      keys: async () => ["codexhub-shell-v1", "codexhub-shell-v2", "unrelated-cache"],
      delete: async (cacheName: string) => {
        deletedCacheNames.push(cacheName);
        return true;
      },
      open: async () => ({
        addAll: async () => undefined,
        match: async () => null,
        put: async () => undefined
      })
    },
    self: {
      location: { origin: "http://127.0.0.1:28789" },
      clients: { claim: async () => undefined },
      skipWaiting: async () => undefined,
      addEventListener: (type: string, handler: (event: Record<string, unknown>) => void) => {
        handlers.set(type, handler);
      }
    }
  });
  return { handlers, deletedCacheNames };
};

const serviceWorkerIntercepts = (
  handler: (event: Record<string, unknown>) => void,
  url: string,
  options: { destination?: string; referrer?: string } = {}
) => {
  let intercepted = false;
  handler({
    request: {
      method: "GET",
      url,
      destination: options.destination ?? "document",
      referrer: options.referrer ?? ""
    },
    respondWith: (response: Promise<Response>) => {
      intercepted = true;
      void response.catch(() => undefined);
    }
  });
  return intercepted;
};

test("PWA service worker bypasses ordinary and whole-query embedded documents", async () => {
  const { handlers } = await loadServiceWorker();
  const handler = handlers.get("fetch");
  assert.ok(handler);
  assert.equal(serviceWorkerIntercepts(
    handler,
    "http://127.0.0.1:28789/?surface=vscode&workspacePath=%2Ftmp"
  ), false);
  assert.equal(serviceWorkerIntercepts(
    handler,
    "http://127.0.0.1:28789/?codexhub_token%3Dsecret%26surface%3Dvscode%26workspacePath%3D%252Ftmp"
  ), false);
  assert.equal(serviceWorkerIntercepts(
    handler,
    "http://127.0.0.1:28789/assets/index.js",
    {
      destination: "script",
      referrer: "http://127.0.0.1:28789/?surface%3Delectron%26stateScope%3Dwindow-a"
    }
  ), false);
});

test("PWA service worker retains document caching for standalone browser pages", async () => {
  const { handlers } = await loadServiceWorker();
  const handler = handlers.get("fetch");
  assert.ok(handler);
  assert.equal(serviceWorkerIntercepts(handler, "http://127.0.0.1:28789/"), true);
  assert.equal(serviceWorkerIntercepts(handler, "http://127.0.0.1:28789/api/health"), false);
});

test("PWA service worker activation removes the previous shell cache only", async () => {
  const { handlers, deletedCacheNames } = await loadServiceWorker();
  const handler = handlers.get("activate");
  assert.ok(handler);
  let activation: Promise<unknown> | undefined;
  handler({
    waitUntil: (promise: Promise<unknown>) => {
      activation = promise;
    }
  });
  await activation;
  assert.deepEqual(deletedCacheNames, ["codexhub-shell-v1"]);
});

test("registerPwaServiceWorker skips registration in iframe", async () => {
  let registered = false;
  const fakeSelf = {} as Window;
  const fakeTop = {} as Window;

  const { registerPwaServiceWorker } = await import("../../src/web/pwa.js");
  const result = await registerPwaServiceWorker({
    window: {
      location: { protocol: "http:", search: "" },
      self: fakeSelf,
      top: fakeTop
    } as unknown as Window,
    navigator: {
      serviceWorker: {
        register: async () => {
          registered = true;
          return {} as ServiceWorkerRegistration;
        }
      }
    } as unknown as Navigator
  });

  assert.equal(result, null);
  assert.equal(registered, false);
});

test("registerPwaServiceWorker skips registration for top-level embedded surfaces", async () => {
  const sameWindow = {} as Window;
  const { registerPwaServiceWorker } = await import("../../src/web/pwa.js");

  for (const search of [
    "?surface=vscode",
    "?surface=electron",
    "?surfaceId=vscode-123",
    "?stateScope=scope-abc",
    "?codexhub_token%3Dsecret%26surface%3Dvscode%26workspacePath%3D%252Ftmp"
  ]) {
    let registered = false;
    const result = await registerPwaServiceWorker({
      window: {
        location: { protocol: "http:", search },
        self: sameWindow,
        top: sameWindow
      } as unknown as Window,
      navigator: {
        serviceWorker: {
          register: async () => {
            registered = true;
            return {} as ServiceWorkerRegistration;
          }
        }
      } as unknown as Navigator
    });

    assert.equal(result, null, `expected ${search} to skip service worker registration`);
    assert.equal(registered, false, `expected ${search} not to call serviceWorker.register`);
  }
});

test("registerPwaServiceWorker updates an existing CodexHub worker for embedded surfaces", async () => {
  const sameWindow = {} as Window;
  let updated = 0;
  let registered = 0;
  const { registerPwaServiceWorker } = await import("../../src/web/pwa.js");
  const result = await registerPwaServiceWorker({
    window: {
      location: { protocol: "http:", search: "?surface=vscode" },
      self: sameWindow,
      top: sameWindow
    } as unknown as Window,
    navigator: {
      serviceWorker: {
        getRegistration: async () => ({
          active: { scriptURL: "http://127.0.0.1:28789/codexhub-notification-sw.js" },
          waiting: null,
          installing: null,
          update: async () => {
            updated += 1;
            return {} as ServiceWorkerRegistration;
          }
        }) as ServiceWorkerRegistration,
        register: async () => {
          registered += 1;
          return {} as ServiceWorkerRegistration;
        }
      }
    } as unknown as Navigator
  });

  assert.equal(result, null);
  assert.equal(updated, 1);
  assert.equal(registered, 0);
});

test("registerPwaServiceWorker ignores unrelated embedded registrations and migration failures", async (context) => {
  const sameWindow = {} as Window;
  const { registerPwaServiceWorker } = await import("../../src/web/pwa.js");
  const warn = context.mock.method(console, "warn", () => undefined);
  for (const registration of [
    {
      active: { scriptURL: "http://127.0.0.1:28789/another-worker.js" },
      update: async () => {
        throw new Error("must not update unrelated worker");
      }
    },
    {
      active: { scriptURL: "http://127.0.0.1:28789/codexhub-notification-sw.js" },
      update: async () => {
        throw new Error("simulated update failure");
      }
    }
  ]) {
    const result = await registerPwaServiceWorker({
      window: {
        location: { protocol: "http:", search: "?surface=electron" },
        self: sameWindow,
        top: sameWindow
      } as unknown as Window,
      navigator: {
        serviceWorker: {
          getRegistration: async () => registration as unknown as ServiceWorkerRegistration,
          register: async () => {
            throw new Error("embedded surface must not register a worker");
          }
        }
      } as unknown as Navigator
    });
    assert.equal(result, null);
  }
  assert.equal(warn.mock.callCount(), 1);
});

test("registerPwaServiceWorker registers service worker in standalone top-level browser", async () => {
  let registeredUrl: string | undefined;
  let registeredOptions: RegistrationOptions | undefined;
  const sameWindow = {} as Window;

  const { registerPwaServiceWorker, appServiceWorkerUrl } = await import("../../src/web/pwa.js");
  const fakeRegistration = { scope: "/" } as ServiceWorkerRegistration;
  const result = await registerPwaServiceWorker({
    window: {
      location: { protocol: "https:", search: "" },
      self: sameWindow,
      top: sameWindow
    } as unknown as Window,
    navigator: {
      serviceWorker: {
        register: async (url: string, options?: RegistrationOptions) => {
          registeredUrl = url;
          registeredOptions = options;
          return fakeRegistration;
        }
      }
    } as unknown as Navigator
  });

  assert.equal(result, fakeRegistration);
  assert.equal(registeredUrl, appServiceWorkerUrl);
  assert.deepEqual(registeredOptions, { scope: "/" });
});
