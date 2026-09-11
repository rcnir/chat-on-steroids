import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { releaseFor, sha256 } from './main-adapter.mjs';

const SOURCE_PATH = 'native/macos-desktop-helper/main.swift';

function fail(reason) {
  throw new Error(`TASK_BOX_MACOS_DESKTOP_ADAPTER_${reason}`);
}

function count(source, needle) {
  let total = 0;
  let offset = 0;
  while ((offset = source.indexOf(needle, offset)) !== -1) {
    total += 1;
    offset += needle.length;
  }
  return total;
}

function replaceExact(source, before, after, expected, reason) {
  if (count(source, before) !== expected) fail(reason);
  return source.split(before).join(after);
}

function replaceFunction(source, signature, replacement, reason) {
  if (count(source, signature) !== 1) fail(reason);
  const start = source.indexOf(signature);
  const brace = source.indexOf('{', start);
  if (brace === -1) fail(reason);
  let depth = 0;
  for (let at = brace; at < source.length; at += 1) {
    if (source[at] === '{') depth += 1;
    else if (source[at] === '}') {
      depth -= 1;
      if (depth === 0) return `${source.slice(0, start)}${replacement}${source.slice(at + 1)}`;
    }
  }
  fail(reason);
}

const TARGET_PROOF = `private func windowTargetMatches(_ row: WindowRow) -> Bool {
    guard frontmostPID() == row.pid else { return false }
    let rows = allWindowRows(includeMinimized: false)
    guard windowServerFrontWindowID(rows: rows) == row.id else { return false }
    guard focusedAXWindowID(for: row.pid, rows: rows) == row.id else { return false }
    return true
}

private func inputTargetMatches(_ row: WindowRow) -> Bool {
    guard windowTargetMatches(row) else { return false }
    let rows = allWindowRows(includeMinimized: false)
    // Keyboard/text input retains the stronger focused-control proof. Pointer input is
    // different: coordinates plus three independent window authorities already name the
    // destination, and some valid windows expose no focused AX control at all.
    guard focusedAXElementWindowID(for: row.pid, rows: rows) == row.id else { return false }
    return true
}

private func assertPointerTarget(_ id: CGWindowID) throws -> WindowRow {
    guard let row = windowRow(id), row.onScreen else {
        throw fail("INPUT_TARGET_LOST", "target window \\(id) no longer exists on screen; no pointer input was sent")
    }
    guard windowTargetMatches(row) else {
        throw fail("INPUT_TARGET_LOST", "window \\(id) is no longer the exact active pointer target; no pointer input was sent")
    }
    return row
}`;

/**
 * Adapt only the v2.0.9 macOS pointer-target proof.
 *
 * Keyboard and text input keep the original four-part proof. Pointer input may use the
 * three window-level authorities because a focused child control is neither necessary nor
 * universally exposed for mouse delivery. The complete official source hash is pinned first.
 */
export function adaptMacOSDesktopSource(source, version) {
  const release = releaseFor(version);
  if (version !== '2.0.9') return { source, adapted: false };
  if (typeof release.desktopSourceSha256 !== 'string' || sha256(source) !== release.desktopSourceSha256) {
    fail('OFFICIAL_SOURCE_HASH_MISMATCH');
  }
  let output = replaceFunction(source, 'private func inputTargetMatches(_ row: WindowRow) -> Bool {', TARGET_PROOF, 'TARGET_PROOF_DRIFT');
  output = replaceExact(output,
    'if let targetWindow { _ = try assertInputTarget(targetWindow) }',
    'if let targetWindow { _ = try assertPointerTarget(targetWindow) }', 5, 'POINTER_GUARD_DRIFT');
  output = replaceExact(output,
    '_ = try assertInputTarget(windowID)\n        return windowID',
    '_ = try assertPointerTarget(windowID)\n        return windowID', 1, 'FRAME_POINTER_GUARD_DRIFT');
  output = replaceExact(output,
    'if inputTargetMatches(row) { return true }',
    'if windowTargetMatches(row) { return true }', 2, 'FOCUS_WINDOW_PROOF_DRIFT');
  return { source: output, adapted: true, sourceSha256: release.desktopSourceSha256, patchedSourceSha256: sha256(output) };
}

export function officialMacOSDesktopSource(repoRoot, version) {
  const release = releaseFor(version);
  if (typeof release.tagCommit !== 'string') fail('MISSING_TAG_COMMIT');
  return execFileSync('git', ['show', `${release.tagCommit}:${SOURCE_PATH}`], {
    cwd: repoRoot,
    encoding: 'utf8',
    maxBuffer: 3 * 1024 * 1024
  });
}

export function buildPatchedMacOSDesktopLibrary({ repoRoot, version, outputDir, arch }) {
  if (version !== '2.0.9') return null;
  if (process.platform !== 'darwin' || arch !== 'arm64') fail('UNSUPPORTED_BUILD_HOST');
  const source = officialMacOSDesktopSource(repoRoot, version);
  const adapted = adaptMacOSDesktopSource(source, version);
  mkdirSync(outputDir, { recursive: true });
  const sourceFile = path.join(outputDir, 'macos-desktop-helper.swift');
  const library = path.join(outputDir, 'libcos-desktop.dylib');
  writeFileSync(sourceFile, adapted.source);
  const swiftc = execFileSync('xcrun', ['--find', 'swiftc'], { encoding: 'utf8' }).trim();
  const sdk = execFileSync('xcrun', ['--sdk', 'macosx', '--show-sdk-path'], { encoding: 'utf8' }).trim();
  execFileSync(swiftc, [
    '-O', '-swift-version', '5', '-parse-as-library', '-D', 'COS_DESKTOP_ADDON', '-emit-library',
    '-sdk', sdk, '-target', 'arm64-apple-macos12.3', sourceFile, '-o', library,
    '-framework', 'AppKit', '-framework', 'ApplicationServices', '-framework', 'Carbon',
    '-framework', 'ScreenCaptureKit', '-framework', 'CoreMedia', '-framework', 'CoreImage',
    '-framework', 'ImageIO', '-framework', 'UniformTypeIdentifiers'
  ], { cwd: repoRoot, stdio: 'pipe' });
  const builtArch = execFileSync('/usr/bin/lipo', ['-archs', library], { encoding: 'utf8' }).trim();
  if (builtArch !== arch) fail('BUILT_ARCH_MISMATCH');
  return { ...adapted, library, librarySha256: sha256(readFileSync(library)) };
}
