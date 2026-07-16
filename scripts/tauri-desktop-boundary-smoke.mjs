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

const [packageJsonText, tauriConfigText, cargoToml, libRs, adapterTs, mockDataTs] = await Promise.all([
  readText('package.json'),
  readText('src-tauri/tauri.conf.json'),
  readText('src-tauri/Cargo.toml'),
  readText('src-tauri/src/lib.rs'),
  readText('src/adapter.ts'),
  readText('src/mockData.ts'),
])

const tauriConfig = JSON.parse(tauriConfigText)
const packageJson = JSON.parse(packageJsonText)

assert(tauriConfig.productName === 'CodeX Provider Switcher', 'Tauri productName must stay stable')
assert(tauriConfig.mainBinaryName === 'codex-provider-switcher', 'Tauri must bundle the desktop binary, not local_backend')
assert(packageJson.scripts['tauri:dev'].includes('tauri dev'), 'tauri:dev must invoke the Tauri desktop runner')
assert(packageJson.scripts['tauri:build'].includes('tauri build'), 'tauri:build must invoke the Tauri desktop bundler')
assert(!packageJson.scripts['tauri:dev'].includes('--bin local_backend'), 'tauri:dev must not select local_backend')
assert(!packageJson.scripts['tauri:build'].includes('--bin local_backend'), 'tauri:build must not select local_backend')
assert(cargoToml.includes('default-run = "codex-provider-switcher"'), 'Cargo must default to the desktop binary when multiple bins exist')
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
assert(mockDataTs.includes('trayEnabled: false'), 'Browser preview mock must not imply a default tray')

console.log('[PASS] Tauri desktop boundary smoke passed.')
