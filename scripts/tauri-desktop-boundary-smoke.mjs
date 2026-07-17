import { readFile } from 'node:fs/promises'
import { join } from 'node:path'

const root = process.cwd()

async function readText(relativePath) {
  return readFile(join(root, relativePath), 'utf8')
}

function assert(condition, message) {
  if (!condition) {
    throw new Error(message)
  }
}

function assertNotIncludes(text, needle, label) {
  assert(!text.includes(needle), `${label} must not include ${needle}`)
}

function assertBmp(buffer, width, height, label) {
  assert(buffer[0] === 0x42 && buffer[1] === 0x4d, `${label} must be a BMP file`)
  assert(buffer.readInt32LE(18) === width, `${label} must be ${width}px wide`)
  assert(Math.abs(buffer.readInt32LE(22)) === height, `${label} must be ${height}px high`)
}

const [packageJsonText, tauriConfigText, cargoToml, libRs, adapterTs, mockDataTs, headerBmp, sidebarBmp] = await Promise.all([
  readText('package.json'),
  readText('src-tauri/tauri.conf.json'),
  readText('src-tauri/Cargo.toml'),
  readText('src-tauri/src/lib.rs'),
  readText('src/adapter.ts'),
  readText('src/mockData.ts'),
  readFile(join(root, 'src-tauri/installer/header.bmp')),
  readFile(join(root, 'src-tauri/installer/sidebar.bmp')),
])

const tauriConfig = JSON.parse(tauriConfigText)
const packageJson = JSON.parse(packageJsonText)

assert(tauriConfig.productName === 'CodeX Provider Switcher', 'Tauri productName must stay stable')
assert(tauriConfig.mainBinaryName === 'codex-provider-switcher', 'Tauri must bundle the desktop binary, not local_backend')
assert(packageJson.scripts['tauri:dev'].includes('tauri dev'), 'tauri:dev must invoke the Tauri desktop runner')
assert(packageJson.scripts['tauri:build'].includes('release:assets'), 'tauri:build must refresh branded installer assets')
assert(packageJson.scripts['tauri:build'].includes('tauri build'), 'tauri:build must invoke the Tauri desktop bundler')
assert(!packageJson.scripts['tauri:dev'].includes('--bin local_backend'), 'tauri:dev must not select local_backend')
assert(!packageJson.scripts['tauri:build'].includes('--bin local_backend'), 'tauri:build must not select local_backend')
assert(cargoToml.includes('default-run = "codex-provider-switcher"'), 'Cargo must default to the desktop binary when multiple bins exist')
assertNotIncludes(libRs, 'CodeX-Switcher.exe', 'src-tauri/src/lib.rs')
assertNotIncludes(libRs, 'CODEX_PROVIDER_SWITCHER_LEGACY_PROFILES', 'src-tauri/src/lib.rs')
assert(tauriConfig.bundle?.windows?.nsis?.languages?.includes('SimpChinese'), 'NSIS installer must include Simplified Chinese')
assert(tauriConfig.bundle?.windows?.nsis?.displayLanguageSelector === false, 'NSIS installer language selector must stay deterministic')
assert(tauriConfig.bundle?.windows?.nsis?.headerImage === 'installer/header.bmp', 'NSIS installer header image must stay branded')
assert(tauriConfig.bundle?.windows?.nsis?.sidebarImage === 'installer/sidebar.bmp', 'NSIS installer sidebar image must stay branded')
assertBmp(headerBmp, 150, 57, 'NSIS installer header image')
assertBmp(sidebarBmp, 164, 314, 'NSIS installer sidebar image')
assert(Array.isArray(tauriConfig.app?.windows) && tauriConfig.app.windows.length === 1, 'Tauri must expose one main window')
assert(tauriConfig.app.windows[0].title === 'CodeX Provider Switcher', 'Tauri window title must stay stable')
assert(tauriConfig.app.windows[0].minWidth >= 980, 'Tauri minimum width must preserve the desktop layout floor')
assert(tauriConfig.app.windows[0].minHeight >= 700, 'Tauri minimum height must preserve the desktop layout floor')
assert(!('trayIcon' in tauriConfig.app), 'Tauri config must not define a default tray icon')

assertNotIncludes(cargoToml, 'tauri-plugin-autostart', 'src-tauri/Cargo.toml')
assertNotIncludes(cargoToml, 'tray-icon', 'src-tauri/Cargo.toml')
assertNotIncludes(libRs, 'tauri_plugin_autostart', 'src-tauri/src/lib.rs')
assertNotIncludes(libRs, 'TrayIconBuilder', 'src-tauri/src/lib.rs')
assertNotIncludes(libRs, 'install_tray', 'src-tauri/src/lib.rs')

assert(libRs.includes('runtime_mode: "tauri_native".to_string()'), 'Tauri app state must report tauri_native')
assert(libRs.includes('tray_enabled: false'), 'Tauri app state must report trayEnabled=false')
assert(adapterTs.includes("if (isTauri) {\n    return invoke<AppState>('load_state')"), 'Tauri frontend must use invoke(load_state)')
assert(adapterTs.includes('function isTrustedProjectReleaseUrl(value: string)'), 'Updater fallback URLs must use a dedicated trust check')
assert(adapterTs.includes("parsed.pathname === '/ga626/codex-provider-switcher/releases'"), 'Updater trust check must allow the canonical project Release page')
assert(adapterTs.indexOf('if (isTauri && pendingTauriUpdate)') < adapterTs.indexOf('if (!isTrustedProjectReleaseUrl(url))'), 'Signed Tauri updates must not be blocked by the fallback URL guard')
assert(mockDataTs.includes('trayEnabled: false'), 'Browser preview mock must not imply a default tray')

console.log('[PASS] Tauri desktop boundary smoke passed.')
