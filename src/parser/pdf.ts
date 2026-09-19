/**
 * PDF -> positioned text fragments, using pdf.js (fully in-browser, offline).
 *
 * M-PESA statements are password-protected; the password is normally your
 * national ID number (or the one Safaricom sent you by SMS/e-mail). pdf.js
 * decrypts on the device, so the password and the PDF never leave the phone.
 */
import * as pdfjs from 'pdfjs-dist';
import workerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url';
import type { TextItem } from './mpesa';

pdfjs.GlobalWorkerOptions.workerSrc = workerUrl;

/** Thrown when the PDF is encrypted; `wrong` is true when a password was given but rejected. */
export class PasswordError extends Error {
  constructor(public readonly wrong: boolean) {
    super(wrong ? 'Incorrect PDF password' : 'This PDF is password protected');
    this.name = 'PasswordError';
  }
}

export async function extractTextItems(
  data: ArrayBuffer,
  password?: string,
  onProgress?: (page: number, total: number) => void,
): Promise<TextItem[]> {
  // pdf.js transfers the buffer to its worker; pass a copy so the caller keeps theirs.
  const task = pdfjs.getDocument({ data: new Uint8Array(data.slice(0)), password });
  let doc: Awaited<typeof task.promise>;
  try {
    doc = await task.promise;
  } catch (err) {
    // pdf.js reports code 1 = NEED_PASSWORD, code 2 = INCORRECT_PASSWORD.
    if (err && typeof err === 'object' && (err as { name?: string }).name === 'PasswordException') {
      throw new PasswordError((err as { code?: number }).code === 2);
    }
    throw err;
  }

  const items: TextItem[] = [];
  for (let p = 1; p <= doc.numPages; p++) {
    const page = await doc.getPage(p);
    const content = await page.getTextContent();
    for (const it of content.items) {
      if (!('str' in it)) continue; // marked-content markers carry no text
      items.push({ str: it.str, x: it.transform[4], y: it.transform[5], width: it.width, page: p });
    }
    page.cleanup();
    onProgress?.(p, doc.numPages);
  }
  await task.destroy();
  return items;
}
