export const writeImageToClipboard = async (url: string) => {
  if (!navigator.clipboard?.write || typeof ClipboardItem === "undefined") {
    throw new Error("Image clipboard is not supported");
  }
  const response = await fetch(url);
  if (!response.ok) throw new Error(`Image request failed (${response.status})`);
  const source = await response.blob();
  if (!source.type.startsWith("image/")) throw new Error("Preview URL did not return an image");
  const blob = clipboardSupportsMimeType(source.type) ? source : await imageBlobAsPng(source);
  await navigator.clipboard.write([new ClipboardItem({ [blob.type]: blob })]);
};

const clipboardSupportsMimeType = (mimeType: string) =>
  typeof ClipboardItem.supports === "function" ? ClipboardItem.supports(mimeType) : mimeType === "image/png";

const imageBlobAsPng = async (source: Blob) => {
  const bitmap = await createImageBitmap(source);
  try {
    const canvas = document.createElement("canvas");
    canvas.width = bitmap.width;
    canvas.height = bitmap.height;
    const context = canvas.getContext("2d");
    if (!context) throw new Error("Image conversion is unavailable");
    context.drawImage(bitmap, 0, 0);
    return await new Promise<Blob>((resolve, reject) => {
      canvas.toBlob((blob) => blob ? resolve(blob) : reject(new Error("Image conversion failed")), "image/png");
    });
  } finally {
    bitmap.close();
  }
};
