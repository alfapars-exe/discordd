// Run by ego-browser nodejs (see HANDOFF.md). Only disposable loopback fixtures.
const fs = await import("node:fs/promises");
const local = new URL("../.local/", import.meta.url);
const qa = JSON.parse(
  await fs.readFile(new URL("handoff-qa.json", local), "utf8"),
);
const task = await taskSpace("HiChat handoff acceptance 20261031");
const page = task.page("p1");
async function login(p) {
  await p.goto("http://127.0.0.1:18080/");
  await p.waitForSelector('input[aria-label="Parola"]');
  await p.click('input[aria-label="Kullanıcı adı veya e-posta"]');
  await p.fill('input[aria-label="Kullanıcı adı veya e-posta"]', qa.username);
  await p.click('input[aria-label="Parola"]');
  await p.fill('input[aria-label="Parola"]', qa.password);
  await p.click('loc=role:button[name="Giriş yap"]');
  await p.waitForSelector('loc=role:tab[name="Cihaz devri"]');
  await p.click('loc=role:tab[name="Cihaz devri"]');
}
await login(page);
await page.waitForSelector(
  'textarea[aria-label="Şifreli devir dosyası içeriği"]',
);
const intent = await page.evaluate(() => {
  const found = [];
  function visit(root) {
    for (const e of root.querySelectorAll("*")) {
      if (e.shadowRoot) visit(e.shadowRoot);
      const s = e.getAttribute("aria-label");
      if (s?.startsWith("Hedef devir kodu: "))
        found.push(s.slice("Hedef devir kodu: ".length));
    }
  }
  visit(document);
  return found[0];
});
if (!intent) throw Error("ACCESSIBLE_PUBLIC_INTENT_MISSING");
const auth = await (
  await fetch("http://127.0.0.1:19090/api/auth/login", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username: qa.username, password: qa.password }),
  })
).json();
if (!auth.success) throw Error("LOCAL_LOGIN_FAILED");
const source = await task.newPage();
await source.goto("http://127.0.0.1:18080/__qa/handoff-source.html");
await source.waitForFunction(() => !!globalThis.HichatSourceFixture);
const result = await source.evaluate(
  ({ intent, token }) => globalThis.HichatSourceFixture.create(intent, token),
  { intent, token: auth.data.access_token },
);
await page.click('textarea[aria-label="Şifreli devir dosyası içeriği"]');
await page.keyboard.press("ControlOrMeta+A");
await page.keyboard.insertText(result.capsule);
await page.waitForFunction(
  (length) => document.activeElement?.value?.length === length,
  result.capsule.length,
);
await page.evaluate(
  () =>
    new Promise((resolve) =>
      requestAnimationFrame(() => requestAnimationFrame(resolve)),
    ),
);
console.log(
  "capsule UI text present: " +
    (await page.snapshot()).includes("sourceDeviceId"),
);
await page.click('loc=role:button[name="Devri doğrula ve etkinleştir"]');
await page.waitForFunction(() =>
  document.body.innerText.includes("Cihaz devri kalıcı olarak kaydedildi"),
);
const second = await task.newPage();
await login(second);
await second.waitForFunction(() =>
  document.body.innerText.includes("Başka pencere bu cihazın sahibi olabilir"),
);
await second.close();
await login(page);
await page.waitForFunction(() =>
  document.body.innerText.includes("Cihaz devri kalıcı olarak kaydedildi"),
);
const protectedStore = await page.evaluate(async () => {
  const request = indexedDB.open("hichat-target-device-vault-v1", 1);
  const db = await new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
  const q = db
    .transaction("records", "readonly")
    .objectStore("records")
    .getAll();
  const records = await new Promise((resolve, reject) => {
    q.onsuccess = () => resolve(q.result);
    q.onerror = () => reject(q.error);
  });
  db.close();
  return {
    nonExportableKeys: records.every((r) => r.key.extractable === false),
    encryptedRecords: records.every(
      (r) => r.sealed instanceof ArrayBuffer && !("snapshot" in r),
    ),
  };
});
if (!protectedStore.nonExportableKeys || !protectedStore.encryptedRecords)
  throw Error("WEB_PROTECTION_FAILED");
const faults = await source.evaluate(async () => {
  await import("/device_vault.js");
  const v = hichatDeviceVault,
    scope = "owned-storage-qa:" + crypto.randomUUID(),
    h = await v.acquire(scope);
  try {
    await v.save(h, JSON.stringify({ revision: 1, value: "before" }));
    const original = crypto.subtle.encrypt;
    try {
      crypto.subtle.encrypt = async () => {
        throw Error("INJECTED_ENCRYPTION_FAILURE");
      };
      await v.save(h, '{"value":"lost"}').then(
        () => {
          throw Error("FAILURE_NOT_REJECTED");
        },
        () => {},
      );
    } finally {
      crypto.subtle.encrypt = original;
    }
    if (JSON.parse(await v.load(h)).value !== "before")
      throw Error("FAILED_WRITE_CHANGED_STORE");
    let arrivals = 0,
      release;
    const both = new Promise((r) => (release = r));
    try {
      crypto.subtle.encrypt = async function (...args) {
        if (++arrivals === 2) release();
        await both;
        return Reflect.apply(original, this, args);
      };
      const r = await Promise.allSettled([
        v.save(h, '{"value":"first"}'),
        v.save(h, '{"value":"second"}'),
      ]);
      if (
        r.filter((x) => x.status === "fulfilled").length !== 1 ||
        r.filter((x) => x.status === "rejected").length !== 1
      )
        throw Error("CAS_DID_NOT_FENCE_STALE_WRITE");
    } finally {
      crypto.subtle.encrypt = original;
    }
    return {
      failedEncryptionPreservesPreviousRecord: true,
      staleRevisionRejected: true,
    };
  } finally {
    await v.release(h);
  }
});
delete result.capsule;
const receipt = {
  uiActivation: true,
  accessiblePublicIntent: true,
  secondTabOwnerBlocked: true,
  reloadRestoresActive: true,
  ...protectedStore,
  ...faults,
  source: result,
  physicalDevices: false,
};
await fs.writeFile(
  new URL("handoff-web-receipt.json", local),
  JSON.stringify(receipt, null, 2),
);
console.log(receipt);
console.log(await page.snapshot());
// The caller finishes the shared task space after any remaining browser checks.
