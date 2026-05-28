/**
 * electron-builder afterPack hook — rewrite HiChat.exe VERSIONINFO on Windows.
 *
 * Why this file exists:
 * `signAndEditExecutable: true` is the documented way to get rcedit to
 * stamp the exe's ProductName/FileDescription/etc., but it bundles the
 * winCodeSign download which contains macOS dylib symlinks. Extracting
 * that archive on Windows without admin / developer-mode access fails
 * with "Cannot create symbolic link : The required privilege is not
 * held by the client", aborting the whole build.
 *
 * Workaround: keep signAndEditExecutable:false (skips the winCodeSign
 * fetch + signtool step on the electron exe — the NSIS installer still
 * gets signed via its own path), and call rcedit ourselves here. rcedit
 * is a pure exe-resource editor — no symlinks, no admin needed.
 *
 * Without this, Windows shows the upstream electron-builder defaults
 * ("Electron" in Task Manager, taskbar grouping, Alt+Tab) instead of
 * "HiChat!".
 */
"use strict";

const path = require("path");

module.exports = async function afterPack(context) {
  if (context.electronPlatformName !== "win32") return;

  // rcedit v5 is published as an ESM module with a named `rcedit` export.
  // electron-builder loads afterPack hooks as CommonJS, so a plain
  // `require("rcedit")` returns an unusable namespace wrapper and throws
  // "rcedit is not a function". Dynamic import resolves the real ESM
  // module and lets us destructure the named export.
  const { rcedit } = await import("rcedit");

  const exeName = context.packager.appInfo.productFilename + ".exe"; // "HiChat.exe"
  const exePath = path.join(context.appOutDir, exeName);

  const productName = context.packager.appInfo.productName; // "HiChat!"
  const version = context.packager.appInfo.version;          // package.json version
  const buildVersion = context.packager.appInfo.buildVersion || version;
  const copyright = context.packager.appInfo.copyright || "© 2026 HiChat!";
  // Single canonical source of truth: hlogo.ico (multi-resolution 16/24/32/48/64/128/256)
  // generated from icons/hlogo.png. Keep in sync with package.json `win.icon` and
  // `nsis.installerIcon`. The old hichat-icon.ico was single-frame and looked
  // blurry in the Start Menu / taskbar small-icon sizes.
  const iconPath = path.resolve(context.packager.projectDir, "icons/hlogo.ico");

  await rcedit(exePath, {
    "version-string": {
      CompanyName: productName,
      ProductName: productName,
      FileDescription: productName,
      LegalCopyright: copyright,
      OriginalFilename: exeName,
      InternalName: productName,
    },
    "file-version": buildVersion,
    "product-version": version,
    icon: iconPath,
  });

  // eslint-disable-next-line no-console
  console.log(`  • rcedit         exe=${exeName} productName=${productName} version=${version}`);
};
