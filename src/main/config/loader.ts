import { readFileSync, existsSync } from 'fs'
import { parse } from 'yaml'
import { AppConfig, resolveConfig } from '../../shared/config'

/** Load a YAML config file, returning undefined if missing. */
export function loadConfigFile(path: string): unknown {
  if (!existsSync(path)) return undefined
  const text = readFileSync(path, 'utf8')
  return parse(text)
}

/**
 * Build the effective config: built-in defaults <- bundled default.yaml <-
 * user override file <- explicit per-job overrides.
 */
export function buildConfig(options: {
  defaultConfigPath?: string
  userConfigPath?: string
  overrides?: Array<unknown>
}): AppConfig {
  const layers: Array<unknown> = []
  if (options.defaultConfigPath) layers.push(loadConfigFile(options.defaultConfigPath))
  if (options.userConfigPath) layers.push(loadConfigFile(options.userConfigPath))
  layers.push(...(options.overrides ?? []))
  return resolveConfig(...layers)
}
