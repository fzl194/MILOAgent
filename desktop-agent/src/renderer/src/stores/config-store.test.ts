import { describe, it, expect } from 'vitest'
import { mergeConfig } from './config-store'

// mergeConfig is the persisted-config normalizer + migration point. These lock
// the P1 identity-default flip + configVersion migration (a legacy P0 disk was
// self-healed with identity OFF; P1 must migrate it to ON once, while honoring a
// versioned disk's explicit value).
describe('mergeConfig — P1 identity default flip + configVersion migration', () => {
  it('null/missing config → DEFAULT (identity ON, configVersion 2)', () => {
    const m = mergeConfig(null)
    expect(m.identity?.enabled).toBe(true)
    expect(m.configVersion).toBe(2)
    expect(m.sandbox).toBe('workspace-write')
  })

  it('legacy P0 disk {identity:{enabled:false}} (no configVersion) → migrated to ON', () => {
    // This is the key migration: P0 self-healed this exact shape onto every disk.
    const m = mergeConfig({ identity: { enabled: false } })
    expect(m.identity?.enabled).toBe(true)
    expect(m.configVersion).toBe(2)
  })

  it('versioned disk {configVersion:2, identity:{enabled:false}} → respects OFF', () => {
    // A user who explicitly disabled identity (after P1) stays disabled on reload.
    const m = mergeConfig({ configVersion: 2, identity: { enabled: false } })
    expect(m.identity?.enabled).toBe(false)
    expect(m.configVersion).toBe(2)
  })

  it('versioned disk without identity key → default ON', () => {
    const m = mergeConfig({ configVersion: 2 })
    expect(m.identity?.enabled).toBe(true)
  })

  it('always outputs the current configVersion, even on a legacy disk', () => {
    expect(mergeConfig({ systemPrompt: 'x' }).configVersion).toBe(2)
    expect(mergeConfig({ configVersion: 1, identity: { enabled: true } }).configVersion).toBe(2)
  })

  it('validates sandbox/approvalPolicy enums (corruption safety)', () => {
    const m = mergeConfig({ sandbox: 'bogus', approvalPolicy: 'nope', configVersion: 2 })
    expect(m.sandbox).toBe('workspace-write')
    expect(m.approvalPolicy).toBe('on-request')
  })
})
