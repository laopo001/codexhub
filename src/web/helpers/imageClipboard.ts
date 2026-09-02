export const writeImageToClipboard = async (url: string, imageElement?: HTMLImageElement | null) => {
  if (typeof window !== "undefined" && typeof window.focus === "function") {
    try {
      window.focus();
    } catch {
      // 忽略聚焦可能产生的非关键异常
    }
  }

  if (!navigator.clipboard?.write || typeof ClipboardItem === "undefined") {
    throw new Error("Image clipboard is not supported");
  }

  const pngPromise = resolveImagePngBlob(url, imageElement);

  // 现代 Chromium 支持向 ClipboardItem 传入 Promise<Blob>，在用户激活有效期内直接提交
  try {
    await navigator.clipboard.write([
      new ClipboardItem({ "image/png": pngPromise })
    ]);
    return;
  } catch (error) {
    // 若旧版浏览器/环境不支持构造时传 Promise，回退为先等待 Blob 解析再写入
    if (error instanceof TypeError) {
      const blob = await pngPromise;
      await navigator.clipboard.write([
        new ClipboardItem({ "image/png": blob })
      ]);
      return;
    }
    throw error;
  }
};

const resolveImagePngBlob = async (url: string, imageElement?: HTMLImageElement | null): Promise<Blob> => {
  // 优先尝试直接从页面已渲染的 <img> 读取像素生成 PNG（零网络延迟，避免手势超时）
  if (imageElement && imageElement.complete && imageElement.naturalWidth > 0) {
    try {
      const canvas = document.createElement("canvas");
      canvas.width = imageElement.naturalWidth;
      canvas.height = imageElement.naturalHeight;
      const context = canvas.getContext("2d");
      if (context) {
        context.drawImage(imageElement, 0, 0);
        const blob = await new Promise<Blob | null>((resolve) => {
          canvas.toBlob(resolve, "image/png");
        });
        if (blob) return blob;
      }
    } catch {
      // 若受跨域限制（Tainted canvas），回退至常规 fetch
    }
  }

  const response = await fetch(url);
  if (!response.ok) throw new Error(`Image request failed (${response.status})`);
  const source = await response.blob();
  if (source.type === "image/png") return source;
  if (!source.type.startsWith("image/") && source.type !== "") {
    throw new Error("Preview URL did not return an image");
  }
  return await imageBlobAsPng(source);
};

export const imageBlobAsPng = async (source: Blob): Promise<Blob> => {
  const bitmap = await createImageBitmap(source);
  try {
    const canvas = document.createElement("canvas");
    canvas.width = bitmap.width;
    canvas.height = bitmap.height;
    const context = canvas.getContext("2d");
    if (!context) throw new Error("Image conversion is unavailable");
    context.drawImage(bitmap, 0, 0);
    return await new Promise<Blob>((resolve, reject) => {
      canvas.toBlob((blob) => (blob ? resolve(blob) : reject(new Error("Image conversion failed"))), "image/png");
    });
  } finally {
    bitmap.close();
  }
};

export const extractImageFilename = (pathOrTitle?: string): string => {
  if (!pathOrTitle) return "image.png";
  const segment = pathOrTitle.split(/[/\\]/).filter(Boolean).pop()?.trim();
  if (!segment) return "image.png";
  return /\.[a-zA-Z0-9]+$/.test(segment) ? segment : `${segment}.png`;
};

export const downloadImageFile = async (url: string, filename?: string) => {
  const name = extractImageFilename(filename);
  try {
    const response = await fetch(url);
    if (!response.ok) throw new Error(`Image fetch failed (${response.status})`);
    const blob = await response.blob();
    const objectUrl = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = objectUrl;
    anchor.download = name;
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    URL.revokeObjectURL(objectUrl);
  } catch {
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = name;
    anchor.target = "_blank";
    anchor.rel = "noreferrer";
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
  }
};
