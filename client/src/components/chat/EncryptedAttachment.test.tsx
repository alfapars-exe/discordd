/**
 * EncryptedAttachment tests — which render branch a decrypted attachment takes,
 * and what MIME type its blob: URL ends up carrying.
 *
 * The crypto module is intentionally NOT mocked: real encryptFile/decryptFile
 * run against WebCrypto so the sender-claim -> payload -> blob chain is
 * exercised end to end. Only the network (fetch) and jsdom's missing
 * URL.createObjectURL are stubbed.
 *
 * Threat model (pentest 2026-07-26, finding M-10): the server cannot sniff
 * E2EE ciphertext, so `fileMeta.mimeType` is whatever the SENDER put there.
 * The inline branch renders an anchor with target="_blank", and
 * modifier/middle clicks keep that native navigation — navigating to a blob:
 * URL executes it as a document in OUR origin.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, waitFor, cleanup } from "@testing-library/react";
import EncryptedAttachment from "./EncryptedAttachment";
import { encryptFile } from "../../crypto/fileEncryption";
import { useLightboxStore } from "../../stores/lightboxStore";
import type { EncryptedFileMeta } from "../../crypto/fileEncryption";
import type { ChatAttachment } from "../../hooks/useChatContext";

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (k: string) => k }),
}));

vi.mock("../../utils/constants", async () => {
  const actual = await vi.importActual<Record<string, unknown>>("../../utils/constants");
  return {
    ...actual,
    resolveAssetUrl: (path: string) => `https://cdn.test/${path}`,
  };
});

/** Every Blob handed to URL.createObjectURL, in call order. */
const createdBlobs: Blob[] = [];
const createObjectURL = vi.fn((blob: Blob) => {
  createdBlobs.push(blob);
  return `blob:hichat/${createdBlobs.length}`;
});
const revokeObjectURL = vi.fn();

beforeEach(() => {
  createdBlobs.length = 0;
  createObjectURL.mockClear();
  revokeObjectURL.mockClear();
  useLightboxStore.getState().close();
  // jsdom has no createObjectURL — stub the pair and capture the blobs.
  vi.stubGlobal(
    "URL",
    Object.assign(Object.create(URL), { createObjectURL, revokeObjectURL })
  );
});

/**
 * Drain any decrypt still in flight before the next test installs its stubs.
 * The image branch auto-decrypts on mount, and `URL` is looked up on the
 * global at call time — so an unfinished promise chain from THIS test would
 * otherwise invoke the NEXT test's createObjectURL stub and fail it for a
 * reason that has nothing to do with it.
 */
async function flushPendingDecrypts(): Promise<void> {
  for (let i = 0; i < 5; i++) {
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
}

afterEach(async () => {
  cleanup();
  await flushPendingDecrypts();
  vi.unstubAllGlobals();
});

/** Active-content payload: harmless as bytes, dangerous only if typed as SVG. */
const HOSTILE_BYTES = new TextEncoder().encode(
  "<svg xmlns='http://www.w3.org/2000/svg'><script>alert(1)</script></svg>"
);

/**
 * Encrypt HOSTILE_BYTES under a sender-claimed MIME type and stub the download
 * so the component's decryptFile call resolves to that ciphertext.
 */
async function seed(claimedMimeType: string, filename: string): Promise<EncryptedFileMeta> {
  const { encryptedBlob, meta } = await encryptFile(
    new File([HOSTILE_BYTES], filename, { type: claimedMimeType })
  );
  const ciphertext = await encryptedBlob.arrayBuffer();
  // Guard rail: if the claim did not survive into the payload the assertions
  // below would be testing an already-neutered input.
  expect(meta.mimeType).toBe(claimedMimeType);
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => new Response(ciphertext))
  );
  return meta;
}

function makeAttachment(filename: string): ChatAttachment {
  return {
    id: "att-1",
    filename,
    file_url: "/files/encrypted.bin",
    file_size: HOSTILE_BYTES.byteLength,
    mime_type: "application/octet-stream",
  };
}

describe("EncryptedAttachment — sender-claimed MIME cannot pick the render branch (M-10)", () => {
  it("keeps a claimed image/svg+xml out of the inline branch and off the blob type", async () => {
    const meta = await seed("image/svg+xml", "cute-cat.svg");
    const { container } = render(
      <EncryptedAttachment attachment={makeAttachment("cute-cat.svg")} fileMeta={meta} />
    );

    // Not inline: no <img>, no target="_blank" anchor, and no auto-decrypt.
    expect(screen.queryByRole("img")).toBeNull();
    expect(container.querySelector('a[target="_blank"]')).toBeNull();
    expect(createObjectURL).not.toHaveBeenCalled();

    // The download path must not mint an SVG-typed blob either.
    const card = container.querySelector("a.msg-attachment-file");
    expect(card).not.toBeNull();
    fireEvent.click(card!);

    await waitFor(() => expect(createObjectURL).toHaveBeenCalledTimes(1));
    expect(createdBlobs[0].type).not.toBe("image/svg+xml");
    expect(createdBlobs[0].type).toBe("application/octet-stream");
  });

  it("keeps a claimed text/html out of the inline branch and off the blob type", async () => {
    const meta = await seed("text/html", "invoice.html");
    const { container } = render(
      <EncryptedAttachment attachment={makeAttachment("invoice.html")} fileMeta={meta} />
    );

    expect(screen.queryByRole("img")).toBeNull();
    expect(container.querySelector('a[target="_blank"]')).toBeNull();
    expect(createObjectURL).not.toHaveBeenCalled();

    const card = container.querySelector("a.msg-attachment-file");
    fireEvent.click(card!);

    await waitFor(() => expect(createObjectURL).toHaveBeenCalledTimes(1));
    expect(createdBlobs[0].type).not.toBe("text/html");
    expect(createdBlobs[0].type).toBe("application/octet-stream");
  });

  it("still renders a genuine image/png inline with its type preserved", async () => {
    const meta = await seed("image/png", "photo.png");
    const { container } = render(
      <EncryptedAttachment attachment={makeAttachment("photo.png")} fileMeta={meta} />
    );

    const img = await screen.findByRole("img", { name: "photo.png" });
    expect(img).toHaveAttribute("src", "blob:hichat/1");
    expect(createdBlobs[0].type).toBe("image/png");
    // The open-in-new-tab affordance survives for safe raster types.
    expect(container.querySelector('a[target="_blank"]')).not.toBeNull();
  });

  it("keeps the lightbox flow intact for a genuine image", async () => {
    const meta = await seed("image/jpeg", "holiday.jpg");
    const { container } = render(
      <EncryptedAttachment attachment={makeAttachment("holiday.jpg")} fileMeta={meta} />
    );

    await screen.findByRole("img", { name: "holiday.jpg" });
    const anchor = container.querySelector('a[target="_blank"]');
    fireEvent.click(anchor!, { button: 0 });

    await waitFor(() => {
      const item = useLightboxStore.getState().item;
      expect(item?.kind).toBe("blob");
    });
    const item = useLightboxStore.getState().item;
    expect(item?.kind === "blob" && item.filename).toBe("holiday.jpg");
  });

  it("downloads an off-allowlist application/pdf without crashing", async () => {
    const meta = await seed("application/pdf", "report.pdf");
    const { container } = render(
      <EncryptedAttachment attachment={makeAttachment("report.pdf")} fileMeta={meta} />
    );

    expect(screen.queryByRole("img")).toBeNull();
    expect(screen.getByText("report.pdf")).toBeInTheDocument();

    fireEvent.click(container.querySelector("a.msg-attachment-file")!);

    await waitFor(() => expect(createObjectURL).toHaveBeenCalledTimes(1));
    expect(createdBlobs[0].type).toBe("application/octet-stream");
    // Bytes survive the downgrade — only the label changed.
    expect(createdBlobs[0].size).toBe(HOSTILE_BYTES.byteLength);
  });
});
